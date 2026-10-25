/**
 * End-to-end check of the approval flow against a real Odoo, outside VS Code.
 *
 * An MCP client plays both VS Code (calling the model-facing tools) and the
 * in-chat view (polling `odoo_approval_preview`, posting decisions).
 *
 *   ODOO_IT_URL=… ODOO_IT_DB=… ODOO_IT_PASSWORD=… ODOO_IT_API_KEY=… pnpm run e2e
 */
import * as assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { ApprovalBroker } from '../src/approval/broker';
import { ApprovalStore } from '../src/approval/store';
import { McpHttpServer } from '../src/mcp/httpServer';
import { OdooClient } from '../src/odoo/client';
import { ApprovalGate } from '../src/tools/gate';
import { registerOdooTools } from '../src/tools/odooTools';
import type { PreviewResponse } from '../src/view/protocol';

const env = process.env;
const connection = { name: 'it', url: env.ODOO_IT_URL!, db: env.ODOO_IT_DB!, login: env.ODOO_IT_LOGIN ?? 'admin', authMethod: 'apiKey' as const };
const direct = new OdooClient({ connection, secret: env.ODOO_IT_API_KEY!, rateLimitPerSecond: 0 });

/** What the stubbed connection prompt answers next. */
let promptAnswer: 'connected' | 'declined' = 'connected';

const store = new ApprovalStore();
const broker = new ApprovalBroker(store);
const gate = new ApprovalGate(broker, store, () => true);
const http = new McpHttpServer((sessionId) => {
	const server = new McpServer({ name: 'odoo-inspector', version: 'e2e' });
	registerOdooTools(server, {
		sessionId,
		broker,
		store,
		gate,
		client: async () => {
			await direct.connect();
			return direct;
		},
		connect: async () => {
			if (promptAnswer === 'declined') {
				return { status: 'declined' };
			}
			await direct.connect();
			return { status: 'connected', name: 'it', client: direct };
		},
		openConnections: () => [direct],
		onAuthFailure: async () => false,
		settings: () => ({ maxRows: 50, previewRows: 10, enableExecuteKw: true }),
		log: (message) => console.log(`  [server] ${message}`),
	});
	return server;
}, (message) => console.log(`  [http] ${message}`));

async function connect(url: string, capabilities: Record<string, unknown>): Promise<Client> {
	const client = new Client({ name: 'e2e', version: '0' }, { capabilities });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${http.token}` } } }));
	return client;
}

const APPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };

function textOf(result: { content?: unknown }): string {
	return ((result.content as { type: string; text?: string }[]) ?? []).map((part) => part.text ?? '').join('');
}

/** What the view does: poll until the request shows up. */
async function awaitPreview(client: Client, args: Record<string, unknown>): Promise<PreviewResponse> {
	for (let i = 0; i < 100; i++) {
		const result = await client.callTool({ name: 'odoo_approval_preview', arguments: { args } });
		const response = result.structuredContent as unknown as PreviewResponse;
		if (response.status !== 'loading') {
			return response;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('preview never left loading');
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
	process.stdout.write(`• ${name}\n`);
	await body();
	process.stdout.write(`  ✔ ${name}\n`);
}

async function main(): Promise<void> {
	const url = await http.start();
	const apps = await connect(url, APPS);
	const tools = await apps.listTools();
	const names = tools.tools.map((tool) => tool.name).sort();
	console.log(`tools: ${names.join(', ')}`);

	const [partner] = await direct.searchRead('res.partner', [['email', '!=', false]], ['id'], { limit: 1, order: 'id' });
	const base = { model: 'res.partner', domain: [['id', '=', partner.id]], fields: ['name', 'email', 'phone'] };

	await step('app-only tools are marked for the app only', async () => {
		for (const tool of tools.tools.filter((t) => t.name.startsWith('odoo_approval_'))) {
			assert.deepEqual((tool._meta as { ui?: { visibility?: string[] } }).ui?.visibility, ['app'], tool.name);
		}
	});

	await step('odoo_connect returns the connection name', async () => {
		const result = await apps.callTool({ name: 'odoo_connect', arguments: { reason: 'e2e' } });
		assert.ok(!result.isError);
		assert.match(textOf(result), /Use connection "it"/);
	});

	await step('a declined connection is reported, not an error', async () => {
		promptAnswer = 'declined';
		try {
			const result = await apps.callTool({ name: 'odoo_connect', arguments: {} });
			assert.ok(!result.isError);
			assert.match(textOf(result), /declined/);
		} finally {
			promptAnswer = 'connected';
		}
	});

	await step('first read waits for the view; withheld column is stripped', async () => {
		let progress = 0;
		const call = apps.callTool({ name: 'odoo_search_read', arguments: base }, { onprogress: () => progress++, resetTimeoutOnProgress: true });
		const preview = await awaitPreview(apps, base);
		assert.equal(preview.status, 'pending');
		if (preview.status !== 'pending') {return;}
		const statuses = Object.fromEntries(preview.preview.columns.map((c) => [c.name, `${c.status}${c.usedInFilter ? '+filter' : ''}`]));
		assert.deepEqual(statuses, { id: 'approved+filter', name: 'new', email: 'new', phone: 'new' });
		assert.ok(preview.preview.rows[0].email, 'the view sees the real email');
		await apps.callTool({ name: 'odoo_approval_decide', arguments: { id: preview.preview.id, approved: true, columns: ['name', 'email'] } });
		const result = await call;
		const body = textOf(result);
		assert.match(body, /Withheld by the user.*phone/);
		assert.ok(!body.includes('"phone"'), 'phone must not reach the model');
		assert.ok(body.includes('"email"'));
		assert.equal((result._meta as Record<string, { outcome: string }>)['odooInspector/summary'].outcome, 'approved');
		console.log(`  (progress notifications: ${progress})`);
	});

	await step('the same columns are auto-approved, without a preview', async () => {
		const result = await apps.callTool({ name: 'odoo_search_read', arguments: base });
		assert.equal((result._meta as Record<string, { outcome: string }>)['odooInspector/summary'].outcome, 'auto-approved');
		assert.ok(!textOf(result).includes('"phone"'));
		const preview = await apps.callTool({ name: 'odoo_approval_preview', arguments: { args: base } });
		assert.equal((preview.structuredContent as { status: string }).status, 'none');
	});

	await step('a new column asks again, with remembered statuses; deny shares nothing', async () => {
		const args = { ...base, fields: ['name', 'phone', 'city'] };
		const call = apps.callTool({ name: 'odoo_search_read', arguments: args });
		const preview = await awaitPreview(apps, args);
		if (preview.status !== 'pending') {throw new Error(preview.status);}
		const statuses = Object.fromEntries(preview.preview.columns.map((c) => [c.name, c.status]));
		assert.deepEqual(statuses, { id: 'approved', name: 'approved', phone: 'denied', city: 'new' });
		await apps.callTool({ name: 'odoo_approval_decide', arguments: { id: preview.preview.id, approved: false, columns: [] } });
		const body = textOf(await call);
		assert.match(body, /denied/);
		assert.ok(!body.includes(String(partner.id)) || !body.includes('"name"'));
	});

	await step('approvals are per session', async () => {
		const other = await connect(url, APPS);
		const call = other.callTool({ name: 'odoo_search_read', arguments: base });
		const preview = await awaitPreview(other, base);
		assert.equal(preview.status, 'pending', 'a new session must ask again');
		const fromFirst = await apps.callTool({ name: 'odoo_approval_preview', arguments: { args: base } });
		assert.equal((fromFirst.structuredContent as { status: string }).status, 'none', "one session cannot see another's preview");
		if (preview.status === 'pending') {
			await other.callTool({ name: 'odoo_approval_decide', arguments: { id: preview.preview.id, approved: true, columns: ['name'] } });
		}
		await call;
		await other.close();
	});

	await step('reset makes the next read ask again', async () => {
		const reset = await apps.callTool({ name: 'odoo_approval_reset', arguments: {} });
		assert.ok((reset.structuredContent as { cleared: number }).cleared > 0);
		const call = apps.callTool({ name: 'odoo_search_read', arguments: base });
		const preview = await awaitPreview(apps, base);
		assert.equal(preview.status, 'pending');
		if (preview.status === 'pending') {
			await apps.callTool({ name: 'odoo_approval_decide', arguments: { id: preview.preview.id, approved: true, columns: ['name', 'email', 'phone'] } });
		}
		assert.ok(textOf(await call).includes('"phone"'));
	});

	await step('filter-only fields need approval: count with a domain on email', async () => {
		const args = { model: 'res.partner', method: 'search_count', args: [[['email', 'ilike', '@']]] };
		const call = apps.callTool({ name: 'odoo_execute_kw', arguments: args });
		const preview = await awaitPreview(apps, args);
		if (preview.status !== 'pending') {throw new Error(preview.status);}
		const columns = Object.fromEntries(preview.preview.columns.map((c) => [c.name, c.filterOnly]));
		assert.deepEqual(columns, { result: false, email: true });
		await apps.callTool({ name: 'odoo_approval_decide', arguments: { id: preview.preview.id, approved: true, columns: ['result', 'email'] } });
		assert.match(textOf(await call), /Result of res\.partner\.search_count:\n\d+/);
	});

	await step('a write sends only the approved fields, and only after approval', async () => {
		const [before] = await direct.read('res.partner', [partner.id as number], ['function', 'comment']);
		const args = { model: 'res.partner', method: 'write', args: [[partner.id], { function: 'E2E Tester', comment: 'should not be written' }] };
		const call = apps.callTool({ name: 'odoo_execute_kw', arguments: args });
		const preview = await awaitPreview(apps, args);
		if (preview.status !== 'pending') {throw new Error(preview.status);}
		assert.equal(preview.preview.write, true);
		const [during] = await direct.read('res.partner', [partner.id as number], ['function']);
		assert.equal(during.function, before.function, 'nothing is written before approval');
		await apps.callTool({ name: 'odoo_approval_decide', arguments: { id: preview.preview.id, approved: true, columns: ['function'] } });
		assert.match(textOf(await call), /removed these fields before sending: comment/);
		const [after] = await direct.read('res.partner', [partner.id as number], ['function', 'comment']);
		assert.equal(after.function, 'E2E Tester');
		assert.equal(after.comment, before.comment);
		await direct.executeKw('res.partner', 'write', [[partner.id], { function: before.function || false }]);
	});

	await step('a denied write sends nothing', async () => {
		const args = { model: 'res.partner', method: 'write', args: [[partner.id], { function: 'Denied' }] };
		const call = apps.callTool({ name: 'odoo_execute_kw', arguments: args });
		const preview = await awaitPreview(apps, args);
		if (preview.status !== 'pending') {throw new Error(preview.status);}
		await apps.callTool({ name: 'odoo_approval_decide', arguments: { id: preview.preview.id, approved: false, columns: [] } });
		await call;
		const [after] = await direct.read('res.partner', [partner.id as number], ['function']);
		assert.notEqual(after.function, 'Denied');
	});

	await step('cancelling the call settles the approval', async () => {
		const args = { ...base, fields: ['name', 'street'] };
		const controller = new AbortController();
		const call = apps.callTool({ name: 'odoo_search_read', arguments: args }, { signal: controller.signal }).catch((error: Error) => error);
		const preview = await awaitPreview(apps, args);
		assert.equal(preview.status, 'pending');
		controller.abort();
		assert.ok((await call) instanceof Error);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const after = await apps.callTool({ name: 'odoo_approval_preview', arguments: { args } });
		assert.equal((after.structuredContent as { status: string }).status, 'none');
	});

	await step('elicitation fallback for clients without MCP Apps', async () => {
		const client = new Client({ name: 'e2e-elicit', version: '0' }, { capabilities: { elicitation: { form: {} } } });
		let schema: Record<string, unknown> = {};
		client.setRequestHandler('elicitation/create', async (request) => {
			schema = (request.params as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema.properties;
			return { action: 'accept', content: { name: true, email: false, phone: false } };
		});
		await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${http.token}` } } }));
		const body = textOf(await client.callTool({ name: 'odoo_search_read', arguments: base }));
		assert.deepEqual(Object.keys(schema).sort(), ['email', 'name', 'phone']);
		assert.match(String((schema.email as { description: string }).description), /e\.g\. /);
		assert.ok(body.includes('"name"') && !body.includes('"email"') && !body.includes('"phone"'));
		await client.close();
	});

	await step('clients with no approval UI are refused', async () => {
		const client = await connect(url, {});
		const result = await client.callTool({ name: 'odoo_search_read', arguments: base });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /cannot display Odoo approvals/);
		await client.close();
	});

	await apps.close();
	await http.dispose();
	console.log('\nAll end-to-end checks passed.');
}

main().catch(async (error) => {
	console.error(error);
	await http.dispose();
	process.exit(1);
});
