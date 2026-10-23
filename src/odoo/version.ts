import { ApiMode, OdooError } from './types';
import { Transport } from './transport';

/** Version at which `/json/2` replaced `/web/dataset/call_kw` as the modern API. */
export const JSON2_MIN_VERSION: [number, number] = [18, 5];

export interface VersionProbeResult {
	serverVersion: string;
	versionInfo: (number | string)[];
	apiMode: ApiMode;
}

/**
 * Probes the server version.
 *
 * `/web/webclient/version_info` is the most portable endpoint: it exists on
 * every supported version (17.0 through master) and requires no authentication.
 * `/json/version` is tried first because it is cheaper on 19.0+, but it is
 * absent on older releases, so a 404 falls through to the webclient route.
 */
export async function probeVersion(transport: Transport): Promise<VersionProbeResult> {
	const candidates = ['/json/version', '/web/webclient/version_info'];
	let lastError: unknown;

	for (const path of candidates) {
		try {
			const response = await transport.postJson(path, { jsonrpc: '2.0', method: 'call', params: {} });
			const parsed = parseVersionPayload(response.body);
			if (parsed) {
				return parsed;
			}
		} catch (error) {
			lastError = error;
			if (error instanceof OdooError && error.kind === 'network') {
				throw error;
			}
		}
	}

	throw new OdooError(
		`Could not determine the Odoo version${lastError ? `: ${(lastError as Error).message}` : ''}`,
		'version',
		undefined,
		lastError,
	);
}

/** Extracts version info from either endpoint's response shape. */
export function parseVersionPayload(body: unknown): VersionProbeResult | undefined {
	const payload = unwrapJsonRpc(body);
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const record = payload as Record<string, unknown>;

	const versionInfo = record.version_info ?? record.server_version_info;
	const serverVersion =
		asString(record.version) ?? asString(record.server_version) ?? asString(record.server_serie);

	if (!Array.isArray(versionInfo) && !serverVersion) {
		return undefined;
	}

	const info = Array.isArray(versionInfo)
		? versionInfo
		: parseVersionString(serverVersion ?? '');

	return {
		serverVersion: serverVersion ?? info.join('.'),
		versionInfo: info,
		apiMode: apiModeForVersion(info),
	};
}

/**
 * Maps a parsed version to an API mode.
 *
 * Mirrors `OdooXR.__init__` in `support-tools/lib/odoorpc.py`:
 * `saas~` prefixes are stripped and the comparison is on `(major, minor)`.
 */
export function apiModeForVersion(versionInfo: (number | string)[]): ApiMode {
	const [major, minor] = normalizeVersion(versionInfo);
	if (major === undefined) {
		return 'callKw';
	}
	const [minMajor, minMinor] = JSON2_MIN_VERSION;
	if (major > minMajor || (major === minMajor && (minor ?? 0) >= minMinor)) {
		return 'json2';
	}
	return 'callKw';
}

/** Normalizes `['saas~19', 4, 0, 'e']` style arrays into numeric pairs. */
export function normalizeVersion(versionInfo: (number | string)[]): [number?, number?] {
	if (!versionInfo.length) {
		return [];
	}
	const major = toNumber(versionInfo[0]);
	const minor = versionInfo.length > 1 ? toNumber(versionInfo[1]) : 0;
	return [major, minor];
}

function toNumber(value: number | string | undefined): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	const cleaned = value.replace(/^saas[-~]/i, '').replace(/[^0-9].*$/, '');
	const parsed = Number.parseInt(cleaned, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Parses `"19.0+e"` / `"saas~18.4.1"` into `[19, 0]` / `[18, 4, 1]`. */
export function parseVersionString(version: string): (number | string)[] {
	const cleaned = version.replace(/^saas[-~]/i, '');
	const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
	if (!match) {
		return [];
	}
	const parts: (number | string)[] = [Number(match[1])];
	if (match[2] !== undefined) {
		parts.push(Number(match[2]));
	}
	if (match[3] !== undefined) {
		parts.push(Number(match[3]));
	}
	return parts;
}

function unwrapJsonRpc(body: unknown): unknown {
	if (body && typeof body === 'object' && 'result' in body) {
		return (body as Record<string, unknown>).result;
	}
	return body;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
