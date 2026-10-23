import { FieldsGetResult, OdooError, QuerySpec } from '../odoo/types';
import { OdooClient } from '../odoo/client';
import { buildColumns, defaultFieldNames } from '../query/columns';
import { normalizeSpec } from '../query/spec';
import { formatIssues, validateSpec } from '../query/validate';

/** A tool definition, independent of any host (VS Code LM or MCP). */
export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	/** JSON Schema for the input object. */
	inputSchema: Record<string, unknown>;
	/** Read-only tools can be auto-approved by hosts. */
	readOnly: boolean;
	/** Executes the tool. Throws on failure. */
	run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
	client: OdooClient;
	/** Maximum rows to return, from settings. */
	maxRows: number;
	/**
	 * Optional gate. When provided, the host may let the user edit the query
	 * before it runs.
	 *
	 * The gate is responsible for executing the query, because the interactive
	 * host (the Query Workbench) runs it as part of the user's Execute action.
	 * Returning `undefined` means the user cancelled.
	 */
	gate?: (spec: QuerySpec, fields: FieldsGetResult) => Promise<GatedResult | undefined>;
}

/** What a gate returns: the spec that ran, and the rows it produced. */
export interface GatedResult {
	spec: QuerySpec;
	rows: Record<string, unknown>[];
}

export interface ToolResult {
	/** Text shown to the LLM. */
	text: string;
	/** Structured payload, for hosts that can render it. */
	data?: unknown;
	/** The spec that was actually executed. */
	spec?: QuerySpec;
}

/** The full tool set. */
export function createTools(): ToolDefinition[] {
	return [
		listModelsTool(),
		getFieldsTool(),
		searchReadTool(),
		readRecordsTool(),
		countRecordsTool(),
		callMethodTool(),
	];
}

function listModelsTool(): ToolDefinition {
	return {
		name: 'odoo_list_models',
		title: 'List Odoo models',
		description:
			'Lists the models available on the connected Odoo database, with their technical name and human label. ' +
			'Use this first when you do not know which model holds the data you need. ' +
			'Returns at most 500 models; filter with the "filter" parameter to narrow the list.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			properties: {
				filter: {
					type: 'string',
					description:
						'Case-insensitive substring matched against the model name or label, e.g. "sale" or "invoice".',
				},
			},
		},
		async run(input, context) {
			const filter = String(input.filter ?? '').toLowerCase();
			const models = await context.client.listModels();
			const filtered = filter
				? models.filter(
						(entry) =>
							entry.model.toLowerCase().includes(filter) ||
							entry.name.toLowerCase().includes(filter),
					)
				: models;
			const limited = filtered.slice(0, 500);
			return {
				text: limited.length
					? limited.map((entry) => `${entry.model} — ${entry.name}`).join('\n')
					: 'No models matched that filter.',
				data: limited,
			};
		},
	};
}

function getFieldsTool(): ToolDefinition {
	return {
		name: 'odoo_get_fields',
		title: 'Get Odoo model fields',
		description:
			'Returns the field definitions of an Odoo model: technical name, label, type, whether it is stored, ' +
			'and for relational fields the target model. ' +
			'Always call this before building a domain or choosing fields, so you do not reference fields that do not exist.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			properties: {
				model: {
					type: 'string',
					description: 'Technical model name, e.g. "res.partner" or "sale.order".',
				},
				fields: {
					type: 'array',
					items: { type: 'string' },
					description: 'Optional subset of field names to describe. Omit to get all fields.',
				},
			},
			required: ['model'],
		},
		async run(input, context) {
			const model = requireString(input, 'model');
			const all = await context.client.fieldsGet(model);
			const wanted = Array.isArray(input.fields) ? (input.fields as string[]) : undefined;
			const entries = Object.entries(all).filter(
				([name]) => !wanted || wanted.includes(name),
			);

			if (wanted) {
				const missing = wanted.filter((name) => !all[name]);
				if (missing.length) {
					throw new OdooError(
						`Unknown field(s) on ${model}: ${missing.join(', ')}. ` +
							`Call odoo_get_fields without a "fields" filter to list valid names.`,
						'validation',
					);
				}
			}

			const lines = entries.map(([name, info]) => {
				const bits = [`${name} (${info.type})`, info.string ?? ''];
				if (info.required) {
					bits.push('required');
				}
				if (info.readonly) {
					bits.push('readonly');
				}
				if (info.relation) {
					bits.push(`-> ${info.relation}`);
				}
				return bits.filter(Boolean).join(' · ');
			});

			return {
				text: lines.join('\n') || 'No fields matched.',
				data: Object.fromEntries(entries),
			};
		},
	};
}

function searchReadTool(): ToolDefinition {
	return {
		name: 'odoo_search_read',
		title: 'Search and read Odoo records',
		description:
			'Searches records on an Odoo model and returns the requested fields. ' +
			'This is the main read tool. The user can review and edit the query — including which columns are returned — ' +
			'before it is sent, so propose a complete query rather than a minimal one. ' +
			'Domains use Odoo syntax: [["field", "operator", value], ...] with operators such as =, !=, >, <, in, ilike, child_of. ' +
			'Prefix with "&", "|", "!" for boolean logic. ' +
			'Call odoo_get_fields first if you are unsure of field names.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			properties: {
				model: { type: 'string', description: 'Technical model name, e.g. "res.partner".' },
				domain: {
					type: 'array',
					description: 'Odoo search domain. Omit or use [] to match all records.',
					items: {},
				},
				fields: {
					type: 'array',
					items: { type: 'string' },
					description:
						'Field names to return. Omit to let the user pick columns in the workbench.',
				},
				limit: {
					type: 'number',
					description: 'Maximum number of records. Defaults to 200.',
				},
				offset: { type: 'number', description: 'Number of records to skip.' },
				order: {
					type: 'string',
					description: 'Sort order, e.g. "create_date desc" or "name asc, id desc".',
				},
				context: {
					type: 'object',
					description: 'Odoo context overrides, e.g. {"lang": "en_US", "active_test": false}.',
				},
			},
			required: ['model'],
		},
		async run(input, context) {
			const spec = normalizeSpec({
				model: requireString(input, 'model'),
				method: 'search_read',
				domain: asArray(input.domain),
				fields: asStringArray(input.fields),
				limit: asNumber(input.limit) ?? context.maxRows,
				offset: asNumber(input.offset),
				order: asString(input.order),
				context: asObject(input.context),
			});

			return runGated(spec, context, async (finalSpec) => {
				const rows = await context.client.searchRead(
					finalSpec.model,
					finalSpec.domain ?? [],
					finalSpec.fields?.length ? finalSpec.fields : undefined,
					{
						limit: finalSpec.limit,
						offset: finalSpec.offset,
						order: finalSpec.order,
						context: finalSpec.context,
					},
				);
				return { rows, spec: finalSpec };
			});
		},
	};
}

function readRecordsTool(): ToolDefinition {
	return {
		name: 'odoo_read_records',
		title: 'Read Odoo records by id',
		description:
			'Reads specific records by their database ids. Use this when you already have ids from a previous search. ' +
			'Prefer odoo_search_read when you need to filter by field values.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			properties: {
				model: { type: 'string', description: 'Technical model name.' },
				ids: {
					type: 'array',
					items: { type: 'number' },
					description: 'Database ids of the records to read.',
				},
				fields: {
					type: 'array',
					items: { type: 'string' },
					description: 'Field names to return. Omit for all fields.',
				},
			},
			required: ['model', 'ids'],
		},
		async run(input, context) {
			const spec = normalizeSpec({
				model: requireString(input, 'model'),
				method: 'read',
				ids: asNumberArray(input.ids),
				fields: asStringArray(input.fields),
			});

			return runGated(spec, context, async (finalSpec) => {
				const rows = await context.client.read(
					finalSpec.model,
					finalSpec.ids ?? [],
					finalSpec.fields?.length ? finalSpec.fields : undefined,
				);
				return { rows, spec: finalSpec };
			});
		},
	};
}

function countRecordsTool(): ToolDefinition {
	return {
		name: 'odoo_count_records',
		title: 'Count Odoo records',
		description:
			'Counts the records matching a domain, without fetching them. ' +
			'Use this to check how many records a query would return before reading them.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			properties: {
				model: { type: 'string', description: 'Technical model name.' },
				domain: {
					type: 'array',
					description: 'Odoo search domain. Omit or use [] to count all records.',
					items: {},
				},
			},
			required: ['model'],
		},
		async run(input, context) {
			const model = requireString(input, 'model');
			const domain = asArray(input.domain) ?? [];
			const count = await context.client.count(model, domain);
			return {
				text: `${count} record${count === 1 ? '' : 's'} match on ${model}.`,
				data: { model, count },
			};
		},
	};
}

function callMethodTool(): ToolDefinition {
	return {
		name: 'odoo_call_method',
		title: 'Call an arbitrary Odoo method',
		description:
			'Calls any public method on an Odoo model. This is a powerful escape hatch: it can modify data. ' +
			'Prefer the dedicated read tools. Only use this when no other tool fits, and explain to the user what the call will do. ' +
			'This tool is disabled unless the user enables "odooInspector.enableArbitraryMethodCalls".',
		readOnly: false,
		inputSchema: {
			type: 'object',
			properties: {
				model: { type: 'string', description: 'Technical model name.' },
				method: { type: 'string', description: 'Method name, e.g. "action_confirm".' },
				args: {
					type: 'array',
					description: 'Positional arguments.',
					items: {},
				},
				kwargs: {
					type: 'object',
					description: 'Keyword arguments.',
				},
			},
			required: ['model', 'method'],
		},
		async run(input, context) {
			const spec = normalizeSpec({
				model: requireString(input, 'model'),
				method: 'call',
				rawMethod: requireString(input, 'method'),
				args: asArray(input.args) ?? [],
				kwargs: asObject(input.kwargs) ?? {},
			});

			return runGated(spec, context, async (finalSpec) => {
				const result = await context.client.call(finalSpec);
				return { rows: Array.isArray(result) ? result : [{ result }], spec: finalSpec };
			});
		},
	};
}

/**
 * Runs a query through the optional gate, then formats the result.
 *
 * Shared by every tool so the gate and the truncation behave identically.
 *
 * When a gate is present it owns execution — the interactive workbench runs
 * the query as part of the user's Execute action, so re-running it here would
 * double every request.
 */
async function runGated(
	spec: QuerySpec,
	context: ToolContext,
	execute: (spec: QuerySpec) => Promise<{ rows: Record<string, unknown>[]; spec: QuerySpec }>,
): Promise<ToolResult> {
	const fields = await context.client.fieldsGet(spec.model);

	const issues = validateSpec(spec, fields).filter((issue) => issue.severity === 'error');
	if (issues.length > 0) {
		throw new OdooError(
			`The query is invalid:\n${formatIssues(issues)}\n` +
				`Call odoo_get_fields on "${spec.model}" to see valid field names.`,
			'validation',
		);
	}

	let finalSpec = spec;
	let rows: Record<string, unknown>[];

	if (context.gate) {
		const gated = await context.gate(spec, fields);
		if (!gated) {
			return { text: 'The user cancelled this query.', spec };
		}
		finalSpec = gated.spec;
		rows = gated.rows;
	} else {
		const executed = await execute(spec);
		finalSpec = executed.spec;
		rows = executed.rows;
	}

	const columns = buildColumns(fields, finalSpec);
	const enabled = columns.filter((column) => column.enabled).map((column) => column.name);
	const shown = rows.slice(0, context.maxRows);

	return {
		text: formatRows(finalSpec, shown, rows.length, enabled, fields),
		data: shown,
		spec: finalSpec,
	};
}

/** Renders rows as a compact markdown table for the LLM. */
function formatRows(
	spec: QuerySpec,
	rows: Record<string, unknown>[],
	total: number,
	fields: string[],
	fieldsMeta: FieldsGetResult,
): string {
	if (rows.length === 0) {
		return `No records matched on ${spec.model}.`;
	}

	const columns = fields.length ? fields : defaultFieldNames(fieldsMeta);
	const header = `| ${columns.join(' | ')} |`;
	const divider = `| ${columns.map(() => '---').join(' | ')} |`;
	const body = rows.map((row) => {
		const cells = columns.map((name) => formatCell(row[name]));
		return `| ${cells.join(' | ')} |`;
	});

	const summary =
		total > rows.length
			? `Showing ${rows.length} of ${total} records from ${spec.model}.`
			: `${rows.length} record${rows.length === 1 ? '' : 's'} from ${spec.model}.`;

	return [summary, '', header, divider, ...body].join('\n');
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined || value === false) {
		return '';
	}
	if (value === true) {
		return 'yes';
	}
	if (Array.isArray(value)) {
		if (value.length === 2 && typeof value[0] === 'number') {
			return String(value[1] ?? value[0]);
		}
		return value.map((item) => (Array.isArray(item) ? String(item[1] ?? item[0]) : String(item))).join(', ');
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	const text = String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
	return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function requireString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== 'string' || !value.trim()) {
		throw new OdooError(`The "${key}" parameter is required and must be a non-empty string.`, 'validation');
	}
	return value.trim();
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((item): item is string => typeof item === 'string');
	return strings.length ? strings : undefined;
}

function asNumberArray(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const numbers = value
		.map((item) => asNumber(item))
		.filter((item): item is number => item !== undefined);
	return numbers.length ? numbers : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
