import { fromJsonRpcError, OdooError } from '../errors';
import { Http, sessionCookie } from '../http';
import { Credential, Protocol } from '../types';

/**
 * The web client's RPC: `/web/dataset/call_kw` with a `session_id` cookie.
 *
 * This is the only protocol that takes a session token directly. A password
 * is exchanged for a session through `/web/session/authenticate`; API keys
 * are refused there, so they cannot be used with this protocol.
 */
export class CallKwProtocol implements Protocol {
	readonly name = 'callKw' as const;
	private session?: string;

	constructor(
		private readonly http: Http,
		private readonly db: string,
		private readonly login: string,
		private readonly credential: Credential,
	) {
		if (credential.kind === 'apiKey') {
			throw new OdooError('The callKw protocol cannot use an API key.', 'auth', 'Odoo only accepts API keys over jsonrpc, xmlrpc and json2.');
		}
		if (credential.kind === 'session') {
			this.session = credential.secret;
		}
	}

	async authenticate(signal?: AbortSignal): Promise<void> {
		if (this.session) {
			return;
		}
		const { body, headers } = await this.http.postJson(
			'/web/session/authenticate',
			{ jsonrpc: '2.0', method: 'call', params: { db: this.db, login: this.login, password: this.credential.secret }, id: Date.now() },
			{},
			signal,
		);
		const envelope = body as { result?: { uid?: number | null }; error?: unknown } | null;
		if (envelope?.error) {
			throw fromJsonRpcError(envelope.error);
		}
		const session = sessionCookie(headers);
		// A TOTP user gets a half-open session with `uid: null`.
		if (!envelope?.result?.uid || !session) {
			throw new OdooError(
				`Odoo did not open a session for "${this.login}" on "${this.db}".`,
				'auth',
				'Check the credential. Users with two-factor authentication need an API key or a session token.',
			);
		}
		this.session = session;
	}

	async executeKw(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		await this.authenticate(signal);
		const { status, body } = await this.http.postJson(
			`/web/dataset/call_kw/${model}/${method}`,
			{ jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs }, id: Date.now() },
			{ Cookie: `session_id=${this.session}` },
			signal,
		);
		const envelope = body as { result?: unknown; error?: unknown } | null;
		if (envelope?.error) {
			const error = fromJsonRpcError(envelope.error);
			// Exchanged sessions can be re-opened; a pasted token cannot.
			if (error.kind === 'auth' && this.credential.kind !== 'session') {
				this.session = undefined;
			}
			throw error;
		}
		if (status >= 400 || !envelope || !('result' in envelope)) {
			throw new OdooError(`call_kw returned HTTP ${status}.`, 'server');
		}
		return envelope.result;
	}
}
