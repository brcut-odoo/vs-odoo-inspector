import * as vscode from 'vscode';
import { OdooClient } from '../odoo/client';
import { OdooError, QuerySpec } from '../odoo/types';
import { ConnectionManager } from '../ui/connectionManager';
import { WorkbenchPanel } from '../ui/workbench/panel';
import { PreviewMeta } from '../ui/workbench/protocol';
import { getMaxRows, getQueryGateMode, isMethodCallsEnabled } from '../config/settings';
import { isReadOnlyMethod } from '../query/spec';
import { createTools, GatedResult, ToolContext, ToolDefinition } from './registry';

/**
 * Bridges the framework-agnostic tool registry to `vscode.lm.registerTool`.
 *
 * The gate is implemented by opening the Query Workbench and awaiting the
 * user's Execute/Cancel decision.
 */
export class LmToolAdapter implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly connections: ConnectionManager,
		private readonly extensionUri: vscode.Uri,
	) {
		for (const tool of createTools()) {
			this.disposables.push(
				vscode.lm.registerTool(tool.name, new RegistryTool(tool, () => this.buildContext())),
			);
		}
	}

	/** Builds a fresh context per invocation, resolving the client lazily. */
	private async buildContext(): Promise<ToolContext> {
		const client = await this.connections.requireClient();
		return {
			client,
			maxRows: getMaxRows(),
			gate: (spec) => this.gate(spec),
		};
	}

	/**
	 * Opens the workbench and waits for the user to execute or cancel.
	 *
	 * The workbench runs the query itself when the user clicks Execute, so the
	 * rows come back from the gate rather than being fetched again.
	 *
	 * Read-only queries are sampled first so the review table is not empty:
	 * the user sees the real records before approving anything. `call` is
	 * excluded because its side effects are unknown, and a failed preview is
	 * ignored rather than blocking the review.
	 */
	private async gate(spec: QuerySpec): Promise<GatedResult | undefined> {
		if (!shouldGate(spec.method)) {
			return undefined;
		}
		const client = await this.connections.requireClient();
		const preview = isReadOnlyMethod(spec.method)
			? await loadPreview(client, spec, getMaxRows())
			: undefined;
		const result = await WorkbenchPanel.open(
			{
				client,
				spec,
				editable: true,
				rows: preview?.rows,
				preview: preview?.meta,
			},
			this.extensionUri,
		);
		return result.kind === 'execute'
			? { spec: result.spec, rows: result.rows }
			: undefined;
	}

	dispose(): void {
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}

/**
 * A single registered tool.
 *
 * `invoke` resolves the client lazily so a tool call can trigger the
 * connection flow.
 */
class RegistryTool implements vscode.LanguageModelTool<Record<string, unknown>> {
	constructor(
		private readonly definition: ToolDefinition,
		private readonly getContext: () => Promise<ToolContext>,
	) {}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
	): Promise<vscode.PreparedToolInvocation> {
		const input = options.input ?? {};
		const summary = summarizeInput(this.definition.name, input);

		return {
			invocationMessage: `Querying Odoo: ${summary}`,
			confirmationMessages: this.definition.readOnly
				? undefined
				: {
						title: `Run ${this.definition.title}?`,
						message: new vscode.MarkdownString(
							`This will call **${summary}** on the Odoo database.\n\n` +
								'```json\n' +
								JSON.stringify(input, null, 2) +
								'\n```',
						),
					},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		if (this.definition.name === 'odoo_call_method' && !isMethodCallsEnabled()) {
			throw new Error(
				'odoo_call_method is disabled. Ask the user to enable "odooInspector.enableArbitraryMethodCalls" ' +
					'in settings, or use the dedicated read tools instead.',
			);
		}

		if (token.isCancellationRequested) {
			throw new Error('The query was cancelled.');
		}

		try {
			const context = await this.getContext();
			const result = await this.definition.run(options.input ?? {}, context);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(result.text),
			]);
		} catch (error) {
			if (error instanceof OdooError) {
				throw new Error(`${error.message}\n\nHint: ${error.hint}`);
			}
			throw error;
		}
	}
}

/** A short description of the call, used in progress and confirmation UI. */
function summarizeInput(name: string, input: Record<string, unknown>): string {
	const model = typeof input.model === 'string' ? input.model : '?';
	switch (name) {
		case 'odoo_list_models':
			return input.filter ? `models matching "${input.filter}"` : 'all models';
		case 'odoo_get_fields':
			return `fields of ${model}`;
		case 'odoo_search_read': {
			const domain = Array.isArray(input.domain) ? JSON.stringify(input.domain) : '[]';
			return `search_read on ${model} with domain ${domain}`;
		}
		case 'odoo_read_records': {
			const ids = Array.isArray(input.ids) ? input.ids.join(', ') : '?';
			return `read ${model} ids ${ids}`;
		}
		case 'odoo_count_records':
			return `count ${model}`;
		case 'odoo_call_method':
			return `${model}.${String(input.method ?? '?')}`;
		default:
			return name;
	}
}

/** Gate mode helper, exported for the MCP server which has no editor. */
export function shouldGate(method: string): boolean {
	const mode = getQueryGateMode();
	if (mode === 'never') {
		return false;
	}
	if (mode === 'writes-only') {
		return !isReadOnlyMethod(method);
	}
	return true;
}

/** A sample of the records a spec would return, for the review table. */
interface Preview {
	rows: Record<string, unknown>[];
	meta: PreviewMeta;
}

/**
 * Fetches the rows a read-only spec would return, so the user can see them
 * while still reviewing the query.
 *
 * Only the user's requested fields are fetched — not the whole default column
 * set — so the columns the user is about to exclude genuinely render as
 * "not requested" instead of showing values that were pulled anyway.
 *
 * A failed preview never blocks the gate: it reports `executed: false` and the
 * workbench says the sample was unavailable. The query stays reviewable,
 * because a preview is a convenience rather than the approval itself.
 */
async function loadPreview(
	client: OdooClient,
	spec: QuerySpec,
	maxRows: number,
): Promise<Preview> {
	// Never fetch more than the review table can usefully show, and never
	// more than the user's own limit.
	const limit = Math.min(spec.limit ?? maxRows, maxRows);

	try {
		const rows = await runPreviewQuery(client, { ...spec, limit });
		return { rows, meta: { shown: rows.length, limit, executed: true } };
	} catch {
		return { rows: [], meta: { shown: 0, limit, executed: false } };
	}
}

/**
 * Executes a preview against the client.
 *
 * Mirrors `WorkbenchPanel.runQuery`, but keeps only what the review table can
 * show. Unlike the real execution it never calls the generic `call` path.
 */
async function runPreviewQuery(
	client: OdooClient,
	spec: QuerySpec,
): Promise<Record<string, unknown>[]> {
	const fields = spec.fields?.length ? spec.fields : undefined;
	const options = {
		limit: spec.limit,
		offset: spec.offset,
		order: spec.order,
		context: spec.context,
	};

	switch (spec.method) {
		case 'search_read':
			return client.searchRead(spec.model, spec.domain ?? [], fields, options);
		case 'search': {
			const ids = await client.search(spec.model, spec.domain ?? []);
			return ids.map((id) => ({ id }));
		}
		case 'read':
			return client.read(spec.model, spec.ids ?? [], spec.fields);
		case 'search_count': {
			const count = await client.count(spec.model, spec.domain ?? []);
			return [{ count }];
		}
		case 'name_search': {
			const pairs = await client.nameSearch(spec.model, spec.name ?? '', {
				domain: spec.domain,
				limit: spec.limit,
			});
			return pairs.map(([id, name]) => ({ id, name }));
		}
		case 'fields_get': {
			const result = await client.fieldsGet(spec.model);
			return Object.entries(result).map(([name, info]) => ({
				name,
				type: info.type,
				label: info.string,
			}));
		}
		default:
			// Only read-only methods reach here; `call` has unknown side effects
			// and must never be previewed.
			return [];
	}
}
