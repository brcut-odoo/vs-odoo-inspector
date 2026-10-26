import { FieldsGetResult, OdooRecord } from '../odoo/types';

/** Field types never fetched by default: heavy, or lists of ids. */
const SKIPPED_TYPES = new Set(['binary', 'image', 'html', 'one2many', 'many2many', 'properties', 'properties_definition', 'json']);

/** Worth showing first, when the model asks for no specific fields. */
const PREFERRED = ['display_name', 'name', 'ref', 'code', 'email', 'phone', 'partner_id', 'user_id', 'company_id', 'state', 'stage_id', 'date', 'date_order', 'amount_total', 'product_id', 'quantity', 'create_date'];

/**
 * The fields fetched when the model names none. Odoo would otherwise return
 * every field, binaries included: slow, and a large surface to review.
 */
export function defaultFields(fields: FieldsGetResult, cap = 12): string[] {
	const usable = (name: string) => {
		const info = fields[name];
		return Boolean(info) && !SKIPPED_TYPES.has(info.type) && info.store !== false;
	};
	const picked = PREFERRED.filter((name) => usable(name) || (name === 'display_name' && name in fields));
	const rest = Object.keys(fields)
		.filter((name) => usable(name) && !picked.includes(name) && name !== 'id' && !name.startsWith('message_') && !name.startsWith('activity_') && !['write_uid', 'write_date', 'create_uid', '__last_update'].includes(name))
		.sort();
	return [...picked, ...rest].slice(0, cap);
}

/** Columns that are always returned: without `id` the model cannot refer to records. */
export const ALWAYS_INCLUDED = new Set(['id']);

/**
 * Fields a domain filters on. Filtering on a field leaks its values (e.g.
 * `[('email', 'ilike', 'ceo@')]` reveals who matches), so these count as
 * used even when they are not returned.
 *
 * Paths are reduced to their head: `partner_id.email` uses `partner_id` on
 * this model. The inner fields of `any` sub-domains belong to another model
 * and are covered by the head the same way.
 */
export function domainFields(domain: unknown): string[] {
	const found = new Set<string>();
	const visit = (node: unknown) => {
		if (!Array.isArray(node)) {
			return;
		}
		// A leaf is (field, operator, value) with a string field.
		if (node.length === 3 && typeof node[0] === 'string' && typeof node[1] === 'string' && !isOperatorToken(node[0])) {
			const head = node[0].split('.')[0];
			if (head) {
				found.add(head);
			}
			return;
		}
		for (const child of node) {
			visit(child);
		}
	};
	visit(domain);
	return [...found];
}

function isOperatorToken(value: string): boolean {
	return value === '&' || value === '|' || value === '!';
}

/** Fields an `order` clause sorts on, e.g. `"date desc, partner_id"`. */
export function orderFields(order: unknown): string[] {
	if (typeof order !== 'string') {
		return [];
	}
	return order
		.split(',')
		.map((part) => part.trim().split(/\s+/)[0]?.split('.')[0] ?? '')
		.filter(Boolean);
}

/** Field names in a `read_group`-style `groupby`, e.g. `["date:month", "user_id"]`. */
export function groupbyFields(groupby: unknown): string[] {
	const list = typeof groupby === 'string' ? [groupby] : Array.isArray(groupby) ? groupby : [];
	return list.filter((item): item is string => typeof item === 'string').map((item) => item.split(':')[0].split('.')[0]);
}

/** A result as table rows, or `undefined` when it is not a list of records. */
export function asRows(result: unknown): OdooRecord[] | undefined {
	if (!Array.isArray(result) || !result.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) {
		return undefined;
	}
	return result as OdooRecord[];
}

/** Ordered union of row keys, then any extra (filter-only) fields. */
export function columnsOf(rows: OdooRecord[], extra: string[] = []): string[] {
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			seen.add(key);
		}
	}
	for (const name of extra) {
		seen.add(name);
	}
	return [...seen];
}

/** Keeps only the allowed columns (plus `id`) of each row. */
export function project(rows: OdooRecord[], allowed: Iterable<string>): OdooRecord[] {
	const keep = new Set([...allowed, ...ALWAYS_INCLUDED]);
	return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => keep.has(key))));
}

/**
 * Reduces many2one values to their id. Odoo returns `[id, display_name]`
 * (or `{id, display_name}` from `web_read`), but the name is another
 * record's data the user never sees as its own column, so it is not shared.
 */
export function relationIds(rows: OdooRecord[], fields: FieldsGetResult): OdooRecord[] {
	const idOf = (value: unknown): unknown => {
		if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
			return value[0];
		}
		if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as OdooRecord).id === 'number') {
			return (value as OdooRecord).id;
		}
		return value;
	};
	return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, fields[key]?.type === 'many2one' ? idOf(value) : value])));
}
