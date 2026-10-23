import { FieldInfo, FieldsGetResult, QuerySpec } from '../odoo/types';

/** A column in the Query Workbench table. */
export interface Column {
	/** Technical field name, e.g. `partner_id`. */
	name: string;
	/** Human label, e.g. `Customer`. */
	label: string;
	/** Odoo field type, e.g. `many2one`, `char`, `integer`. */
	type: string;
	/** Whether the field is currently included in the request. */
	enabled: boolean;
	/** Whether the field can be sorted on the server. */
	sortable: boolean;
	/** Whether the field is a relation (rendered as `name`). */
	relational: boolean;
}

/** Field types excluded from the default column set because they are heavy. */
const HEAVY_TYPES = new Set(['binary', 'html', 'image', 'text']);

/** Field types that are never useful as table columns. */
const HIDDEN_TYPES = new Set(['one2many', 'many2many']);

/** Maximum number of columns enabled by default. */
export const DEFAULT_COLUMN_CAP = 8;

/**
 * Field names that are almost always worth showing, in priority order.
 *
 * Without this, the default set is just the alphabetically-first stored
 * scalars, which on `res.partner` yields `autopost_bills`, `barcode` and
 * `buyer_id` before anything a human would actually want to see.
 */
const PREFERRED_FIELDS = [
	'display_name',
	'name',
	'ref',
	'code',
	'login',
	'email',
	'phone',
	'partner_id',
	'company_id',
	'user_id',
	'state',
	'status',
	'stage_id',
	'date',
	'date_order',
	'create_date',
	'amount_total',
	'amount_untaxed',
	'amount',
	'price_unit',
	'product_id',
	'product_tmpl_id',
	'quantity',
	'qty_available',
	'currency_id',
	'country_id',
	'city',
	'active',
];

/**
 * Builds the column list for a model.
 *
 * `enabled` reflects `spec.fields`. When the spec has no explicit fields, a
 * sensible default set is enabled so the table is not empty on first open:
 * `display_name` first, then stored scalar fields, capped.
 *
 * Disabled columns are still returned — the UI shows them dimmed so the user
 * can re-enable them with one click.
 */
export function buildColumns(fields: FieldsGetResult, spec: QuerySpec): Column[] {
	const explicit = spec.fields ?? [];
	const hasExplicit = explicit.length > 0;
	const defaults = hasExplicit ? new Set<string>() : defaultFieldNames(fields);
	const enabledSet = new Set(hasExplicit ? explicit : defaults);

	const columns: Column[] = [];
	for (const [name, info] of Object.entries(fields)) {
		if (HIDDEN_TYPES.has(info.type)) {
			continue;
		}
		columns.push({
			name,
			label: info.string || name,
			type: info.type,
			enabled: enabledSet.has(name),
			sortable: info.sortable !== false && info.store !== false,
			relational: info.type === 'many2one',
		});
	}

	// Explicit fields that are not in `fields_get` (e.g. computed or renamed)
	// still deserve a column, otherwise the user cannot see what they asked for.
	for (const name of explicit) {
		if (!columns.some((column) => column.name === name)) {
			columns.push({
				name,
				label: name,
				type: 'unknown',
				enabled: true,
				sortable: false,
				relational: false,
			});
		}
	}

	// Enabled columns first, then alphabetical — keeps the table stable as the
	// user toggles headers.
	return columns.sort((a, b) => {
		if (a.enabled !== b.enabled) {
			return a.enabled ? -1 : 1;
		}
		if (a.name === 'display_name') {
			return -1;
		}
		if (b.name === 'display_name') {
			return 1;
		}
		return a.label.localeCompare(b.label);
	});
}

/** The field names enabled when the spec does not name any. */
export function defaultFieldNames(fields: FieldsGetResult): string[] {
	const usable = (name: string): boolean => {
		const info = fields[name];
		if (!info) {
			return false;
		}
		if (HIDDEN_TYPES.has(info.type) || HEAVY_TYPES.has(info.type)) {
			return false;
		}
		// Computed non-stored fields cannot be searched or sorted reliably.
		return info.store !== false;
	};

	const names: string[] = [];

	// 1. Well-known fields, in priority order.
	for (const name of PREFERRED_FIELDS) {
		if (names.length >= DEFAULT_COLUMN_CAP) {
			break;
		}
		if (usable(name) && !names.includes(name)) {
			names.push(name);
		}
	}

	// 2. Fill the remaining slots with stored scalars, alphabetically.
	if (names.length < DEFAULT_COLUMN_CAP) {
		const rest = Object.entries(fields)
			.filter(([name, info]) => {
				if (names.includes(name) || name === 'id') {
					return false;
				}
				if (HIDDEN_TYPES.has(info.type) || HEAVY_TYPES.has(info.type)) {
					return false;
				}
				return info.store !== false;
			})
			.map(([name]) => name)
			.sort((a, b) => a.localeCompare(b));

		for (const name of rest) {
			if (names.length >= DEFAULT_COLUMN_CAP) {
				break;
			}
			names.push(name);
		}
	}

	return names;
}

/**
 * Returns a new spec with `field` included or excluded.
 *
 * This is what a header click does. The spec's `fields` array is the single
 * source of truth for what gets requested.
 *
 * When the spec has no explicit fields, the table is showing the *default*
 * column set. Toggling one header must therefore materialize those defaults
 * first — otherwise the request would collapse to the single toggled field.
 * Pass `fields` so the defaults can be resolved.
 */
export function toggleColumn(
	spec: QuerySpec,
	field: string,
	enabled: boolean,
	fields?: FieldsGetResult,
): QuerySpec {
	const current = spec.fields?.length
		? spec.fields
		: fields
			? defaultFieldNames(fields)
			: [];

	const next = enabled
		? current.includes(field)
			? current
			: [...current, field]
		: current.filter((name) => name !== field);

	return { ...spec, fields: next };
}

/** The field names that will actually be requested for a spec. */
export function requestedFields(spec: QuerySpec, fields: FieldsGetResult): string[] {
	if (spec.fields?.length) {
		return spec.fields;
	}
	return defaultFieldNames(fields);
}

/** Field metadata lookup that tolerates unknown fields. */
export function fieldInfoOf(fields: FieldsGetResult, name: string): FieldInfo | undefined {
	return fields[name];
}
