import { Http, RateLimiter } from './http';

/**
 * The databases a server hosts, from `/web/database/list`, falling back to the
 * external `db.list`. Undefined when neither answers with a list, e.g. with
 * `list_db = False` or an unreachable URL; the caller then asks for a name.
 */
export async function listDatabases(url: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<string[] | undefined> {
	const http = new Http({ baseUrl: url, limiter: new RateLimiter(0), timeoutMs: 10_000, fetch: fetchImpl });
	const attempts: [string, Record<string, unknown>][] = [
		['/web/database/list', {}],
		['/jsonrpc', { service: 'db', method: 'list', args: [] }],
	];
	for (const [path, params] of attempts) {
		try {
			const { body } = await http.postJson(path, { jsonrpc: '2.0', method: 'call', params, id: 1 }, {}, signal);
			const result = (body as { result?: unknown } | null)?.result;
			if (Array.isArray(result) && result.every((name) => typeof name === 'string')) {
				return result;
			}
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
		}
	}
	return undefined;
}
