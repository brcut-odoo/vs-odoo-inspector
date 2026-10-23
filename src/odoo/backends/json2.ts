import { OdooError, QuerySpec } from '../types';
import { Transport } from '../transport';
import { RpcBackend, baseShape, methodName } from './backend';
import { classifyOdooError } from './callKw';

/**
 * `/json/2/<model>/<method>` backend (Odoo >= 18.5).
 *
 * Differences from `call_kw` (from `support-tools/lib/rpc/odoo_json2.py`):
 *  - model and method are **path segments**, not body fields;
 *  - the body is the kwargs object directly — there is no `args` wrapper;
 *  - auth is `Authorization: Bearer <api_key>` plus `X-Odoo-Database`.
 */
export class Json2Backend implements RpcBackend {
	readonly name = 'json2';

	constructor(private readonly transport: Transport) {}

	/**
	 * Everything moves into kwargs. `ids` is the one positional-ish argument
	 * that `/json/2` accepts as a named parameter.
	 */
	shape(spec: QuerySpec): { args: unknown[]; kwargs: Record<string, unknown> } {
		const { kwargs } = baseShape(spec);
		const result: Record<string, unknown> = { ...kwargs };

		switch (spec.method) {
			case 'search_read':
			case 'search':
			case 'search_count':
				result.domain = spec.domain ?? [];
				break;
			case 'read':
				result.ids = spec.ids ?? [];
				break;
			case 'write':
				result.ids = spec.ids ?? [];
				result.vals = spec.values ?? {};
				break;
			case 'create':
				result.vals_list = Array.isArray(spec.values) ? spec.values : [spec.values ?? {}];
				break;
			case 'unlink':
				result.ids = spec.ids ?? [];
				break;
			case 'name_search':
				result.name = spec.name ?? '';
				if (spec.domain?.length) {
					result.args = spec.domain;
				}
				break;
			case 'fields_get':
				break;
			case 'call':
				return { args: [], kwargs: { ...result, ...(spec.kwargs ?? {}) } };
		}

		// `baseShape` may have produced positional args; `/json/2` never uses them.
		return { args: [], kwargs: result };
	}

	async call(spec: QuerySpec, signal?: AbortSignal): Promise<unknown> {
		const { kwargs } = this.shape(spec);
		const method = methodName(spec);
		if (!method) {
			throw new OdooError('No method specified for the /json/2 call.', 'validation');
		}

		const path = `/json/2/${encodeURIComponent(spec.model)}/${encodeURIComponent(method)}`;
		const response = await this.transport.postJson(path, kwargs);
		return response.body;
	}
}

/** Re-exported so callers can classify `/json/2` errors the same way. */
export { classifyOdooError };
