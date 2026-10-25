import { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';
import approvalHtml from 'view:approval';
import { ApprovalBroker, ApprovalRequest } from '../approval/broker';
import { asRows, columnsOf, defaultFields, domainFields, groupbyFields, orderFields, project } from '../approval/columns';
import { ApprovalStore } from '../approval/store';
import { OdooClient } from '../odoo/client';
import { OdooError } from '../odoo/errors';
import { FieldsGetResult, OdooRecord } from '../odoo/types';
import { PreviewResponse, ResultSummary, SUMMARY_META, TOOL_DECIDE, TOOL_PREVIEW, TOOL_RESET, VIEW_URI } from '../view/protocol';
import type { ConnectHints } from '../ui/connectPrompt';
import type { ConnectResult } from '../ui/connections';
import { ApprovalGate, approvalUiFor, CallContext, GateOutcome } from './gate';

export interface ToolSettings {
	/** Most rows a read returns. */
	maxRows: number;
	/** Most rows shown in the approval view. */
	previewRows: number;
	enableExecuteKw: boolean;
}

export interface ToolDeps {
	sessionId: string;
	broker: ApprovalBroker;
	store: ApprovalStore;
	gate: ApprovalGate;
	client(connection?: string): Promise<OdooClient>;
	/** Asks the user to open a connection; they may decline. */
	connect(hints: ConnectHints, signal?: AbortSignal): Promise<ConnectResult>;
	/** The connections open in this session. */
	openConnections(): OdooClient[];
	/** Asks for fresh credentials after an auth failure; true to retry. */
	onAuthFailure(connection: string | undefined, error: unknown): Promise<boolean>;
	settings(): ToolSettings;
	log(message: string): void;
}

type ToolResult = {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
};

/** Methods that only read, so they may run before approval. */
const READ_METHODS = new Set([
	'search', 'search_read', 'search_count', 'read', 'fields_get', 'name_search', 'read_group', 'formatted_read_group',
	'web_search_read', 'web_read', 'web_read_group', 'default_get', 'check_access_rights', 'has_access', 'get_views',
]);

const connectionArg = z.string().optional().describe('Connection name returned by odoo_connect. Omit when only one connection is open.');
const domainArg = z
	.array(z.unknown())
	.optional()
	.describe('Odoo domain, e.g. [["is_company", "=", true], ["name", "ilike", "acme"]]. Prefix "|", "&", "!" for boolean logic.');

/** Registers the Odoo tools for one MCP session. */
export function registerOdooTools(server: McpServer, deps: ToolDeps): void {
	const ui = () => approvalUiFor(server.server.getClientCapabilities() as Parameters<typeof approvalUiFor>[0]);

	registerAppResource(server, 'Odoo approval', VIEW_URI, { description: 'Review the Odoo columns and values before they are shared.' }, async () => ({
		contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: approvalHtml }],
	}));

	// ------------------------------------------------------------ connections

	server.registerTool(
		'odoo_connect',
		{
			title: 'Connect to an Odoo database',
			description:
				'Opens a connection to an Odoo database; required before any other Odoo tool. The user is prompted for the server, ' +
				'database and credentials, and may decline. The arguments only pre-fill the prompt. Returns the connection name to pass ' +
				'as `connection`. Connections last for this chat; call odoo_list_connections first and reuse an open one rather than asking again.',
			inputSchema: z.looseObject({
				url: z.string().optional().describe('Suggested server URL, e.g. https://mycompany.odoo.com, if the user mentioned one.'),
				db: z.string().optional().describe('Suggested database name, if the user mentioned one.'),
				login: z.string().optional().describe('Suggested login, if the user mentioned one.'),
				reason: z.string().optional().describe('Why you need the connection, in a few words; shown to the user.'),
			}),
		},
		async (args, ctx) => {
			let result: ConnectResult;
			try {
				result = await deps.connect({ url: args.url, db: args.db, login: args.login, reason: args.reason }, ctx.mcpReq.signal);
			} catch (error) {
				return failure(error);
			}
			switch (result.status) {
				case 'declined':
					return withSummary(text('The user declined to connect to Odoo. Do not retry unless the user asks.'), { outcome: 'denied' });
				case 'failed':
					return failure(result.error);
				case 'connected': {
					const { client, name } = result;
					const { url, db, login } = client.connection;
					const version = client.version.serverVersion ? `Odoo ${client.version.serverVersion}, ` : '';
					return text(`Connected to database ${db} at ${url} as ${login} (${version}${client.protocolName}). Use connection "${name}".`);
				}
			}
		},
	);

	server.registerTool(
		'odoo_list_connections',
		{
			title: 'List open Odoo connections',
			description: 'Lists the Odoo connections open in this chat. Reuse one of them instead of calling odoo_connect again.',
			inputSchema: z.looseObject({}),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const open = deps.openConnections();
			return text(
				open.length
					? open.map(({ connection: c, protocolName }) => `${c.name}: database ${c.db} at ${c.url} as ${c.login} (${protocolName})`).join('\n')
					: 'No Odoo connection is open. Call odoo_connect.',
			);
		},
	);

	// ------------------------------------------------------------ metadata

	server.registerTool(
		'odoo_list_models',
		{
			title: 'List Odoo models',
			description: 'Lists the models of the Odoo database (technical name and label). Use it to find which model holds some data.',
			inputSchema: z.looseObject({ filter: z.string().optional().describe('Case-insensitive substring of the model name or label.'), connection: connectionArg }),
			annotations: { readOnlyHint: true },
		},
		async (args) =>
			run(deps, args.connection, async (client) => {
				const filter = (args.filter ?? '').toLowerCase();
				const models = (await client.listModels()).filter((m) => !filter || m.model.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter));
				return text(models.length ? models.slice(0, 500).map((m) => `${m.model} — ${m.name}`).join('\n') : 'No model matches that filter.');
			}),
	);

	server.registerTool(
		'odoo_get_fields',
		{
			title: 'Get Odoo model fields',
			description: 'Describes the fields of a model: name, type, label, and the target model of relations. Call it before writing domains or picking fields.',
			inputSchema: z.looseObject({ model: z.string().describe('Technical model name, e.g. res.partner.'), connection: connectionArg }),
			annotations: { readOnlyHint: true },
		},
		async (args) =>
			run(deps, args.connection, async (client) => {
				const fields = await client.fieldsGet(args.model);
				const lines = Object.entries(fields)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, info]) => `${name}: ${info.type}${info.relation ? ` → ${info.relation}` : ''} — ${info.string ?? ''}${info.store === false ? ' (not stored)' : ''}${info.required ? ' (required)' : ''}`);
				return text(lines.join('\n'));
			}),
	);

	// ------------------------------------------------------------ gated reads

	const approvalNote =
		' The user reviews the returned columns and values in the chat before anything reaches you, and may withhold columns; ' +
		'the result says which. Columns approved once stay approved for the rest of the chat.';

	registerAppTool(
		server,
		'odoo_search_read',
		{
			title: 'Search Odoo records',
			description:
				'Searches records of an Odoo model and returns the requested fields. The main way to read data.' + approvalNote +
				' Ask only for the fields you need.',
			inputSchema: z.looseObject({
				model: z.string().describe('Technical model name, e.g. res.partner.'),
				domain: domainArg,
				fields: z.array(z.string()).optional().describe('Field names to return. Omit for a default set of useful fields.'),
				limit: z.number().int().positive().optional().describe('Maximum records (capped by the user setting, default 200).'),
				offset: z.number().int().nonnegative().optional(),
				order: z.string().optional().describe('e.g. "create_date desc, id".'),
				context: z.record(z.string(), z.unknown()).optional().describe('Odoo context, e.g. {"lang": "fr_FR", "active_test": false}.'),
				connection: connectionArg,
			}),
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: VIEW_URI } },
		},
		async (args, ctx) =>
			gatedRead(deps, ui(), args, ctx, {
				model: args.model,
				method: 'search_read',
				request: { domain: args.domain ?? [], fields: args.fields, order: args.order, limit: args.limit, offset: args.offset, context: args.context },
				filterFields: [...domainFields(args.domain), ...orderFields(args.order)],
				fetch: async (client, fields) => {
					const maxRows = deps.settings().maxRows;
					return client.searchRead(args.model, args.domain ?? [], args.fields?.length ? args.fields : defaultFields(fields), {
						limit: Math.min(args.limit ?? maxRows, maxRows),
						offset: args.offset,
						order: args.order,
						context: args.context,
					});
				},
			}),
	);

	registerAppTool(
		server,
		'odoo_read',
		{
			title: 'Read Odoo records by id',
			description: 'Reads specific records by database id, e.g. ids from an earlier search.' + approvalNote,
			inputSchema: z.looseObject({
				model: z.string(),
				ids: z.array(z.number().int()).min(1),
				fields: z.array(z.string()).optional().describe('Field names to return. Omit for a default set.'),
				connection: connectionArg,
			}),
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: VIEW_URI } },
		},
		async (args, ctx) =>
			gatedRead(deps, ui(), args, ctx, {
				model: args.model,
				method: 'read',
				request: { ids: args.ids, fields: args.fields },
				filterFields: [],
				fetch: (client, fields) => client.read(args.model, args.ids.slice(0, deps.settings().maxRows), args.fields?.length ? args.fields : defaultFields(fields)),
			}),
	);

	registerAppTool(
		server,
		'odoo_read_group',
		{
			title: 'Group and aggregate Odoo records',
			description: 'Groups records and aggregates fields, like SQL GROUP BY. Prefer it to reading many rows for totals or counts.' + approvalNote,
			inputSchema: z.looseObject({
				model: z.string(),
				domain: domainArg,
				groupby: z.array(z.string()).min(1).describe('Fields to group by; dates accept ":day", ":week", ":month", ":quarter", ":year".'),
				aggregates: z.array(z.string()).optional().describe('e.g. ["amount_total:sum", "id:count"]. Each group always has __count.'),
				orderby: z.string().optional(),
				limit: z.number().int().positive().optional(),
				connection: connectionArg,
			}),
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: VIEW_URI } },
		},
		async (args, ctx) =>
			gatedRead(deps, ui(), args, ctx, {
				model: args.model,
				method: 'read_group',
				request: { domain: args.domain ?? [], groupby: args.groupby, aggregates: args.aggregates, orderby: args.orderby, limit: args.limit },
				filterFields: [...domainFields(args.domain), ...groupbyFields(args.groupby), ...orderFields(args.orderby)],
				fetch: async (client) => {
					const kwargs: Record<string, unknown> = { lazy: false, limit: Math.min(args.limit ?? deps.settings().maxRows, deps.settings().maxRows) };
					if (args.orderby) {
						kwargs.orderby = args.orderby;
					}
					const groups = asRows(await client.executeKw(args.model, 'read_group', [args.domain ?? [], args.aggregates ?? [], args.groupby], kwargs)) ?? [];
					// `__domain`, `__context` and friends are plumbing, not data.
					return groups.map((group) => Object.fromEntries(Object.entries(group).filter(([key]) => key === '__count' || !key.startsWith('__'))));
				},
			}),
	);

	// ------------------------------------------------------------ execute_kw

	if (deps.settings().enableExecuteKw) {
		registerAppTool(
			server,
			'odoo_execute_kw',
			{
				title: 'Call any Odoo method',
				description:
					'Calls any public model method through execute_kw, including ones that change data (create, write, unlink, action_*). ' +
					'Read methods run first and their result is reviewed like other reads. Every other call is shown to the user, ' +
					'who can drop fields from create/write values or deny it, before anything is sent to Odoo. Prefer the dedicated read tools.',
				inputSchema: z.looseObject({
					model: z.string(),
					method: z.string(),
					args: z.array(z.unknown()).optional().describe('Positional arguments, e.g. [[ids], {values}] for write.'),
					kwargs: z.record(z.string(), z.unknown()).optional(),
					connection: connectionArg,
				}),
				annotations: { destructiveHint: true },
				_meta: { ui: { resourceUri: VIEW_URI } },
			},
			async (args, ctx) => {
				const callArgs = args.args ?? [];
				const kwargs = args.kwargs ?? {};
				if (READ_METHODS.has(args.method)) {
					return gatedRead(deps, ui(), args, ctx, {
						model: args.model,
						method: args.method,
						request: { args: callArgs, kwargs },
						filterFields: domainFields(callArgs[0]),
						fetch: (client) => client.executeKw(args.model, args.method, callArgs, kwargs),
					});
				}
				return gatedWrite(deps, ui(), args, ctx, args.model, args.method, callArgs, kwargs);
			},
		);
	}

	// ------------------------------------------------------------ app-only

	const appOnly = { ui: { resourceUri: VIEW_URI, visibility: ['app'] as ('app' | 'model')[] } };

	registerAppTool(
		server,
		TOOL_PREVIEW,
		{
			description: 'App-only: the pending approval for this view.',
			inputSchema: z.object({ args: z.unknown().optional(), id: z.string().optional() }),
			_meta: appOnly,
		},
		async ({ args, id }) => {
			const preview = deps.broker.preview(deps.sessionId, { id, args });
			const response: PreviewResponse = preview
				? { status: 'pending', preview }
				: args !== undefined && deps.broker.isLoading(deps.sessionId, args)
					? { status: 'loading' }
					: { status: 'none' };
			if (response.status === 'none') {
				// Expected after an auto-approval; otherwise a sign the view got different arguments.
				deps.log(`View found no pending approval for ${id ? `id ${id}` : `args ${JSON.stringify(args)}`}`);
			}
			return structured(response as unknown as Record<string, unknown>);
		},
	);

	registerAppTool(
		server,
		TOOL_DECIDE,
		{
			description: 'App-only: records the user decision for a pending approval.',
			inputSchema: z.object({ id: z.string(), approved: z.boolean(), columns: z.array(z.string()) }),
			_meta: appOnly,
		},
		async ({ id, approved, columns }) => {
			const ok = deps.broker.decide(deps.sessionId, id, approved, columns);
			deps.log(`Approval ${id}: ${approved ? `approved ${columns.join(', ')}` : 'denied'}${ok ? '' : ' (nothing pending)'}`);
			return ok ? structured({ ok }) : { ...structured({ ok }), isError: true };
		},
	);

	registerAppTool(
		server,
		TOOL_RESET,
		{
			description: 'App-only: forgets the column approvals of this chat session.',
			inputSchema: z.object({}),
			_meta: appOnly,
		},
		async () => {
			const cleared = deps.store.snapshot(deps.sessionId).reduce((sum, row) => sum + row.approved.length + row.denied.length, 0);
			deps.store.reset(deps.sessionId);
			deps.log(`Reset ${cleared} column decisions for session ${deps.sessionId}`);
			return structured({ cleared });
		},
	);
}

// ---------------------------------------------------------------- helpers

function text(value: string): ToolResult {
	return { content: [{ type: 'text', text: value }] };
}

function structured(value: Record<string, unknown>): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function withSummary(result: ToolResult, summary: ResultSummary): ToolResult {
	return { ...result, _meta: { ...result._meta, [SUMMARY_META]: summary } };
}

function failure(error: unknown): ToolResult {
	const message = error instanceof OdooError ? error.describe() : (error as Error)?.message ?? String(error);
	return withSummary({ content: [{ type: 'text', text: message }], isError: true }, { outcome: 'error', message: error instanceof OdooError ? error.message : String(message) });
}

/** Runs against a client, re-prompting once for credentials on an auth failure. */
async function run(deps: ToolDeps, connection: string | undefined, body: (client: OdooClient) => Promise<ToolResult>): Promise<ToolResult> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await body(await deps.client(connection));
		} catch (error) {
			if (attempt === 0 && (await deps.onAuthFailure(connection, error))) {
				continue;
			}
			return failure(error);
		}
	}
}

function callContext(ctx: ServerContext): CallContext {
	return {
		signal: ctx.mcpReq.signal,
		progressToken: ctx.mcpReq._meta?.progressToken as string | number | undefined,
		notify: (notification) => ctx.mcpReq.notify(notification as Parameters<typeof ctx.mcpReq.notify>[0]),
		elicitInput: (params) => ctx.mcpReq.elicitInput(params as Parameters<typeof ctx.mcpReq.elicitInput>[0]) as ReturnType<CallContext['elicitInput']>,
	};
}

interface ReadSpec {
	model: string;
	method: string;
	request: Record<string, unknown>;
	filterFields: string[];
	fetch(client: OdooClient, fields: FieldsGetResult): Promise<unknown>;
}

/**
 * Fetch, then ask, then return only what was approved. A non-tabular result
 * (a count, a list of ids) is reviewed as a single `result` column.
 */
async function gatedRead(deps: ToolDeps, ui: ReturnType<typeof approvalUiFor>, args: Record<string, unknown> & { connection?: string }, ctx: ServerContext, spec: ReadSpec): Promise<ToolResult> {
	const endLoading = deps.broker.beginLoading(deps.sessionId, args);
	try {
		return await run(deps, args.connection, async (client) => {
			const fields = await client.fieldsGet(spec.model).catch(() => ({}) as FieldsGetResult);
			const raw = await spec.fetch(client, fields);
			const tabular = asRows(raw);
			const rows: OdooRecord[] = tabular ?? [{ result: raw }];
			const filterFields = [...new Set(spec.filterFields)];
			const request: ApprovalRequest = {
				sessionId: deps.sessionId,
				connection: client.connection.name,
				model: spec.model,
				method: spec.method,
				args,
				request: spec.request,
				write: false,
				rows,
				columns: columnsOf(rows, filterFields),
				filterFields,
				fields,
				previewRows: deps.settings().previewRows,
			};
			// `approve` registers the pending request synchronously, so the view
			// never sees a gap between "loading" and "pending".
			const pending = deps.gate.approve(request, ui, callContext(ctx));
			endLoading();
			const outcome = await pending;
			deps.log(`${spec.method} ${spec.model}: ${describeOutcome(outcome)}`);
			if (!outcome.approved) {
				return denial(outcome, ui);
			}
			const shared = project(rows, outcome.columns);
			const body = tabular ? shared : shared[0]?.result;
			const returned = outcome.columns.filter((name) => !filterFields.includes(name) || rows.some((row) => name in row));
			const lines = [
				tabular ? `${shared.length} ${spec.model} record(s). Columns: ${returned.join(', ') || 'id'}.` : `Result of ${spec.model}.${spec.method}:`,
				outcome.withheld.length ? `Withheld by the user (do not request these again unless the user asks): ${outcome.withheld.join(', ')}.` : '',
				tabular ? shared.map((row) => JSON.stringify(row)).join('\n') : JSON.stringify(body),
			];
			return withSummary(text(lines.filter(Boolean).join('\n')), {
				outcome: outcome.auto ? 'auto-approved' : 'approved',
				rows: shared.length,
				columns: outcome.columns,
				withheld: outcome.withheld,
			});
		});
	} finally {
		endLoading();
	}
}

/**
 * Nothing is sent to Odoo until the user approves. For create and write the
 * values are the columns, so dropping one removes it from the call.
 */
async function gatedWrite(
	deps: ToolDeps,
	ui: ReturnType<typeof approvalUiFor>,
	args: Record<string, unknown> & { connection?: string },
	ctx: ServerContext,
	model: string,
	method: string,
	callArgs: unknown[],
	kwargs: Record<string, unknown>,
): Promise<ToolResult> {
	if (ui === 'none') {
		return denial({ approved: false, auto: false, columns: [], withheld: [], reason: 'denied' }, ui);
	}
	const endLoading = deps.broker.beginLoading(deps.sessionId, args);
	try {
		return await run(deps, args.connection, async (client) => {
			const fields = await client.fieldsGet(model).catch(() => ({}) as FieldsGetResult);
			const shape = writeShape(method, callArgs, kwargs);
			const request: ApprovalRequest = {
				sessionId: deps.sessionId,
				connection: client.connection.name,
				model,
				method,
				args,
				request: shape.request,
				write: true,
				rows: shape.rows,
				columns: columnsOf(shape.rows),
				filterFields: [],
				fields,
				previewRows: deps.settings().previewRows,
				locked: shape.editable ? [] : columnsOf(shape.rows),
			};
			const pending = deps.gate.approve(request, ui, callContext(ctx));
			endLoading();
			const outcome = await pending;
			deps.log(`${method} ${model}: ${describeOutcome(outcome)}`);
			if (!outcome.approved) {
				return denial(outcome, ui);
			}
			const result = await client.executeKw(model, method, shape.rebuild(outcome.columns), kwargs);
			const note = outcome.withheld.length ? `The user removed these fields before sending: ${outcome.withheld.join(', ')}.\n` : '';
			return withSummary(text(`${note}${model}.${method} returned: ${JSON.stringify(result)}`), {
				outcome: 'approved',
				rows: shape.rows.length,
				columns: outcome.columns,
				withheld: outcome.withheld,
			});
		});
	} finally {
		endLoading();
	}
}

/** How a write call is shown as rows, and rebuilt from the approved columns. */
function writeShape(method: string, callArgs: unknown[], kwargs: Record<string, unknown>): {
	rows: OdooRecord[];
	request: Record<string, unknown>;
	editable: boolean;
	rebuild(columns: string[]): unknown[];
} {
	const pick = (values: OdooRecord, columns: string[]) => Object.fromEntries(Object.entries(values).filter(([key]) => columns.includes(key)));
	if (method === 'create' && callArgs.length >= 1) {
		const single = !Array.isArray(callArgs[0]);
		const list = (single ? [callArgs[0]] : callArgs[0]) as OdooRecord[];
		if (list.every((values) => values && typeof values === 'object')) {
			return {
				rows: list,
				request: { records: list.length, kwargs },
				editable: true,
				rebuild: (columns) => [single ? pick(list[0], columns) : list.map((values) => pick(values, columns)), ...callArgs.slice(1)],
			};
		}
	}
	if (method === 'write' && callArgs.length >= 2 && callArgs[1] && typeof callArgs[1] === 'object' && !Array.isArray(callArgs[1])) {
		const values = callArgs[1] as OdooRecord;
		return {
			rows: [values],
			request: { ids: callArgs[0], kwargs },
			editable: true,
			rebuild: (columns) => [callArgs[0], pick(values, columns), ...callArgs.slice(2)],
		};
	}
	// Any other method: show the raw arguments, approve or deny as a whole.
	return {
		rows: [{ args: JSON.stringify(callArgs), kwargs: JSON.stringify(kwargs) }],
		request: {},
		editable: false,
		rebuild: () => callArgs,
	};
}

function denial(outcome: GateOutcome, ui: ReturnType<typeof approvalUiFor>): ToolResult {
	if (ui === 'none') {
		return withSummary(
			{
				content: [{ type: 'text', text: 'This MCP client cannot display Odoo approvals (it supports neither MCP Apps nor elicitation), so no data can be shared.' }],
				isError: true,
			},
			{ outcome: 'error', message: 'No approval UI available.' },
		);
	}
	const why = outcome.reason === 'expired' ? 'The approval request expired without an answer.' : outcome.reason === 'cancelled' ? 'The request was cancelled.' : 'The user denied this request.';
	return withSummary(text(`${why} Nothing was shared or sent. Do not retry the same request unless the user asks.`), {
		outcome: outcome.reason === 'expired' ? 'expired' : outcome.reason === 'cancelled' ? 'cancelled' : 'denied',
	});
}

function describeOutcome(outcome: GateOutcome): string {
	if (!outcome.approved) {
		return outcome.reason ?? 'denied';
	}
	return `${outcome.auto ? 'auto-approved' : 'approved'} [${outcome.columns.join(', ')}]${outcome.withheld.length ? `, withheld [${outcome.withheld.join(', ')}]` : ''}`;
}
