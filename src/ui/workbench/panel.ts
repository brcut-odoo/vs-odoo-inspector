import * as vscode from 'vscode';
import { FieldsGetResult, OdooError, QuerySpec } from '../../odoo/types';
import { OdooClient } from '../../odoo/client';
import { buildColumns, Column, toggleColumn } from '../../query/columns';
import { normalizeSpec } from '../../query/spec';
import { formatIssues, validateSpec } from '../../query/validate';
import { HostMessage, isWebviewMessage, PreviewMeta, ResultMeta } from './protocol';

export interface WorkbenchOptions {
	client: OdooClient;
	/** The proposed query. */
	spec: QuerySpec;
	/** Pre-fetched field metadata; fetched on demand when omitted. */
	fields?: FieldsGetResult;
	/** Whether the user may edit and execute. */
	editable?: boolean;
	/** Rows to show immediately, if any. */
	rows?: Record<string, unknown>[];
	/** Set when `rows` is a pre-execution sample rather than a result. */
	preview?: PreviewMeta;
	/** Title suffix, e.g. the model name. */
	title?: string;
}

/** What the gate resolved to. */
export type GateResult =
	| { kind: 'execute'; spec: QuerySpec; rows: Record<string, unknown>[]; meta: ResultMeta }
	| { kind: 'cancel' };

/**
 * The Query Workbench: a webview that is both the request editor and the
 * result viewer.
 *
 * Columns are the fields that would be returned. Clicking a header toggles
 * that field's inclusion in the request. Executing sends the spec built from
 * the *current* column selection, then renders the rows in place.
 */
export class WorkbenchPanel {
	private static current: WorkbenchPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private spec: QuerySpec;
	private fields: FieldsGetResult;
	private columns: Column[];
	private rows: Record<string, unknown>[];
	private meta?: ResultMeta;
	/** Set while `rows` is a pre-execution sample; cleared by `execute`. */
	private preview?: PreviewMeta;
	/** The spec the sample was fetched for, so Execute can reuse it. */
	private previewSpec?: string;
	private resolver?: (result: GateResult) => void;
	private abortController?: AbortController;

	private constructor(
		private readonly options: WorkbenchOptions,
		extensionUri: vscode.Uri,
	) {
		this.spec = normalizeSpec(options.spec);
		this.fields = options.fields ?? {};
		this.columns = buildColumns(this.fields, this.spec);
		this.rows = options.rows ?? [];
		this.preview = options.preview;
		this.previewSpec = options.preview ? specKey(this.spec) : undefined;

		this.panel = vscode.window.createWebviewPanel(
			'odooInspector.workbench',
			`Odoo Query: ${options.title ?? this.spec.model}`,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
			},
		);

		this.panel.webview.html = this.renderHtml(extensionUri);
		this.panel.webview.onDidReceiveMessage(
			(message) => void this.onMessage(message),
			undefined,
			this.disposables,
		);
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
	}

	/**
	 * Opens (or reuses) the workbench and resolves once the user executes or
	 * cancels.
	 */
	static async open(
		options: WorkbenchOptions,
		extensionUri: vscode.Uri,
	): Promise<GateResult> {
		WorkbenchPanel.current?.dispose();

		const panel = new WorkbenchPanel(options, extensionUri);
		WorkbenchPanel.current = panel;

		// Fetch field metadata if the caller did not supply it.
		if (!options.fields) {
			try {
				panel.fields = await options.client.fieldsGet(panel.spec.model);
				panel.columns = buildColumns(panel.fields, panel.spec);
			} catch (error) {
				panel.post({
					type: 'error',
					message: (error as Error).message,
					hint: error instanceof OdooError ? error.hint : undefined,
				});
			}
		}

		panel.postInit();
		return panel.waitForGate();
	}

	/** Opens the workbench without waiting for a gate decision. */
	static show(options: WorkbenchOptions, extensionUri: vscode.Uri): WorkbenchPanel {
		WorkbenchPanel.current?.dispose();
		const panel = new WorkbenchPanel(options, extensionUri);
		WorkbenchPanel.current = panel;
		panel.postInit();
		return panel;
	}

	private waitForGate(): Promise<GateResult> {
		return new Promise<GateResult>((resolve) => {
			this.resolver = resolve;
		});
	}

	private postInit(): void {
		this.post({
			type: 'init',
			spec: this.spec,
			columns: this.columns,
			rows: this.rows,
			meta: this.meta,
			preview: this.preview,
			editable: this.options.editable !== false,
		});
	}

	private async onMessage(raw: unknown): Promise<void> {
		if (!isWebviewMessage(raw)) {
			return;
		}

		switch (raw.type) {
			case 'ready':
				this.postInit();
				break;

			case 'toggleColumn': {
				this.spec = toggleColumn(this.spec, raw.field, raw.enabled, this.fields);
				this.columns = buildColumns(this.fields, this.spec);
				this.post({ type: 'columns', columns: this.columns });
				break;
			}

			case 'sort': {
				const direction = raw.direction === 'asc' ? '' : ' desc';
				this.spec = { ...this.spec, order: `${raw.field}${direction}` };
				this.post({ type: 'spec', spec: this.spec });
				break;
			}

			case 'execute':
				await this.execute(raw.spec);
				break;

			case 'cancel':
				this.resolveGate({ kind: 'cancel' });
				break;

			case 'addColumn': {
				this.spec = toggleColumn(this.spec, raw.field, true, this.fields);
				this.columns = buildColumns(this.fields, this.spec);
				this.post({ type: 'columns', columns: this.columns });
				break;
			}

			case 'openAdvanced':
				await this.openAdvanced();
				break;

			case 'copyJson':
				await vscode.env.clipboard.writeText(JSON.stringify(this.rows, null, 2));
				void vscode.window.showInformationMessage('Results copied to the clipboard.');
				break;
		}
	}

	/** Runs the query with the spec the webview sent, then renders the rows. */
	private async execute(incoming: QuerySpec): Promise<void> {
		this.spec = normalizeSpec(incoming);

		const issues = validateSpec(this.spec, this.fields).filter(
			(issue) => issue.severity === 'error',
		);
		if (issues.length > 0) {
			this.post({
				type: 'error',
				message: `The query is invalid:\n${formatIssues(issues)}`,
				hint: 'Fix the highlighted fields, or use Advanced (JSON) to edit the raw query.',
			});
			return;
		}

		// When the user approves the query exactly as it was sampled, the
		// sample *is* the result. Re-running it would double every request
		// against a 1 req/s throttle for an identical answer.
		if (this.canReuseSample()) {
			this.meta = this.buildMeta(this.rows, 0);
			this.dropSample();
			// The `results` message clears the preview banner in the webview.
			this.post({ type: 'results', rows: this.rows, columns: this.columns, meta: this.meta });
			this.resolveGate({ kind: 'execute', spec: this.spec, rows: this.rows, meta: this.meta });
			return;
		}

		this.post({ type: 'busy', busy: true });
		this.abortController = new AbortController();
		const started = Date.now();

		try {
			const rows = await this.runQuery(this.spec, this.abortController.signal);
			this.rows = rows;
			this.meta = this.buildMeta(rows, Date.now() - started);
			this.columns = buildColumns(this.fields, this.spec);
			this.dropSample();
			this.post({ type: 'results', rows, columns: this.columns, meta: this.meta });
			this.resolveGate({ kind: 'execute', spec: this.spec, rows, meta: this.meta });
		} catch (error) {
			if (isAbort(error)) {
				this.post({ type: 'busy', busy: false });
				return;
			}
			this.post({
				type: 'error',
				message: (error as Error).message,
				hint: error instanceof OdooError ? error.hint : undefined,
			});
		} finally {
			this.abortController = undefined;
		}
	}

	/**
	 * Whether the sample already covers what the current spec asks for.
	 *
	 * The sample is only valid when the spec is unchanged *and* the requested
	 * limit does not exceed what was sampled; otherwise the real query would
	 * return more rows than the table is holding.
	 */
	private canReuseSample(): boolean {
		if (!this.preview?.executed || this.previewSpec !== specKey(this.spec)) {
			return false;
		}
		return (this.spec.limit ?? 0) <= this.preview.limit;
	}

	/**
	 * Forgets the sample, because the visible rows are now a real result.
	 *
	 * The panel stays open after approval, so without this a second Approve
	 * would keep serving the stale sample.
	 */
	private dropSample(): void {
		this.preview = undefined;
		this.previewSpec = undefined;
	}

	private buildMeta(rows: Record<string, unknown>[], elapsedMs: number): ResultMeta {
		return {
			rowCount: rows.length,
			elapsedMs,
			apiMode: this.options.client.apiMode ?? 'unknown',
			model: this.spec.model,
			truncated: Boolean(this.spec.limit && rows.length >= this.spec.limit),
		};
	}

	private async runQuery(
		spec: QuerySpec,
		signal: AbortSignal,
	): Promise<Record<string, unknown>[]> {
		const client = this.options.client;
		switch (spec.method) {
			case 'search_read':
				return client.searchRead(
					spec.model,
					spec.domain ?? [],
					spec.fields?.length ? spec.fields : undefined,
					{ limit: spec.limit, offset: spec.offset, order: spec.order, context: spec.context },
					signal,
				);
			case 'read':
				return client.read(spec.model, spec.ids ?? [], spec.fields, signal);
			case 'search': {
				const ids = await client.search(spec.model, spec.domain ?? [], signal);
				return ids.map((id) => ({ id }));
			}
			case 'search_count': {
				const count = await client.count(spec.model, spec.domain ?? [], signal);
				return [{ count }];
			}
			case 'fields_get': {
				const fields = await client.fieldsGet(spec.model, signal);
				return Object.entries(fields).map(([name, info]) => ({
					name,
					type: info.type,
					label: info.string,
					required: info.required,
					store: info.store,
				}));
			}
			case 'name_search': {
				const pairs = await client.nameSearch(
					spec.model,
					spec.name ?? '',
					{ domain: spec.domain, limit: spec.limit },
					signal,
				);
				return pairs.map(([id, name]) => ({ id, name }));
			}
			default: {
				const result = await client.call(spec, signal);
				return Array.isArray(result) ? (result as Record<string, unknown>[]) : [{ result }];
			}
		}
	}

	/** Opens the raw spec in a JSON editor and applies the result on save. */
	private async openAdvanced(): Promise<void> {
		const document = await vscode.workspace.openTextDocument({
			language: 'json',
			content: JSON.stringify(this.spec, null, 2),
		});
		await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);

		const applied = await vscode.window.showInformationMessage(
			'Edit the query, then apply it to the workbench.',
			'Apply',
			'Discard',
		);
		if (applied !== 'Apply') {
			return;
		}

		try {
			const parsed = JSON.parse(document.getText()) as QuerySpec;
			this.spec = normalizeSpec(parsed);
			this.columns = buildColumns(this.fields, this.spec);
			// The sample was fetched for the old spec and no longer describes
			// what Execute would send.
			if (this.previewSpec !== specKey(this.spec)) {
				this.preview = undefined;
				this.previewSpec = undefined;
				this.rows = [];
			}
			this.post({ type: 'spec', spec: this.spec });
			this.post({ type: 'columns', columns: this.columns });
			this.post({ type: 'preview', preview: this.preview, rows: this.rows });
		} catch (error) {
			void vscode.window.showErrorMessage(`Invalid query JSON: ${(error as Error).message}`);
		}
	}

	private resolveGate(result: GateResult): void {
		const resolver = this.resolver;
		this.resolver = undefined;
		resolver?.(result);
	}

	private post(message: HostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private renderHtml(extensionUri: vscode.Uri): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'workbench.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'workbench.css'),
		);
		const nonce = createNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Odoo Query</title>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private dispose(): void {
		WorkbenchPanel.current = undefined;
		this.abortController?.abort();
		this.resolveGate({ kind: 'cancel' });
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
		this.panel.dispose();
	}
}

/**
 * A stable key for comparing specs.
 *
 * `JSON.stringify` preserves insertion order, so the fields are listed
 * explicitly to make the comparison independent of how the spec was built.
 */
function specKey(spec: QuerySpec): string {
	return JSON.stringify([
		spec.model,
		spec.method,
		spec.rawMethod ?? null,
		spec.domain ?? [],
		spec.fields ?? [],
		spec.limit ?? null,
		spec.offset ?? null,
		spec.order ?? null,
		spec.context ?? null,
		spec.ids ?? [],
		spec.name ?? null,
	]);
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function isAbort(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: string }).name === 'AbortError'
	);
}
