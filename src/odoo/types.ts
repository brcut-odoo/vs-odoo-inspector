export type AuthKind = 'password' | 'apiKey' | 'session';
export type ProtocolName = 'jsonrpc' | 'xmlrpc' | 'callKw' | 'json2';

/** A connection as stored in settings. Secrets live in SecretStorage. */
export interface ConnectionConfig {
	name: string;
	/** Base URL, e.g. `https://mycompany.odoo.com`. */
	url: string;
	db: string;
	login: string;
	authMethod?: AuthKind | 'auto';
	protocol?: ProtocolName | 'auto';
}

export interface Credential {
	kind: AuthKind;
	secret: string;
}

export interface ServerVersion {
	/** e.g. `18.0`, `saas~18.4`. */
	serverVersion?: string;
	major?: number;
	minor?: number;
}

/** One RPC dialect. Each turns `execute_kw` into its own wire format. */
export interface Protocol {
	readonly name: ProtocolName;
	/** Establishes the uid or session. Idempotent. */
	authenticate(signal?: AbortSignal): Promise<void>;
	executeKw(
		model: string,
		method: string,
		args: unknown[],
		kwargs: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown>;
}

export interface FieldInfo {
	type: string;
	string?: string;
	help?: string;
	required?: boolean;
	readonly?: boolean;
	store?: boolean;
	sortable?: boolean;
	relation?: string;
	selection?: [string, string][];
}

export type FieldsGetResult = Record<string, FieldInfo>;
export type OdooRecord = Record<string, unknown>;
