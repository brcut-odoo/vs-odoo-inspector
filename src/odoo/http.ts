import { OdooError } from './errors';

/**
 * Spaces requests at least `1 / perSecond` apart. Odoo SaaS throttles hard,
 * so the default is one request per second.
 */
export class RateLimiter {
	private next = 0;

	constructor(private readonly perSecond: number) {}

	async wait(signal?: AbortSignal): Promise<void> {
		if (this.perSecond <= 0) {
			return;
		}
		const interval = 1000 / this.perSecond;
		const now = Date.now();
		const at = Math.max(now, this.next);
		this.next = at + interval;
		if (at > now) {
			await sleep(at - now, signal);
		}
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(signal.reason);
		});
	});
}

export interface HttpOptions {
	baseUrl: string;
	limiter: RateLimiter;
	timeoutMs?: number;
	/** Injected in tests. */
	fetch?: typeof fetch;
}

export interface HttpResponse {
	status: number;
	text: string;
	headers: Headers;
}

/** Thin `fetch` wrapper: rate limit, timeout, network errors as `OdooError`. */
export class Http {
	private readonly fetchImpl: typeof fetch;
	readonly baseUrl: string;

	constructor(private readonly options: HttpOptions) {
		this.fetchImpl = options.fetch ?? fetch;
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
	}

	async post(path: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse> {
		await this.options.limiter.wait(signal);
		const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', body, headers, signal: combined, redirect: 'manual' });
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			const reason = timeout.aborted ? 'timed out' : (error as Error).message;
			throw new OdooError(`Could not reach ${this.baseUrl}: ${reason}`, 'network', 'Check the URL and that the server is reachable.');
		}
		if (response.status >= 300 && response.status < 400) {
			throw new OdooError(
				`${this.baseUrl}${path} redirected to ${response.headers.get('location') ?? 'another URL'}.`,
				'network',
				'Use the final URL (often https:// instead of http://) as the connection URL.',
			);
		}
		return { status: response.status, text: await response.text(), headers: response.headers };
	}

	/** POSTs JSON and parses the response, rejecting HTML error pages clearly. */
	async postJson(path: string, payload: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: unknown; headers: Headers }> {
		const response = await this.post(path, JSON.stringify(payload), { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, signal);
		try {
			return { status: response.status, body: response.text ? JSON.parse(response.text) : null, headers: response.headers };
		} catch {
			throw new OdooError(
				`${path} returned HTTP ${response.status} with a non-JSON body.`,
				response.status === 404 ? 'protocol' : 'server',
				response.status === 404 ? 'This endpoint does not exist on this server version; choose another protocol.' : undefined,
			);
		}
	}
}

/** Pulls `session_id` out of a `Set-Cookie` response. */
export function sessionCookie(headers: Headers): string | undefined {
	const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
	for (const cookie of cookies) {
		const match = /(?:^|[;,]\s*)session_id=([^;]+)/.exec(cookie);
		if (match) {
			return match[1];
		}
	}
	return undefined;
}
