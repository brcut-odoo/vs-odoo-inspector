import { Column } from '../../query/columns';
import { QuerySpec } from '../../odoo/types';
import { HostMessage, ResultMeta, WebviewMessage } from './protocol';

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface State {
	spec: QuerySpec;
	columns: Column[];
	rows: Record<string, unknown>[];
	meta?: ResultMeta;
	editable: boolean;
	busy: boolean;
	sortField?: string;
	sortDirection: 'asc' | 'desc';
	error?: { message: string; hint?: string };
}

const state: State = {
	spec: { model: '', method: 'search_read' },
	columns: [],
	rows: [],
	editable: true,
	busy: false,
	sortDirection: 'asc',
};

const root = document.getElementById('app')!;

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case 'init':
			state.spec = message.spec as State['spec'];
			state.columns = message.columns;
			state.rows = message.rows;
			state.meta = message.meta;
			state.editable = message.editable;
			state.error = undefined;
			render();
			break;
		case 'results':
			state.rows = message.rows;
			state.columns = message.columns;
			state.meta = message.meta;
			state.error = undefined;
			state.busy = false;
			render();
			break;
		case 'columns':
			state.columns = message.columns;
			render();
			break;
		case 'busy':
			state.busy = message.busy;
			render();
			break;
		case 'error':
			state.error = { message: message.message, hint: message.hint };
			state.busy = false;
			render();
			break;
		case 'spec':
			state.spec = message.spec as State['spec'];
			render();
			break;
	}
});

function render(): void {
	root.innerHTML = '';
	root.appendChild(renderToolbar());
	if (state.error) {
		root.appendChild(renderError(state.error));
	}
	root.appendChild(renderTable());
	root.appendChild(renderFooter());
}

function renderToolbar(): HTMLElement {
	const bar = el('div', 'toolbar');

	const title = el('div', 'title');
	title.textContent = state.spec.model
		? `${state.spec.model}.${state.spec.method}`
		: 'No model selected';
	bar.appendChild(title);

	const spacer = el('div', 'spacer');
	bar.appendChild(spacer);

	const enabledCount = state.columns.filter((column) => column.enabled).length;
	const count = el('span', 'muted');
	count.textContent = `${enabledCount} of ${state.columns.length} columns`;
	bar.appendChild(count);

	if (state.editable) {
		const execute = el('button', 'primary') as HTMLButtonElement;
		execute.textContent = state.busy ? 'Running…' : 'Execute';
		execute.disabled = state.busy;
		execute.addEventListener('click', () => {
			vscode.postMessage({ type: 'execute', spec: buildSpec() });
		});
		bar.appendChild(execute);

		const cancel = el('button', 'secondary') as HTMLButtonElement;
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
		bar.appendChild(cancel);
	}

	return bar;
}

/** Rebuilds the spec from the current column selection. */
function buildSpec(): State['spec'] {
	const fields = state.columns.filter((column) => column.enabled).map((column) => column.name);
	return { ...state.spec, fields };
}

function renderError(error: { message: string; hint?: string }): HTMLElement {
	const box = el('div', 'error');
	const message = el('div', 'error-message');
	message.textContent = error.message;
	box.appendChild(message);
	if (error.hint) {
		const hint = el('div', 'error-hint');
		hint.textContent = error.hint;
		box.appendChild(hint);
	}
	return box;
}

function renderTable(): HTMLElement {
	const wrapper = el('div', 'table-wrapper');
	const table = el('table', 'grid') as HTMLTableElement;

	table.appendChild(renderHead());

	const body = el('tbody');
	if (state.rows.length === 0) {
		const row = el('tr');
		const cell = el('td', 'empty') as HTMLTableCellElement;
		cell.colSpan = Math.max(state.columns.length, 1);
		cell.textContent = state.busy
			? 'Running query…'
			: state.meta
				? 'No records matched this query.'
				: 'Click Execute to run this query.';
		row.appendChild(cell);
		body.appendChild(row);
	} else {
		for (const record of sortedRows()) {
			body.appendChild(renderRow(record));
		}
	}

	table.appendChild(body);
	wrapper.appendChild(table);
	return wrapper;
}

function renderHead(): HTMLElement {
	const head = el('thead');
	const row = el('tr');

	for (const column of state.columns) {
		const cell = el('th') as HTMLTableCellElement;
		cell.classList.toggle('disabled', !column.enabled);
		cell.title = column.enabled
			? `Click to exclude "${column.label}" from the request`
			: `Click to include "${column.label}" in the request`;

		const label = el('span', 'col-label');
		label.textContent = column.label;
		cell.appendChild(label);

		const type = el('span', 'col-type');
		type.textContent = column.type;
		cell.appendChild(type);

		if (column.sortable) {
			const sort = el('button', 'sort') as HTMLButtonElement;
			sort.textContent = state.sortField === column.name
				? state.sortDirection === 'asc'
					? '▲'
					: '▼'
				: '⇅';
			sort.title = `Sort by ${column.label}`;
			sort.addEventListener('click', (event) => {
				event.stopPropagation();
				toggleSort(column.name);
			});
			cell.appendChild(sort);
		}

		// Header click toggles inclusion — the core interaction of the gate.
		cell.addEventListener('click', () => toggleColumn(column));
		row.appendChild(cell);
	}

	head.appendChild(row);
	return head;
}

function toggleColumn(column: Column): void {
	column.enabled = !column.enabled;
	vscode.postMessage({ type: 'toggleColumn', field: column.name, enabled: column.enabled });
	render();
}

function toggleSort(field: string): void {
	if (state.sortField === field) {
		state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
	} else {
		state.sortField = field;
		state.sortDirection = 'asc';
	}
	render();
}

function sortedRows(): Record<string, unknown>[] {
	if (!state.sortField) {
		return state.rows;
	}
	const field = state.sortField;
	const direction = state.sortDirection === 'asc' ? 1 : -1;
	return [...state.rows].sort((a, b) => compare(a[field], b[field]) * direction);
}

function compare(a: unknown, b: unknown): number {
	if (a === b) {
		return 0;
	}
	if (a === null || a === undefined) {
		return 1;
	}
	if (b === null || b === undefined) {
		return -1;
	}
	if (typeof a === 'number' && typeof b === 'number') {
		return a - b;
	}
	return String(a).localeCompare(String(b));
}

function renderRow(record: Record<string, unknown>): HTMLElement {
	const row = el('tr');
	for (const column of state.columns) {
		const cell = el('td') as HTMLTableCellElement;
		if (!column.enabled) {
			cell.classList.add('disabled');
			cell.textContent = '';
		} else {
			cell.textContent = formatValue(record[column.name], column);
			cell.title = cell.textContent;
		}
		row.appendChild(cell);
	}
	return row;
}

/** Renders a cell value, unwrapping Odoo's `[id, name]` relation tuples. */
function formatValue(value: unknown, column: Column): string {
	if (value === null || value === undefined || value === false) {
		return '';
	}
	if (value === true) {
		return '✓';
	}
	if (column.relational && Array.isArray(value)) {
		return String(value[1] ?? value[0] ?? '');
	}
	if (Array.isArray(value)) {
		return value.map((item) => (Array.isArray(item) ? String(item[1] ?? item[0]) : String(item))).join(', ');
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function renderFooter(): HTMLElement {
	const footer = el('div', 'footer');
	if (state.meta) {
		const parts = [
			`${state.meta.rowCount} row${state.meta.rowCount === 1 ? '' : 's'}`,
			`${state.meta.elapsedMs} ms`,
			state.meta.apiMode,
		];
		if (state.meta.truncated) {
			parts.push('limit reached');
		}
		footer.textContent = parts.join(' · ');
	} else {
		footer.textContent = 'Click a column header to include or exclude it from the request.';
	}
	return footer;
}

function el(tag: string, className?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	return node;
}

vscode.postMessage({ type: 'ready' });
render();
