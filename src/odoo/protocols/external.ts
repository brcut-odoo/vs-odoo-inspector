import { fromJsonRpcError, OdooError } from '../errors';
import { Http } from '../http';
import { Credential, Protocol, ProtocolName } from '../types';
import { decodeMethodResponse, encodeMethodCall } from './xmlrpcCodec';

/**
 * The "external API": `common.authenticate` → uid, then
 * `object.execute_kw(db, uid, secret, model, method, args, kwargs)`.
 *
 * `/jsonrpc` and `/xmlrpc/2` share these semantics and differ only in the
 * envelope, so one class handles both. Accepts a password or an API key;
 * there is no way to use a session cookie here.
 */
export class ExternalApiProtocol implements Protocol {
	private uid?: number;

	constructor(
		readonly name: Extract<ProtocolName, 'jsonrpc' | 'xmlrpc'>,
		private readonly http: Http,
		private readonly db: string,
		private readonly login: string,
		private readonly credential: Credential,
	) {
		if (credential.kind === 'session') {
			throw new OdooError(
				`The ${name} protocol cannot use a session token.`,
				'auth',
				'Use the callKw protocol for session tokens, or switch to a password or API key.',
			);
		}
	}

	async authenticate(signal?: AbortSignal): Promise<void> {
		if (this.uid !== undefined) {
			return;
		}
		const uid = await this.service('common', 'authenticate', [this.db, this.login, this.credential.secret, {}], signal);
		if (typeof uid !== 'number' || uid <= 0) {
			throw new OdooError(
				`Odoo rejected the ${this.credential.kind === 'apiKey' ? 'API key' : 'password'} for "${this.login}" on database "${this.db}".`,
				'auth',
				'Check the login, database name and credential. Users with two-factor authentication need an API key.',
			);
		}
		this.uid = uid;
	}

	async executeKw(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		await this.authenticate(signal);
		return this.service('object', 'execute_kw', [this.db, this.uid, this.credential.secret, model, method, args, kwargs], signal);
	}

	private async service(service: string, method: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
		if (this.name === 'xmlrpc') {
			const response = await this.http.post(`/xmlrpc/2/${service}`, encodeMethodCall(method, args), { 'Content-Type': 'text/xml' }, signal);
			if (response.status === 404) {
				throw new OdooError('/xmlrpc/2 is not available on this server.', 'protocol', 'Choose the json2 or callKw protocol.');
			}
			return decodeMethodResponse(response.text);
		}
		const { status, body } = await this.http.postJson(
			'/jsonrpc',
			{ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() },
			{},
			signal,
		);
		const envelope = body as { result?: unknown; error?: unknown } | null;
		if (envelope?.error) {
			throw fromJsonRpcError(envelope.error);
		}
		if (status >= 400 || !envelope || !('result' in envelope)) {
			throw new OdooError(`/jsonrpc returned HTTP ${status}.`, status === 404 ? 'protocol' : 'server');
		}
		return envelope.result;
	}
}
