/**
 * The in-chat approval view. It finds the pending request for its tool call,
 * shows the real rows with a checkbox per column, and posts the decision
 * through app-only tools. The rows shown here never reach the model unless
 * the user approves their columns.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import {
	DecideArgs,
	Preview,
	PreviewColumn,
	PreviewResponse,
	ResultSummary,
	SUMMARY_META,
	TOOL_DECIDE,
	TOOL_PREVIEW,
	TOOL_RESET,
} from './protocol';
import './approval.css';

type Phase =
	| { kind: 'connecting' }
	| { kind: 'loading' }
	| { kind: 'review'; preview: Preview; selected: Set<string>; busy: boolean; error?: string }
	| { kind: 'done'; summary: ResultSummary }
	| { kind: 'idle'; message: string };

const root = document.getElementById('app')!;
let phase: Phase = { kind: 'connecting' };
let resetNote = '';

const app = new App({ name: 'odoo-inspector-approval', version: '1' });

app.ontoolinput = (params) => void loadPreview({ args: params.arguments ?? {} });
app.ontoolresult = (params) => {
	const summary = (params._meta as Record<string, unknown> | undefined)?.[SUMMARY_META] as ResultSummary | undefined;
	if (summary) {
		set({ kind: 'done', summary });
	} else if (phase.kind !== 'review') {
		set({ kind: 'idle', message: params.isError ? 'The tool call failed.' : 'Finished.' });
	}
};
app.ontoolcancelled = () => {
	if (phase.kind !== 'done') {
		set({ kind: 'done', summary: { outcome: 'cancelled' } });
	}
};
app.onhostcontextchanged = (context) => applyContext(context);

function applyContext(context: McpUiHostContext | undefined): void {
	if (context?.theme) {
		applyDocumentTheme(context.theme);
	}
	if (context?.styles?.variables) {
		applyHostStyleVariables(context.styles.variables);
	}
	if (context?.styles?.css?.fonts) {
		applyHostFonts(context.styles.css.fonts);
	}
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const result = await app.callServerTool({ name, arguments: args });
	if (result.isError) {
		throw new Error(textOf(result.content) || `${name} failed`);
	}
	return (result.structuredContent ?? JSON.parse(textOf(result.content))) as T;
}

function textOf(content: unknown): string {
	return Array.isArray(content) ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('') : '';
}

/**
 * The server is usually still fetching from Odoo (rate-limited, plus
 * `fields_get`) when the view starts, so poll with a gentle backoff.
 */
async function loadPreview(lookup: { args?: unknown; id?: string }): Promise<void> {
	set({ kind: 'loading' });
	const deadline = Date.now() + 120_000;
	let delay = 250;
	while (Date.now() < deadline) {
		let response: PreviewResponse;
		try {
			response = await callTool<PreviewResponse>(TOOL_PREVIEW, lookup);
		} catch (error) {
			set({ kind: 'idle', message: `Could not load the preview: ${(error as Error).message}` });
			return;
		}
		if (phase.kind === 'done') {
			return;
		}
		if (response.status === 'pending') {
			// Start from the previous decision: withheld columns stay unticked.
			const selected = new Set(response.preview.columns.filter((column) => column.locked || column.status !== 'denied').map((column) => column.name));
			set({ kind: 'review', preview: response.preview, selected, busy: false });
			return;
		}
		if (response.status === 'none') {
			// Auto-approved or already settled; the tool result will say which.
			set({ kind: 'idle', message: 'No review needed.' });
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 1.5, 2000);
	}
	set({ kind: 'idle', message: 'Timed out waiting for the query.' });
}

async function decide(approved: boolean, all = false): Promise<void> {
	if (phase.kind !== 'review' || phase.busy) {
		return;
	}
	const { preview } = phase;
	const columns = all ? preview.columns.map((column) => column.name) : [...phase.selected];
	set({ ...phase, busy: true, error: undefined });
	try {
		const args: DecideArgs = { id: preview.id, approved, columns };
		await callTool(TOOL_DECIDE, args as unknown as Record<string, unknown>);
		const withheld = preview.columns.map((column) => column.name).filter((name) => !columns.includes(name));
		set({ kind: 'done', summary: approved ? { outcome: 'approved', rows: preview.rowCount, columns, withheld } : { outcome: 'denied' } });
	} catch (error) {
		set({ ...phase, busy: false, error: (error as Error).message });
	}
}

async function resetApprovals(): Promise<void> {
	try {
		const result = await callTool<{ cleared: number }>(TOOL_RESET, {});
		resetNote = `Cleared ${result.cleared} remembered column decision${result.cleared === 1 ? '' : 's'} for this chat session.`;
	} catch (error) {
		resetNote = `Reset failed: ${(error as Error).message}`;
	}
	render();
}

function set(next: Phase): void {
	phase = next;
	render();
}

// ---------------------------------------------------------------- rendering

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, value);
	}
	for (const child of children) {
		if (child !== null && child !== undefined) {
			node.append(child);
		}
	}
	return node;
}

function render(): void {
	root.replaceChildren(...view());
}

function view(): Node[] {
	switch (phase.kind) {
		case 'connecting':
		case 'loading':
			return [el('p', { class: 'muted' }, phase.kind === 'connecting' ? 'Connecting…' : 'Fetching the records to review…')];
		case 'idle':
			return [el('p', { class: 'muted' }, phase.message), resetLine()];
		case 'done':
			return [summaryView(phase.summary), resetLine()];
		case 'review':
			return reviewView(phase);
	}
}

function summaryView(summary: ResultSummary): Node {
	switch (summary.outcome) {
		case 'approved':
		case 'auto-approved': {
			const sent = summary.columns?.length ?? 0;
			const line = `${summary.outcome === 'auto-approved' ? 'Auto-approved (all columns approved earlier)' : 'Approved'}: ${summary.rows ?? 0} row${summary.rows === 1 ? '' : 's'} × ${sent} column${sent === 1 ? '' : 's'} sent to the model.`;
			return el(
				'div',
				{ class: 'summary ok' },
				el('p', {}, line),
				summary.columns?.length ? el('p', { class: 'muted' }, `Sent: ${summary.columns.join(', ')}`) : null,
				summary.withheld?.length ? el('p', { class: 'muted' }, `Withheld: ${summary.withheld.join(', ')}`) : null,
			);
		}
		case 'denied':
			return el('div', { class: 'summary bad' }, el('p', {}, 'Denied. Nothing was sent to the model.'));
		case 'expired':
			return el('div', { class: 'summary bad' }, el('p', {}, 'The approval expired. Nothing was sent to the model.'));
		case 'cancelled':
			return el('div', { class: 'summary bad' }, el('p', {}, 'Cancelled. Nothing was sent to the model.'));
		case 'error':
			return el('div', { class: 'summary bad' }, el('p', {}, summary.message ?? 'The query failed.'));
	}
}

function resetLine(): Node {
	const button = el('button', { class: 'link' }, 'Reset approvals for this chat');
	button.onclick = () => void resetApprovals();
	return el('p', { class: 'reset' }, button, resetNote ? el('span', { class: 'muted' }, ` ${resetNote}`) : null);
}

function reviewView(state: Extract<Phase, { kind: 'review' }>): Node[] {
	const { preview, selected, busy } = state;
	const verb = preview.write ? `${preview.method} on` : `${preview.method} from`;
	const header = el(
		'div',
		{ class: 'header' },
		el('div', { class: 'title' }, el('strong', {}, `${verb} ${preview.model}`), el('span', { class: 'muted' }, ` · ${preview.connection}`)),
		requestLine(preview),
		el(
			'p',
			{ class: 'muted' },
			preview.write
				? 'These values will be sent to Odoo. Untick a field to leave it out of the call.'
				: `${preview.rowCount} row${preview.rowCount === 1 ? '' : 's'}${preview.rows.length < preview.rowCount ? ` (showing ${preview.rows.length})` : ''}. Untick a column to withhold it from the model.`,
		),
	);

	const table = el('table');
	const headRow = el('tr');
	for (const column of preview.columns) {
		headRow.append(columnHeader(column, selected.has(column.name)));
	}
	table.append(el('thead', {}, headRow));
	const body = el('tbody');
	for (const row of preview.rows) {
		const tr = el('tr');
		for (const column of preview.columns) {
			const value = column.filterOnly ? '' : formatValue(row[column.name], column.type);
			tr.append(el('td', { class: selected.has(column.name) ? '' : 'off', title: value.length > 80 ? value : '' }, column.filterOnly ? el('span', { class: 'muted' }, 'filter only') : truncate(value)));
		}
		body.append(tr);
	}
	table.append(body);

	const chosen = selected.size;
	const approve = el('button', { class: 'primary' }, preview.write ? `Send ${chosen} field${chosen === 1 ? '' : 's'}` : `Approve ${chosen} column${chosen === 1 ? '' : 's'}`);
	approve.onclick = () => void decide(true);
	const approveAll = el('button', {}, preview.write ? 'Send all' : 'Approve all');
	approveAll.onclick = () => void decide(true, true);
	const deny = el('button', { class: 'danger' }, 'Deny');
	deny.onclick = () => void decide(false);
	for (const button of [approve, approveAll, deny]) {
		button.toggleAttribute('disabled', busy);
	}

	return [
		header,
		el('div', { class: 'table-wrap' }, table),
		el('div', { class: 'actions' }, approve, approveAll, deny, busy ? el('span', { class: 'muted' }, 'Sending…') : null),
		state.error ? el('p', { class: 'error' }, state.error) : null,
		preview.write ? null : el('p', { class: 'muted small' }, 'Your choice is remembered for this model for the rest of the chat; columns you approve will not be asked about again.'),
		preview.write ? null : resetLine(),
	].filter((node): node is HTMLElement => node !== null);
}

function requestLine(preview: Preview): Node | null {
	const parts = Object.entries(preview.request)
		.filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
	return parts.length ? el('p', { class: 'request mono' }, parts.join(' · ')) : null;
}

function columnHeader(column: PreviewColumn, checked: boolean): HTMLElement {
	const box = el('input', { type: 'checkbox' });
	box.checked = checked;
	box.disabled = column.locked;
	box.onchange = () => toggle(column.name, box.checked);
	const badges = [
		column.status === 'approved' && !column.locked ? el('span', { class: 'badge approved' }, 'approved') : null,
		column.status === 'denied' ? el('span', { class: 'badge denied' }, 'withheld before') : null,
		column.status === 'new' ? el('span', { class: 'badge new' }, 'new') : null,
		column.usedInFilter ? el('span', { class: 'badge filter', title: 'Used in the domain, order or grouping: filtering on it can reveal its values.' }, 'filter') : null,
	];
	const label = el('label', { title: `${column.name} (${column.type})` }, box, el('span', { class: 'name' }, column.label), el('span', { class: 'tech mono' }, column.name));
	return el('th', { class: checked ? '' : 'off' }, label, el('div', { class: 'badges' }, ...badges));
}

function toggle(name: string, on: boolean): void {
	if (phase.kind !== 'review') {
		return;
	}
	const selected = new Set(phase.selected);
	if (on) {
		selected.add(name);
	} else {
		selected.delete(name);
	}
	set({ ...phase, selected });
}

function formatValue(value: unknown, type: string): string {
	if (value === false && type !== 'boolean') {
		return '';
	}
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'boolean') {
		return value ? '✓' : '✗';
	}
	// many2one: [id, display name]
	if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string') {
		return value[1];
	}
	if (Array.isArray(value)) {
		return value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ');
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function truncate(value: string): string {
	return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}

render();
app
	.connect()
	.then(() => {
		applyContext(app.getHostContext());
		if (phase.kind === 'connecting') {
			set({ kind: 'loading' });
		}
	})
	.catch((error: Error) => set({ kind: 'idle', message: `Could not connect to the chat host: ${error.message}` }));
