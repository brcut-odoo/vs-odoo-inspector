export type OdooErrorKind = 'auth' | 'access' | 'validation' | 'missing' | 'network' | 'server' | 'protocol';

/**
 * Every failure the client raises. `hint` is a next step for the user or the
 * model, shown alongside the message.
 */
export class OdooError extends Error {
	constructor(
		message: string,
		readonly kind: OdooErrorKind,
		readonly hint?: string,
		/** The Odoo exception class, e.g. `odoo.exceptions.AccessError`. */
		readonly odooName?: string,
	) {
		super(message);
		this.name = 'OdooError';
	}

	/** One string for tool results: message plus hint. */
	describe(): string {
		return this.hint ? `${this.message}\n\nHint: ${this.hint}` : this.message;
	}
}

/** Maps an Odoo exception class name to an error kind. */
export function kindOf(odooName: string | undefined): OdooErrorKind {
	if (!odooName) {
		return 'server';
	}
	if (/AccessDenied|SessionExpired/.test(odooName)) {
		return 'auth';
	}
	if (/AccessError/.test(odooName)) {
		return 'access';
	}
	if (/MissingError/.test(odooName)) {
		return 'missing';
	}
	if (/ValidationError|UserError|ValueError|KeyError/.test(odooName)) {
		return 'validation';
	}
	return 'server';
}

/** Builds an `OdooError` from a JSON-RPC `error` object (`/jsonrpc`, `call_kw`). */
export function fromJsonRpcError(error: unknown): OdooError {
	const e = (error ?? {}) as { message?: string; data?: { name?: string; message?: string; debug?: string } };
	const odooName = e.data?.name;
	const message = e.data?.message || e.message || 'Odoo returned an error.';
	return new OdooError(message, kindOf(odooName), hintFor(kindOf(odooName), odooName), odooName);
}

export function hintFor(kind: OdooErrorKind, odooName?: string): string | undefined {
	switch (kind) {
		case 'auth':
			return odooName?.includes('SessionExpired')
				? 'The session expired. Reconnect with a fresh session id, or use an API key.'
				: 'Check the login and credential. Users with two-factor authentication must use an API key instead of a password.';
		case 'access':
			return 'The Odoo user lacks access rights for this model or record.';
		case 'missing':
			return 'The record does not exist or was deleted.';
		case 'validation':
			return 'Check the model, field names and domain with odoo_get_fields.';
		default:
			return undefined;
	}
}
