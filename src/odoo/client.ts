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
import { Transport, extractErrorMessage, extractSessionCookie } from './transport';
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
		} else if (authMode === 'password') {
			// A password can never be a Bearer token, so this is always call_kw.
			apiMode = 'callKw';
			const sessionId = await authenticateWithPassword(transport, connection, credential);
			transport.setCookie(`session_id=${sessionId}`);
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
 * An explicit `authMode` wins. `auto` uses the credential's shape:
 *
 *  - 40 hex characters is exactly what `res.users.apikeys._generate` produces
 *    (`API_KEY_SIZE = 20` bytes hexlified), so it is an API key.
 *  - werkzeug session ids are 42 url-safe characters (`STORED_SESSION_BYTES`),
 *    so a credential of that shape is treated as an existing session.
 *  - anything else is a password, which must be exchanged for a session.
 *
 * The password default matters: guessing `session` for a short credential
 * silently produced `Cookie: session_id=<password>`, which Odoo answered with
 * "Session expired".
 */
export function resolveAuthMode(connection: ConnectionConfig, credential: string): AuthMode {
	if (
		connection.authMode === 'apiKey' ||
		connection.authMode === 'session' ||
		connection.authMode === 'password'
	) {
		return connection.authMode;
	}
	const trimmed = credential.trim();
	if (/^[0-9a-f]{40}$/i.test(trimmed)) {
		return 'apiKey';
	}
	if (/^[A-Za-z0-9_-]{42}$/.test(trimmed)) {
		return 'session';
	}
	return 'password';
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
	return authenticateForSession(transport, connection, apiKey, 'API key');
}

/**
 * Exchanges a user password for a session id.
 *
 * Uses the same endpoint as the API-key exchange, but reports failures as
 * password problems. Users with two-factor authentication enabled cannot get
 * an RPC session this way — Odoo returns `uid: null` — which this reports
 * explicitly rather than as a generic auth failure.
 */
async function authenticateWithPassword(
	transport: Transport,
	connection: ConnectionConfig,
	password: string,
): Promise<string> {
	return authenticateForSession(transport, connection, password, 'password');
}

/**
 * Shared implementation of `/web/session/authenticate`.
 *
 * Odoo 17+ no longer includes `session_id` in the response body; it only sets
 * the cookie. So the id is read from `result.session_id` when present and
 * otherwise taken from the `Set-Cookie` header, which the transport records.
 */
async function authenticateForSession(
	transport: Transport,
	connection: ConnectionConfig,
	secret: string,
	label: string,
): Promise<string> {
	const response = await transport.postJson('/web/session/authenticate', {
		jsonrpc: '2.0',
		method: 'call',
		params: { db: connection.db, login: connection.login, password: secret },
	});

	const body = response.body as Record<string, unknown> | undefined;
	if (body?.error) {
		throw new OdooError(
			`Could not authenticate with the ${label}: ${extractErrorMessage(body) ?? 'unknown error'}`,
			'auth',
			undefined,
			body.error,
		);
	}

	const result = body?.result as Record<string, unknown> | undefined;
	const sessionId =
		typeof result?.session_id === 'string' ? result.session_id : extractSessionCookie(response.headers);

	if (!sessionId) {
		if (result && result.uid === null) {
			throw new OdooError(
				`The server refused to open a session with the ${label}. ` +
					'This usually means two-factor authentication is enabled for this user; ' +
					'use an API key for this connection instead.',
				'auth',
				undefined,
				body,
			);
		}
		throw new OdooError(
			`The server did not return a session id after authenticating with the ${label}. ` +
				'Check the database name and login.',
			'auth',
			undefined,
			body,
		);
	}
	return sessionId;
}
