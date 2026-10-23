import {
	ApiMode,
	AuthMode,
	ConnectionConfig,
	FieldInfo,
	FieldsGetResult,
	OdooError,
	OdooRecord,
	QuerySpec,
	ResolvedConnection,
} from './types';
import { Transport, extractErrorMessage } from './transport';
import { RateLimiter } from './rateLimiter';
import { probeVersion } from './version';
import { RpcBackend } from './backends/backend';
import { CallKwBackend } from './backends/callKw';
import { Json2Backend } from './backends/json2';

export interface OdooClientOptions {
	connection: ConnectionConfig;
	/** API key (json2) or session id (callKw). */
	credential: string;
	/** Requests per second. Defaults to 1, matching support-tools. */
	rateLimitPerSecond?: number;
	/** Force an API mode instead of probing. */
	forceApiMode?: ApiMode;
}

/**
 * Facade over the two RPC backends, mirroring `OdooXR` from
 * `support-tools/lib/odoorpc.py`.
 *
 * Construction is cheap; call `connect()` to probe the version and pick a
 * backend. All high-level helpers delegate to `call()`.
 */
export class OdooClient {
	private backend?: RpcBackend;
	private resolved?: ResolvedConnection;
	private fieldsCache = new Map<string, FieldsGetResult>();

	constructor(private readonly options: OdooClientOptions) {}

	get connection(): ResolvedConnection | undefined {
		return this.resolved;
	}

	get apiMode(): ApiMode | undefined {
		return this.resolved?.apiMode;
	}

	/** Probes the server version and selects the backend. */
	async connect(): Promise<ResolvedConnection> {
		const { connection, credential, forceApiMode } = this.options;
		const authMode = resolveAuthMode(connection, credential);

		const transport = new Transport({
			baseUrl: connection.url,
			headers: buildHeaders(connection, authMode, credential),
			cookie: authMode === 'session' ? `session_id=${credential}` : undefined,
			rateLimiter: new RateLimiter(this.options.rateLimitPerSecond ?? 1),
		});

		let apiMode = forceApiMode;
		let serverVersion: string | undefined;
		let versionInfo: (number | string)[] | undefined;

		if (!apiMode) {
			const probe = await probeVersion(transport);
			apiMode = probe.apiMode;
			serverVersion = probe.serverVersion;
			versionInfo = probe.versionInfo;
		}

		// `/json/2` only accepts Bearer API keys, and `call_kw` only accepts a
		// session cookie. The auth mode therefore constrains the API mode.
		if (authMode === 'session') {
			apiMode = 'callKw';
		} else if (apiMode === 'callKw') {
			// An API key on a pre-18.5 server: exchange it for a session cookie.
			const sessionId = await authenticateWithApiKey(transport, connection, credential);
			transport.setCookie(`session_id=${sessionId}`);
		}

		this.backend =
			apiMode === 'json2' ? new Json2Backend(transport) : new CallKwBackend(transport);
		this.resolved = {
			...connection,
			apiMode,
			authMode,
			serverVersion,
			versionInfo,
		};
		return this.resolved;
	}

	/** Generic call, the single entry point for every operation. */
	async call(spec: QuerySpec, signal?: AbortSignal): Promise<unknown> {
		const backend = this.requireBackend();
		return backend.call(spec, signal);
	}

	async searchRead(
		model: string,
		domain: unknown[] = [],
		fields?: string[],
		options: { limit?: number; offset?: number; order?: string; context?: Record<string, unknown> } = {},
		signal?: AbortSignal,
	): Promise<OdooRecord[]> {
		const result = await this.call(
			{
				model,
				method: 'search_read',
				domain,
				fields,
				limit: options.limit,
				offset: options.offset,
				order: options.order,
				context: options.context,
			},
			signal,
		);
		return Array.isArray(result) ? (result as OdooRecord[]) : [];
	}

	async read(
		model: string,
		ids: number[],
		fields?: string[],
		signal?: AbortSignal,
	): Promise<OdooRecord[]> {
		const result = await this.call({ model, method: 'read', ids, fields }, signal);
		return Array.isArray(result) ? (result as OdooRecord[]) : [];
	}

	async count(model: string, domain: unknown[] = [], signal?: AbortSignal): Promise<number> {
		const result = await this.call({ model, method: 'search_count', domain }, signal);
		return typeof result === 'number' ? result : 0;
	}

	async search(model: string, domain: unknown[] = [], signal?: AbortSignal): Promise<number[]> {
		const result = await this.call({ model, method: 'search', domain }, signal);
		return Array.isArray(result) ? (result as number[]) : [];
	}

	/** `fields_get`, cached per model for the lifetime of the client. */
	async fieldsGet(model: string, signal?: AbortSignal): Promise<FieldsGetResult> {
		const cached = this.fieldsCache.get(model);
		if (cached) {
			return cached;
		}
		const result = await this.call({ model, method: 'fields_get' }, signal);
		const fields = (result && typeof result === 'object' ? result : {}) as FieldsGetResult;
		this.fieldsCache.set(model, fields);
		return fields;
	}

	/** Field metadata for a single field, or `undefined` when it does not exist. */
	async fieldInfo(model: string, field: string, signal?: AbortSignal): Promise<FieldInfo | undefined> {
		const fields = await this.fieldsGet(model, signal);
		return fields[field];
	}

	async nameSearch(
		model: string,
		name: string,
		options: { domain?: unknown[]; limit?: number } = {},
		signal?: AbortSignal,
	): Promise<[number, string][]> {
		const result = await this.call(
			{ model, method: 'name_search', name, domain: options.domain, limit: options.limit },
			signal,
		);
		return Array.isArray(result) ? (result as [number, string][]) : [];
	}

	/** Lists installed models, for the model picker. */
	async listModels(signal?: AbortSignal): Promise<{ model: string; name: string }[]> {
		const records = await this.searchRead(
			'ir.model',
			[],
			['model', 'name'],
			{ order: 'model', limit: 0 },
			signal,
		);
		return records
			.map((record) => ({
				model: String(record.model ?? ''),
				name: String(record.name ?? ''),
			}))
			.filter((entry) => entry.model);
	}

	/** Drops the cached `fields_get` results, e.g. after a module install. */
	clearCache(): void {
		this.fieldsCache.clear();
	}

	private requireBackend(): RpcBackend {
		if (!this.backend) {
			throw new OdooError('The client is not connected. Call connect() first.', 'validation');
		}
		return this.backend;
	}
}

/**
 * Decides how to authenticate.
 *
 * An explicit `authMode` wins. Otherwise a long, non-password-looking string is
 * treated as an API key, which is the modern default.
 */
export function resolveAuthMode(connection: ConnectionConfig, credential: string): AuthMode {
	if (connection.authMode === 'apiKey' || connection.authMode === 'session') {
		return connection.authMode;
	}
	// Odoo API keys are long random strings; session ids are 40-char hex.
	return credential.length >= 40 ? 'apiKey' : 'session';
}

function buildHeaders(
	connection: ConnectionConfig,
	authMode: AuthMode,
	credential: string,
): Record<string, string> {
	if (authMode === 'apiKey') {
		return {
			Authorization: `Bearer ${credential}`,
			'X-Odoo-Database': connection.db,
		};
	}
	return {};
}

/**
 * Exchanges an API key for a session id on servers that predate `/json/2`.
 *
 * `/web/session/authenticate` accepts an API key in the password field on
 * Odoo 14+, so this works without asking the user for a second credential.
 */
async function authenticateWithApiKey(
	transport: Transport,
	connection: ConnectionConfig,
	apiKey: string,
): Promise<string> {
	const response = await transport.postJson('/web/session/authenticate', {
		jsonrpc: '2.0',
		method: 'call',
		params: { db: connection.db, login: connection.login, password: apiKey },
	});

	const body = response.body as Record<string, unknown> | undefined;
	if (body?.error) {
		throw new OdooError(
			`Could not authenticate with the API key: ${extractErrorMessage(body) ?? 'unknown error'}`,
			'auth',
			undefined,
			body.error,
		);
	}

	const result = body?.result as Record<string, unknown> | undefined;
	const sessionId = result?.session_id;
	if (typeof sessionId !== 'string' || !sessionId) {
		throw new OdooError(
			'The server did not return a session id. Check the database name and login.',
			'auth',
			undefined,
			body,
		);
	}
	return sessionId;
}
