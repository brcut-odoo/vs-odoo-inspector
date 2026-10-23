import { OdooError } from './errors';
import { AuthKind, ProtocolName, ServerVersion } from './types';

/**
 * Guesses the credential kind from its shape:
 * - 40 lowercase hex characters: an API key (Odoo hexlifies 20 random bytes);
 * - 42+ url-safe characters: a session id;
 * - anything else: a password.
 *
 * Ambiguous by nature, so the connection wizard asks for the kind explicitly.
 */
export function detectAuthKind(secret: string): AuthKind {
	if (/^[0-9a-f]{40}$/.test(secret)) {
		return 'apiKey';
	}
	if (/^[A-Za-z0-9_-]{42,}$/.test(secret)) {
		return 'session';
	}
	return 'password';
}

/** `/json/2` exists from 18.5 (saas~18.5 and 19.0 onwards). */
export function supportsJson2(version: ServerVersion): boolean {
	const { major, minor } = version;
	if (major === undefined) {
		return false;
	}
	return major > 18 || (major === 18 && (minor ?? 0) >= 5);
}

/**
 * Which protocols can carry which credential kind. API keys are refused by
 * `/web/session/authenticate` (they are RPC-only), so callKw cannot use one.
 */
const ACCEPTS: Record<ProtocolName, AuthKind[]> = {
	jsonrpc: ['password', 'apiKey'],
	xmlrpc: ['password', 'apiKey'],
	callKw: ['password', 'session'],
	json2: ['apiKey'],
};

/**
 * Picks the protocol for a credential and server.
 *
 * Automatic choice: a session must use callKw; an API key prefers json2 where
 * it exists; everything else uses the external JSON-RPC API.
 */
export function selectProtocol(kind: AuthKind, version: ServerVersion, forced?: ProtocolName | 'auto'): ProtocolName {
	if (forced && forced !== 'auto') {
		if (!ACCEPTS[forced].includes(kind)) {
			throw new OdooError(
				`The ${forced} protocol does not accept a ${describeKind(kind)}.`,
				'auth',
				`Use ${ACCEPTS[forced].map(describeKind).join(' or ')} with ${forced}, or set the protocol to "auto".`,
			);
		}
		if (forced === 'json2' && version.major !== undefined && !supportsJson2(version)) {
			throw new OdooError(
				`json2 needs Odoo 18.5 or later; this server is ${version.serverVersion ?? version.major}.`,
				'protocol',
				'Use jsonrpc or xmlrpc with the API key instead.',
			);
		}
		return forced;
	}
	if (kind === 'session') {
		return 'callKw';
	}
	if (kind === 'apiKey' && supportsJson2(version)) {
		return 'json2';
	}
	return 'jsonrpc';
}

export function describeKind(kind: AuthKind): string {
	return kind === 'apiKey' ? 'API key' : kind === 'session' ? 'session token' : 'password';
}

/** Parses `server_version_info`, e.g. `[18, 0, 0, "final", 0, ""]` or `["saas~18", 5, …]`. */
export function parseVersionInfo(info: unknown, serverVersion?: string): ServerVersion {
	if (Array.isArray(info) && info.length >= 2) {
		const major = Number.parseInt(String(info[0]).replace(/^\D+/, ''), 10);
		const minor = Number.parseInt(String(info[1]), 10);
		return { serverVersion, major: Number.isNaN(major) ? undefined : major, minor: Number.isNaN(minor) ? undefined : minor };
	}
	const match = /(\d+)\.(\d+)/.exec(serverVersion ?? '');
	return match ? { serverVersion, major: Number(match[1]), minor: Number(match[2]) } : { serverVersion };
}
