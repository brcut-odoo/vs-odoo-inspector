import { QuerySpec } from '../odoo/types';

/** Default page size when the caller does not specify a limit. */
export const DEFAULT_LIMIT = 200;

/** Hard ceiling, so a runaway query cannot freeze the webview. */
export const MAX_LIMIT = 5000;

/**
 * Methods that never mutate data.
 *
 * Used by the `writes-only` gate mode, and to decide whether a query may be
 * run as a preview while the user is still reviewing it. `call` is excluded
 * on purpose: `odoo_call_method` can invoke anything, so its effect is not
 * knowable ahead of time and it must never be executed to build a preview.
 */
const READ_ONLY_METHODS = new Set([
	'search_read',
	'search',
	'search_count',
	'read',
	'fields_get',
	'name_search',
]);

/** Whether executing this method is free of side effects. */
export function isReadOnlyMethod(method: string): boolean {
	return READ_ONLY_METHODS.has(method);
}

/**
 * Normalizes a partial spec into a complete one.
 *
 * Kept pure so it can be unit-tested without a server.
 */
export function normalizeSpec(input: Partial<QuerySpec> & { model: string }): QuerySpec {
	const spec: QuerySpec = {
		model: input.model,
		method: input.method ?? 'search_read',
		domain: input.domain ?? [],
		fields: input.fields ? [...input.fields] : [],
		limit: clampLimit(input.limit),
		offset: input.offset && input.offset > 0 ? input.offset : 0,
		order: input.order?.trim() || undefined,
		context: input.context && Object.keys(input.context).length ? input.context : undefined,
	};

	if (input.ids) {
		spec.ids = input.ids;
	}
	if (input.values !== undefined) {
		spec.values = input.values;
	}
	if (input.name !== undefined) {
		spec.name = input.name;
	}
	if (input.rawMethod !== undefined) {
		spec.rawMethod = input.rawMethod;
	}
	if (input.args !== undefined) {
		spec.args = input.args;
	}
	if (input.kwargs !== undefined) {
		spec.kwargs = input.kwargs;
	}

	return spec;
}

export function clampLimit(limit: number | undefined): number {
	if (limit === undefined || limit === null || Number.isNaN(limit)) {
		return DEFAULT_LIMIT;
	}
	if (limit <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** Serializes a spec for display in the "Advanced (JSON)" pane. */
export function serializeSpec(spec: QuerySpec): string {
	return JSON.stringify(spec, null, 2);
}

/**
 * Parses a spec edited as JSON.
 *
 * Throws a readable error rather than a raw `SyntaxError`, since this text
 * comes straight from a user-editable editor.
 */
export function parseSpec(text: string): QuerySpec {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('The query must be a JSON object.');
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.model !== 'string' || !record.model.trim()) {
		throw new Error('The query must have a non-empty "model" property.');
	}
	return normalizeSpec(record as Partial<QuerySpec> & { model: string });
}

/** A short one-line description, used in confirmations and logs. */
export function describeSpec(spec: QuerySpec): string {
	const parts = [`${spec.model}.${spec.method === 'call' ? spec.rawMethod : spec.method}`];
	if (spec.domain?.length) {
		parts.push(`domain=${JSON.stringify(spec.domain)}`);
	}
	if (spec.fields?.length) {
		parts.push(`fields=[${spec.fields.join(', ')}]`);
	}
	if (spec.limit) {
		parts.push(`limit=${spec.limit}`);
	}
	if (spec.order) {
		parts.push(`order=${spec.order}`);
	}
	return parts.join(' ');
}
