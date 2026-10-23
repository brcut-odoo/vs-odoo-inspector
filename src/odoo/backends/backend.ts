import { QuerySpec } from '../types';

/**
 * The arg/kwarg shaping contract.
 *
 * Ported from `support-tools/lib/rpc/odoo_rpc.py`. Each backend turns the same
 * logical `QuerySpec` into a different `(args, kwargs)` pair:
 *
 *  - `callKw` keeps positional args and puts options in `kwargs`.
 *  - `json2`  moves everything into `kwargs` (the body *is* the kwargs).
 */
export interface RpcBackend {
	/** Human-readable name, used in logs and error messages. */
	readonly name: string;

	/** Executes a logical query and returns the raw result. */
	call(spec: QuerySpec, signal?: AbortSignal): Promise<unknown>;

	/** Builds the `(args, kwargs)` pair for a spec. Exposed for testing. */
	shape(spec: QuerySpec): { args: unknown[]; kwargs: Record<string, unknown> };
}

/** Shared shaping helpers, overridden per backend where the contract differs. */
export function baseShape(spec: QuerySpec): { args: unknown[]; kwargs: Record<string, unknown> } {
	const kwargs: Record<string, unknown> = {};
	if (spec.context && Object.keys(spec.context).length > 0) {
		kwargs.context = spec.context;
	}

	switch (spec.method) {
		case 'search_read': {
			const args: unknown[] = [spec.domain ?? []];
			if (spec.fields?.length) {
				kwargs.fields = spec.fields;
			}
			if (spec.offset) {
				kwargs.offset = spec.offset;
			}
			if (spec.limit) {
				kwargs.limit = spec.limit;
			}
			if (spec.order) {
				kwargs.order = spec.order;
			}
			return { args, kwargs };
		}
		case 'search': {
			const args: unknown[] = [spec.domain ?? []];
			if (spec.offset) {
				kwargs.offset = spec.offset;
			}
			if (spec.limit) {
				kwargs.limit = spec.limit;
			}
			if (spec.order) {
				kwargs.order = spec.order;
			}
			return { args, kwargs };
		}
		case 'search_count':
			return { args: [spec.domain ?? []], kwargs };
		case 'read': {
			const args: unknown[] = [spec.ids ?? []];
			if (spec.fields?.length) {
				kwargs.fields = spec.fields;
			}
			return { args, kwargs };
		}
		case 'fields_get': {
			const args: unknown[] = [];
			if (spec.fields?.length) {
				kwargs.attributes = spec.fields;
			}
			return { args, kwargs };
		}
		case 'name_search': {
			const args: unknown[] = [spec.name ?? ''];
			if (spec.domain?.length) {
				kwargs.args = spec.domain;
			}
			if (spec.limit) {
				kwargs.limit = spec.limit;
			}
			return { args, kwargs };
		}
		case 'create':
			return { args: [spec.values ?? {}], kwargs };
		case 'write': {
			const args: unknown[] = [spec.ids ?? [], spec.values ?? {}];
			return { args, kwargs };
		}
		case 'unlink':
			return { args: [spec.ids ?? []], kwargs };
		case 'call':
			return { args: spec.args ?? [], kwargs: { ...kwargs, ...(spec.kwargs ?? {}) } };
		default:
			return { args: [], kwargs };
	}
}

/** The Odoo method name for a logical query. */
export function methodName(spec: QuerySpec): string {
	return spec.method === 'call' ? (spec.rawMethod ?? '') : spec.method;
}
