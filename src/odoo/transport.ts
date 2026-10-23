import { OdooError, OdooErrorKind } from './types';
import { RateLimiter } from './rateLimiter';

export interface TransportOptions {
	baseUrl: string;
	/** Extra headers, e.g. `Authorization` / `X-Odoo-Database`. */
	headers?: Record<string, string>;
	/** Cookie header value, used by the `callKw` backend. */
	cookie?: string;
	rateLimiter?: RateLimiter;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
}

export interface RawResponse {
	status: number;
	body: unknown;
	text: string;
	/** Response headers. Needed because Odoo 17+ only returns the session id here. */
	headers: Headers;
}

/**
 * Thin `fetch` wrapper that:
 *  - normalizes the base URL,
 *  - applies the rate limiter,
 *  - converts every failure mode into an `OdooError`.
 */
export class Transport {
	private readonly baseUrl: string;

	constructor(private readonly options: TransportOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
	}

	get url(): string {
		return this.baseUrl;
	}

	/** Replaces the cookie header, e.g. after exchanging an API key for a session. */
	setCookie(cookie: string | undefined): void {
		this.options.cookie = cookie;
	}

	async postJson(path: string, payload: unknown): Promise<RawResponse> {
		return this.request('POST', path, payload);
	}

	async getJson(path: string): Promise<RawResponse> {
		return this.request('GET', path, undefined);
	}

	private async request(
		method: 'GET' | 'POST',
		path: string,
		payload: unknown,
	): Promise<RawResponse> {
		await this.options.rateLimiter?.waitUntilReady();

		const headers: Record<string, string> = {
			Accept: 'application/json',
			...this.options.headers,
		};
		if (payload !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		if (this.options.cookie) {
			headers['Cookie'] = this.options.cookie;
		}

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: payload === undefined ? undefined : JSON.stringify(payload),
				signal: this.options.signal,
			});
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			throw new OdooError(
				`Cannot reach ${this.baseUrl}: ${errorMessage(error)}`,
				'network',
				undefined,
				error,
			);
		}

		const text = await response.text();
		const body = parseJsonOrUndefined(text);

		if (!response.ok) {
			throw buildHttpError(response.status, body, text);
		}

		// Odoo rotates the session id on every save and only reports the new
		// one through `Set-Cookie`. Track it so the next request stays on the
		// same server-side session instead of relying on the old id remaining
		// valid.
		const rotated = extractSessionCookie(response.headers);
		if (rotated) {
			this.options.cookie = `session_id=${rotated}`;
		}

		return { status: response.status, body, text, headers: response.headers };
	}
}

/**
 * Reads `session_id` out of a `Set-Cookie` header, if present.
 *
 * `Headers.get('set-cookie')` is not trustworthy for multiple cookies: the
 * fetch spec joins them with `, `. `getSetCookie()` is used when available and
 * the joined form is only a fallback.
 */
export function extractSessionCookie(headers: Headers): string | undefined {
	const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
	const values = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [];
	const candidates = values.length ? values : [headers.get('set-cookie')].filter(Boolean);

	for (const header of candidates as string[]) {
		for (const piece of header.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
			const match = piece.trim().match(/(?:^|;)\s*session_id=([^;]+)/);
			if (match) {
				return decodeURIComponent(match[1].trim());
			}
		}
	}
	return undefined;
}

/** Strips trailing slashes and adds a scheme when the user omitted one. */
export function normalizeBaseUrl(url: string): string {
	let value = url.trim();
	if (!value) {
		throw new OdooError('The Odoo URL is empty.', 'validation');
	}
	if (!/^https?:\/\//i.test(value)) {
		value = `https://${value}`;
	}
	return value.replace(/\/+$/, '');
}

function parseJsonOrUndefined(text: string): unknown {
	if (!text) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function buildHttpError(status: number, body: unknown, text: string): OdooError {
	const message = extractErrorMessage(body) ?? (text.trim() || `HTTP ${status}`);
	const kind = classifyStatus(status, message);
	return new OdooError(message, kind, status, body);
}

function classifyStatus(status: number, message: string): OdooErrorKind {
	if (status === 401 || status === 403) {
		return 'auth';
	}
	if (status === 404) {
		return 'notFound';
	}
	if (status === 422 || status === 400) {
		return 'validation';
	}
	if (/access\s*(denied|error)|not allowed to access/i.test(message)) {
		return 'access';
	}
	if (status >= 500) {
		return 'server';
	}
	return 'unknown';
}

/**
 * Pulls a human-readable message out of the various error envelopes Odoo uses:
 *
 *  - JSON-RPC: `{ error: { message, data: { message, name, debug } } }`
 *  - `/json/2`: `{ name, message, arguments, context, debug }`
 *  - plain text bodies
 */
export function extractErrorMessage(body: unknown): string | undefined {
	if (!body || typeof body !== 'object') {
		return undefined;
	}
	const record = body as Record<string, unknown>;

	const error = record.error;
	if (error && typeof error === 'object') {
		const errorRecord = error as Record<string, unknown>;
		const data = errorRecord.data;
		if (data && typeof data === 'object') {
			const dataRecord = data as Record<string, unknown>;
			const dataMessage = asString(dataRecord.message);
			if (dataMessage) {
				return dataMessage;
			}
		}
		const message = asString(errorRecord.message);
		if (message) {
			return message;
		}
	}

	const direct = asString(record.message);
	if (direct) {
		return direct;
	}

	const detail = asString(record.detail);
	if (detail) {
		return detail;
	}

	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: string }).name === 'AbortError'
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
