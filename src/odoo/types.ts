/**
 * Core types shared by the Odoo client, the query layer and the UI.
 */

/**
 * Which HTTP API the target Odoo server speaks.
 *
 * - `json2`   : `POST /json/2/<model>/<method>` with a Bearer API key.
 *               Available from Odoo 18.5 onwards.
 * - `callKw`  : `POST /web/dataset/call_kw` with a `session_id` cookie.
 *               The classic web-client endpoint, works on every version.
 */
export type ApiMode = 'json2' | 'callKw';

/** How the user authenticates against a given connection. */
export type AuthMode = 'apiKey' | 'session';

export interface ConnectionConfig {
	/** Stable identifier, also used as the SecretStorage key. */
	name: string;
	/** Base URL, e.g. `https://mycompany.odoo.com` or `http://localhost:8069`. */
	url: string;
	/** Technical database name. */
	db: string;
	/** Login of the user the credentials belong to. */
	login: string;
	/**
	 * Preferred auth mode. `auto` picks based on the detected server version.
	 */
	authMode?: AuthMode | 'auto';
}

/** A resolved connection, ready to be used by the client. */
export interface ResolvedConnection extends ConnectionConfig {
	apiMode: ApiMode;
	authMode: AuthMode;
	/** Server version as reported by the instance, e.g. `19.0+e`. */
	serverVersion?: string;
	/** Parsed `[major, minor, patch, ...]`. */
	versionInfo?: (number | string)[];
}

/**
 * A model request, in a backend-agnostic shape.
 *
 * This mirrors the logical operations of `support-tools/lib/rpc/odoo_rpc.py`:
 * the same `QuerySpec` is translated into different `args`/`kwargs` depending
 * on the active `ApiMode`.
 */
export interface QuerySpec {
	model: string;
	method: QueryMethod;
	domain?: unknown[];
	fields?: string[];
	limit?: number;
	offset?: number;
	order?: string;
	context?: Record<string, unknown>;
	/** For `read` / `write` / `unlink`. */
	ids?: number[];
	/** For `create` / `write`. */
	values?: Record<string, unknown> | Record<string, unknown>[];
	/** For `name_search`. */
	name?: string;
	/** For `call` — the raw method name. */
	rawMethod?: string;
	/** For `call` — positional arguments. */
	args?: unknown[];
	/** For `call` — keyword arguments. */
	kwargs?: Record<string, unknown>;
}

export type QueryMethod =
	| 'search_read'
	| 'search'
	| 'search_count'
	| 'read'
	| 'fields_get'
	| 'name_search'
	| 'create'
	| 'write'
	| 'unlink'
	| 'call';

/** Field metadata as returned by `fields_get`. */
export interface FieldInfo {
	type: string;
	string?: string;
	required?: boolean;
	readonly?: boolean;
	store?: boolean;
	searchable?: boolean;
	sortable?: boolean;
	relation?: string;
	selection?: [string, string][];
	help?: string;
	depends?: string[];
	group?: string;
}

export type FieldsGetResult = Record<string, FieldInfo>;

/** A single record returned by Odoo. */
export type OdooRecord = Record<string, unknown>;

/** Normalized error, so callers never have to parse Odoo's error envelope. */
export class OdooError extends Error {
	constructor(
		message: string,
		readonly kind: OdooErrorKind,
		readonly status?: number,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'OdooError';
	}

	/** A short, actionable hint for the user or the LLM. */
	get hint(): string {
		switch (this.kind) {
			case 'auth':
				return 'Check the login and API key / session id for this connection.';
			case 'notFound':
				return 'The model or method does not exist on this database.';
			case 'access':
				return 'The authenticated user lacks access rights for this operation.';
			case 'validation':
				return 'The request was rejected by Odoo. Check the domain, fields and values.';
			case 'network':
				return 'Check that the Odoo URL is reachable and the server is running.';
			case 'version':
				return 'The server version could not be determined; set the API mode explicitly.';
			default:
				return 'See the Odoo server log for the full traceback.';
		}
	}
}

export type OdooErrorKind =
	| 'auth'
	| 'notFound'
	| 'access'
	| 'validation'
	| 'network'
	| 'version'
	| 'server'
	| 'unknown';
