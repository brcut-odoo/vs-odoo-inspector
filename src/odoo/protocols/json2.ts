import { hintFor, kindOf, OdooError } from '../errors';
import { Http } from '../http';
import { Credential, Protocol } from '../types';

/**
 * Odoo 18.5+ `/json/2/<model>/<method>`: a Bearer API key, and a body made
 * only of named parameters. Record methods take the recordset as `ids`.
 *
 * `execute_kw` callers pass positional args, so `toJson2Body` names them for
 * the methods the tools use.
 */
export class Json2Protocol implements Protocol {
	readonly name = 'json2' as const;

	constructor(
		private readonly http: Http,
		private readonly db: string,
		private readonly credential: Credential,
	) {
		if (credential.kind !== 'apiKey') {
			throw new OdooError('The json2 protocol only accepts API keys.', 'auth', 'Use jsonrpc or xmlrpc for a password, callKw for a session token.');
		}
	}

	async authenticate(): Promise<void> {
		// Stateless: the key is checked on every request.
	}

	async executeKw(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const { status, body } = await this.http.postJson(
			`/json/2/${model}/${method}`,
			toJson2Body(method, args, kwargs),
			{ Authorization: `bearer ${this.credential.secret}`, 'X-Odoo-Database': this.db },
			signal,
		);
		if (status >= 400) {
			const error = (body ?? {}) as { name?: string; message?: string };
			const kind = status === 401 ? 'auth' : kindOf(error.name);
			throw new OdooError(error.message || `json2 returned HTTP ${status}.`, kind, hintFor(kind, error.name), error.name);
		}
		return body;
	}
}

/** Positional parameter names for the methods the tools call. */
const POSITIONAL: Record<string, string[]> = {
	search: ['domain'],
	search_read: ['domain', 'fields'],
	search_count: ['domain'],
	read_group: ['domain', 'fields', 'groupby'],
	formatted_read_group: ['domain', 'groupby', 'aggregates'],
	fields_get: ['allfields', 'attributes'],
	name_search: ['name'],
	create: ['vals_list'],
};

/** Methods whose first positional argument is the recordset. */
const RECORD_METHODS: Record<string, string[]> = {
	read: ['fields'],
	write: ['vals'],
	unlink: [],
};

export function toJson2Body(method: string, args: unknown[], kwargs: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	let rest = args;
	let names = POSITIONAL[method];

	if (method in RECORD_METHODS || (!names && isIdList(args[0]))) {
		body.ids = args[0];
		rest = args.slice(1);
		names = RECORD_METHODS[method] ?? [];
	}
	if (rest.length > (names?.length ?? 0)) {
		throw new OdooError(
			`json2 needs named arguments for ${method}; got ${rest.length} positional argument(s).`,
			'validation',
			'Pass the arguments in kwargs, or use the jsonrpc/callKw protocol for this call.',
		);
	}
	rest.forEach((value, index) => (body[names![index]] = value));
	return { ...body, ...kwargs };
}

function isIdList(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => Number.isInteger(item));
}
