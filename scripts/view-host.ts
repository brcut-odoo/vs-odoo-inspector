/**
 * A fake MCP Apps host for checking the approval view in headless Chrome.
 * It embeds the view, answers its app-only tool calls with a canned preview,
 * ticks/unticks like a user would, and writes what happened into #report.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

declare const VIEW_HTML: string;
const report: string[] = [];
const note = (line: string) => {
	report.push(line);
	document.getElementById('report')!.textContent = report.join('\n');
};

const args = { model: 'res.partner', domain: [['email', 'ilike', '@']], fields: ['name', 'email', 'phone'] };
const preview = {
	id: 'p1', connection: 'prod', model: 'res.partner', method: 'search_read', request: { domain: args.domain, fields: args.fields }, write: false,
	columns: [
		{ name: 'id', label: 'ID', type: 'integer', status: 'approved', usedInFilter: false, filterOnly: false, locked: true },
		{ name: 'name', label: 'Name', type: 'char', status: 'approved', usedInFilter: false, filterOnly: false, locked: false },
		{ name: 'email', label: 'Email', type: 'char', status: 'new', usedInFilter: true, filterOnly: false, locked: false },
		{ name: 'phone', label: 'Phone', type: 'char', status: 'denied', usedInFilter: false, filterOnly: false, locked: false },
	],
	rows: [{ id: 1, name: 'Azure Interior', email: 'azure@example.com', phone: '+1 555' }, { id: 2, name: 'Deco Addict', email: 'deco@example.com', phone: false }],
	rowCount: 2, expiresAt: Date.now() + 60000,
};

const iframe = document.createElement('iframe');
iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
iframe.style.width = '900px';
iframe.style.height = '500px';
document.body.append(iframe);

let previewCalls = 0;
const bridge = new AppBridge(null, { name: 'fake-host', version: '0' }, { serverTools: {} });
bridge.oncalltool = async (params) => {
	note(`tools/call ${params.name} ${JSON.stringify(params.arguments)}`);
	if (params.name === 'odoo_approval_preview') {
		const body = ++previewCalls === 1 ? { status: 'loading' } : { status: 'pending', preview };
		return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
	}
	if (params.name === 'odoo_approval_decide') {
		setTimeout(() => void bridge.sendToolResult({ content: [{ type: 'text', text: 'ok' }], _meta: { 'odooInspector/summary': { outcome: 'approved', rows: 2, columns: (params.arguments as { columns: string[] }).columns, withheld: ['email', 'phone'] } } }), 50);
		return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } };
	}
	return { content: [{ type: 'text', text: '{}' }], structuredContent: { cleared: 0 } };
};
bridge.oninitialized = () => {
	note('view initialized');
	void bridge.sendToolInput({ arguments: args });
};

// Listen before the view loads, as a real host does: the view sends
// `ui/initialize` as soon as its script runs.
void bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.addEventListener('load', async () => {
	const doc = iframe.contentDocument!;
	const waitFor = async (predicate: () => boolean, what: string) => {
		for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
		if (!predicate()) throw new Error(`timed out waiting for ${what}`);
	};
	try {
		await waitFor(() => doc.querySelectorAll('th').length === 4, 'table');
		const headers = [...doc.querySelectorAll('th')];
		note(`headers: ${headers.map((th) => `${th.querySelector('.name')?.textContent}[${(th.querySelector('input') as HTMLInputElement).checked ? 'on' : 'off'}${(th.querySelector('input') as HTMLInputElement).disabled ? ',locked' : ''}|${[...th.querySelectorAll('.badge')].map((b) => b.textContent).join(',')}]`).join(' ')}`);
		note(`row 1: ${[...doc.querySelectorAll('tbody tr:first-child td')].map((td) => `${td.textContent}${td.className === 'off' ? '(dim)' : ''}`).join(' | ')}`);
		note(`buttons: ${[...doc.querySelectorAll('.actions button')].map((b) => b.textContent).join(' / ')}`);
		// The user unticks email, then approves.
		const emailBox = headers[2].querySelector('input') as HTMLInputElement;
		emailBox.click();
		await waitFor(() => doc.querySelector('.actions button')?.textContent === 'Approve 2 columns', 'count update');
		note(`after unticking email: ${doc.querySelector('.actions button')?.textContent}`);
		(doc.querySelector('.actions button.primary') as HTMLButtonElement).click();
		await waitFor(() => Boolean(doc.querySelector('.summary')), 'summary');
		note(`summary: ${doc.querySelector('.summary')?.textContent}`);
		note('VIEW CHECK PASSED');
	} catch (error) {
		note(`VIEW CHECK FAILED: ${(error as Error).message}\n${doc.body.innerHTML.slice(0, 2000)}`);
	}
});
iframe.srcdoc = VIEW_HTML;
