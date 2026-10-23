import { OdooError } from './errors';
import { Http, RateLimiter } from './http';
import { CallKwProtocol } from './protocols/callKw';
import { ExternalApiProtocol } from './protocols/external';
import { Json2Protocol } from './protocols/json2';
import { detectAuthKind, parseVersionInfo, selectProtocol } from './select';
import { ConnectionConfig, Credential, FieldsGetResult, OdooRecord, Protocol, ProtocolName, ServerVersion } from './types';

export interface OdooClientOptions {
	connection: ConnectionConfig;
	secret: string;
	rateLimitPerSecond?: number;
	fetch?: typeof fetch;
}

/**
 * One authenticated connection. `connect()` probes the version, picks the
 * protocol and authenticates; everything else goes through `executeKw`.
 */
export class OdooClient {
	private protocol?: Protocol;
	private readonly http: Http;
	private readonly fieldsCache = new Map<string, Promise<FieldsGetResult>>();
	readonly credential: Credential;
	version: ServerVersion = {};

	constructor(private readonly options: OdooClientOptions) {
		const { connection, secret } = options;
		const kind = connection.authMethod && connection.authMethod !== 'auto' ? connection.authMethod : detectAuthKind(secret);
		this.credential = { kind, secret };
		this.http = new Http({
			baseUrl: connection.url,
			limiter: new RateLimiter(options.rateLimitPerSecond ?? 1),
			fetch: options.fetch,
		});
	}

	get connection(): ConnectionConfig {
		return this.options.connection;
	}

	get protocolName(): ProtocolName | undefined {
		return this.protocol?.name;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.protocol) {
			return;
		}
		const { connection } = this.options;
		// The version only matters when choosing or validating json2.
		const needsVersion = connection.protocol === 'json2' || ((connection.protocol ?? 'auto') === 'auto' && this.credential.kind === 'apiKey');
		if (needsVersion) {
			this.version = await this.probeVersion(signal);
		}
		const name = selectProtocol(this.credential.kind, this.version, connection.protocol);
		const protocol = this.create(name);
		await protocol.authenticate(signal);
		this.protocol = protocol;
	}

	private create(name: ProtocolName): Protocol {
		const { db, login } = this.options.connection;
		switch (name) {
			case 'jsonrpc':
			case 'xmlrpc':
				return new ExternalApiProtocol(name, this.http, db, login, this.credential);
			case 'callKw':
				return new CallKwProtocol(this.http, db, login, this.credential);
			case 'json2':
				return new Json2Protocol(this.http, db, this.credential);
		}
	}

	/** `/web/webclient/version_info`, falling back to the external `common.version`. */
	private async probeVersion(signal?: AbortSignal): Promise<ServerVersion> {
		type Info = { server_version?: string; server_version_info?: unknown };
		try {
			const { body } = await this.http.postJson('/web/webclient/version_info', { jsonrpc: '2.0', method: 'call', params: {}, id: 1 }, {}, signal);
			const result = (body as { result?: Info } | null)?.result;
			if (result?.server_version_info) {
				return parseVersionInfo(result.server_version_info, result.server_version);
			}
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
		}
		try {
			const { body } = await this.http.postJson('/jsonrpc', { jsonrpc: '2.0', method: 'call', params: { service: 'common', method: 'version', args: [] }, id: 1 }, {}, signal);
			const result = (body as { result?: Info } | null)?.result;
			return parseVersionInfo(result?.server_version_info, result?.server_version);
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			return {};
		}
	}

	async executeKw(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
		await this.connect(signal);
		return this.protocol!.executeKw(model, method, args, kwargs, signal);
	}

	async searchRead(
		model: string,
		domain: unknown[],
		fields: string[] | undefined,
		options: { limit?: number; offset?: number; order?: string; context?: Record<string, unknown> },
		signal?: AbortSignal,
	): Promise<OdooRecord[]> {
		const kwargs: Record<string, unknown> = { domain };
		if (fields?.length) {
			kwargs.fields = fields;
		}
		for (const key of ['limit', 'offset', 'order', 'context'] as const) {
			if (options[key] !== undefined) {
				kwargs[key] = options[key];
			}
		}
		return asRecords(await this.executeKw(model, 'search_read', [], kwargs, signal));
	}

	async read(model: string, ids: number[], fields: string[] | undefined, signal?: AbortSignal): Promise<OdooRecord[]> {
		return asRecords(await this.executeKw(model, 'read', [ids], fields?.length ? { fields } : {}, signal));
	}

	/** `fields_get`, cached per model for the client's lifetime. */
	fieldsGet(model: string, signal?: AbortSignal): Promise<FieldsGetResult> {
		let cached = this.fieldsCache.get(model);
		if (!cached) {
			cached = this.executeKw(
				model,
				'fields_get',
				[],
				{ attributes: ['type', 'string', 'help', 'required', 'readonly', 'store', 'sortable', 'relation', 'selection'] },
				signal,
			).then((result) => (result ?? {}) as FieldsGetResult);
			cached.catch(() => this.fieldsCache.delete(model));
			this.fieldsCache.set(model, cached);
		}
		return cached;
	}

	async listModels(signal?: AbortSignal): Promise<{ model: string; name: string }[]> {
		const rows = await this.searchRead('ir.model', [], ['model', 'name'], { order: 'model' }, signal);
		return rows.map((row) => ({ model: String(row.model), name: String(row.name) }));
	}
}

function asRecords(result: unknown): OdooRecord[] {
	if (!Array.isArray(result)) {
		throw new OdooError('Expected a list of records from Odoo.', 'protocol');
	}
	return result as OdooRecord[];
}
