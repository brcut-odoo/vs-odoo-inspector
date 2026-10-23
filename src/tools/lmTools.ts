import * as vscode from 'vscode';
import { OdooError, QuerySpec } from '../odoo/types';
import { ConnectionManager } from '../ui/connectionManager';
import { WorkbenchPanel } from '../ui/workbench/panel';
import { getMaxRows, getQueryGateMode, isMethodCallsEnabled } from '../config/settings';
import { createTools, GatedResult, ToolContext, ToolDefinition } from './registry';

/** Methods that never mutate data, used by the `writes-only` gate mode. */
const READ_ONLY_METHODS = new Set([
	'search_read',
	'search',
	'search_count',
	'read',
	'fields_get',
	'name_search',
]);

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
	 */
	private async gate(spec: QuerySpec): Promise<GatedResult | undefined> {
		if (!shouldGate(spec.method)) {
			return undefined;
		}
		const client = await this.connections.requireClient();
		const result = await WorkbenchPanel.open(
			{ client, spec, editable: true },
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
		return !READ_ONLY_METHODS.has(method);
	}
	return true;
}
