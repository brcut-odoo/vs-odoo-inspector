import * as assert from 'node:assert/strict';
import { OdooClient } from '../odoo/client';
import { OdooError } from '../odoo/errors';
import { toJson2Body } from '../odoo/protocols/json2';
import { encodeValue } from '../odoo/protocols/xmlrpcCodec';
import { ConnectionConfig } from '../odoo/types';

interface Recorded {
	url: string;
	headers: Record<string, string>;
	body: string;
}

type Handler = (request: Recorded) => { status?: number; body: string; headers?: Record<string, string> };

/** A `fetch` that records requests and answers from `handler`. */
function fakeFetch(handler: Handler): { fetch: typeof fetch; requests: Recorded[] } {
	const requests: Recorded[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit) => {
		const request = { url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') };
		requests.push(request);
		const { status = 200, body, headers = {} } = handler(request);
		return new Response(body, { status, headers });
	};
	return { fetch: impl as typeof fetch, requests };
}

const json = (value: unknown) => JSON.stringify(value);
const API_KEY = '0123456789abcdef0123456789abcdef01234567';
const base: ConnectionConfig = { name: 't', url: 'https://odoo.test/', db: 'db1', login: 'admin' };

function client(connection: Partial<ConnectionConfig>, secret: string, handler: Handler) {
	const fake = fakeFetch(handler);
	return { client: new OdooClient({ connection: { ...base, ...connection }, secret, rateLimitPerSecond: 0, fetch: fake.fetch }), requests: fake.requests };
}

suite('protocols', () => {
	test('jsonrpc authenticates once, then calls execute_kw with uid and secret', async () => {
		const { client: c, requests } = client({ authMethod: 'password' }, 'pw', (req) => {
			const { params } = JSON.parse(req.body);
			return { body: json({ jsonrpc: '2.0', id: 1, result: params.method === 'authenticate' ? 2 : [{ id: 1, name: 'A' }] }) };
		});
		assert.deepEqual(await c.searchRead('res.partner', [['id', '=', 1]], ['name'], { limit: 1 }), [{ id: 1, name: 'A' }]);
		await c.read('res.partner', [1], ['name']);
		assert.equal(c.protocolName, 'jsonrpc');
		assert.equal(requests.length, 3);
		assert.equal(requests[0].url, 'https://odoo.test/jsonrpc');
		assert.deepEqual(JSON.parse(requests[0].body).params, { service: 'common', method: 'authenticate', args: ['db1', 'admin', 'pw', {}] });
		assert.deepEqual(JSON.parse(requests[1].body).params.args, [
			'db1', 2, 'pw', 'res.partner', 'search_read', [], { domain: [['id', '=', 1]], fields: ['name'], limit: 1 },
		]);
	});

	test('jsonrpc rejects a failed login with an auth error', async () => {
		const { client: c } = client({ authMethod: 'password' }, 'bad', () => ({ body: json({ jsonrpc: '2.0', id: 1, result: false }) }));
		await assert.rejects(c.connect(), (error: unknown) => error instanceof OdooError && error.kind === 'auth');
	});

	test('xmlrpc talks to /xmlrpc/2/common and /object', async () => {
		const { client: c, requests } = client({ authMethod: 'apiKey', protocol: 'xmlrpc' }, API_KEY, (req) => ({
			body: `<?xml version='1.0'?><methodResponse><params><param>${encodeValue(req.url.endsWith('/common') ? 5 : [{ id: 9 }])}</param></params></methodResponse>`,
		}));
		assert.deepEqual(await c.read('res.users', [9], ['login']), [{ id: 9 }]);
		// A forced protocol other than json2 needs no version probe.
		assert.deepEqual(requests.map((r) => r.url), ['https://odoo.test/xmlrpc/2/common', 'https://odoo.test/xmlrpc/2/object']);
		assert.equal(requests[0].headers['Content-Type'], 'text/xml');
		assert.ok(requests[1].body.includes('<methodName>execute_kw</methodName>'));
		assert.ok(requests[1].body.includes(`<string>${API_KEY}</string>`));
	});

	test('callKw exchanges a password for a session cookie', async () => {
		const { client: c, requests } = client({ authMethod: 'password', protocol: 'callKw' }, 'pw', (req) =>
			req.url.endsWith('/web/session/authenticate')
				? { body: json({ jsonrpc: '2.0', id: 1, result: { uid: 2 } }), headers: { 'set-cookie': 'session_id=abc123; Path=/; HttpOnly' } }
				: { body: json({ jsonrpc: '2.0', id: 1, result: 7 }) },
		);
		assert.equal(await c.executeKw('res.partner', 'search_count', [[]]), 7);
		assert.equal(requests[1].url, 'https://odoo.test/web/dataset/call_kw/res.partner/search_count');
		assert.equal(requests[1].headers.Cookie, 'session_id=abc123');
		assert.deepEqual(JSON.parse(requests[1].body).params, { model: 'res.partner', method: 'search_count', args: [[]], kwargs: {} });
	});

	test('callKw uses a pasted session token directly', async () => {
		const token = 'S'.repeat(42);
		const { client: c, requests } = client({}, token, () => ({ body: json({ jsonrpc: '2.0', id: 1, result: [] }) }));
		await c.executeKw('res.partner', 'search', [[]]);
		assert.equal(c.protocolName, 'callKw');
		assert.equal(requests.length, 1);
		assert.equal(requests[0].headers.Cookie, `session_id=${token}`);
	});

	test('callKw reports TOTP half-sessions as auth errors', async () => {
		const { client: c } = client({ authMethod: 'password', protocol: 'callKw' }, 'pw', () => ({
			body: json({ jsonrpc: '2.0', id: 1, result: { uid: null } }),
			headers: { 'set-cookie': 'session_id=half; Path=/' },
		}));
		await assert.rejects(c.connect(), (error: unknown) => error instanceof OdooError && error.kind === 'auth' && /two-factor/.test(error.hint ?? ''));
	});

	test('json2 is chosen for API keys on 19.0 and sends named params', async () => {
		const { client: c, requests } = client({}, API_KEY, (req) =>
			req.url.endsWith('version_info')
				? { body: json({ jsonrpc: '2.0', id: 1, result: { server_version: '19.0', server_version_info: [19, 0, 0, 'final', 0, ''] } }) }
				: { body: json([{ id: 1 }]) },
		);
		await c.read('res.partner', [1, 2], ['name']);
		assert.equal(c.protocolName, 'json2');
		assert.equal(requests[1].url, 'https://odoo.test/json/2/res.partner/read');
		assert.equal(requests[1].headers.Authorization, `bearer ${API_KEY}`);
		assert.equal(requests[1].headers['X-Odoo-Database'], 'db1');
		assert.deepEqual(JSON.parse(requests[1].body), { ids: [1, 2], fields: ['name'] });
	});

	test('json2 maps HTTP errors to OdooError', async () => {
		const { client: c } = client({ protocol: 'json2' }, API_KEY, (req) =>
			req.url.includes('/json/2/')
				? { status: 403, body: json({ name: 'odoo.exceptions.AccessError', message: 'Nope' }) }
				: { body: json({ jsonrpc: '2.0', id: 1, result: { server_version_info: [19, 0] } }) },
		);
		await assert.rejects(c.executeKw('res.partner', 'search', [[]]), (error: unknown) => error instanceof OdooError && error.kind === 'access' && error.message === 'Nope');
	});

	test('toJson2Body names positional args and keeps kwargs', () => {
		assert.deepEqual(toJson2Body('search_read', [[['a', '=', 1]]], { limit: 2 }), { domain: [['a', '=', 1]], limit: 2 });
		assert.deepEqual(toJson2Body('write', [[1], { name: 'x' }], {}), { ids: [1], vals: { name: 'x' } });
		assert.deepEqual(toJson2Body('action_confirm', [[4, 5]], {}), { ids: [4, 5] });
		assert.throws(() => toJson2Body('mystery', ['a', 'b'], {}), OdooError);
	});

	test('JSON-RPC errors carry the Odoo exception kind', async () => {
		const { client: c } = client({ authMethod: 'password' }, 'pw', (req) => {
			const { params } = JSON.parse(req.body);
			return params.method === 'authenticate'
				? { body: json({ jsonrpc: '2.0', id: 1, result: 2 }) }
				: { body: json({ jsonrpc: '2.0', id: 1, error: { code: 200, message: 'Odoo Server Error', data: { name: 'odoo.exceptions.AccessError', message: 'No access to res.users' } } }) };
		});
		await assert.rejects(c.executeKw('res.users', 'read', [[1]]), (error: unknown) => error instanceof OdooError && error.kind === 'access' && error.message === 'No access to res.users');
	});

	test('an HTML 404 is reported as a protocol problem', async () => {
		const { client: c } = client({ authMethod: 'password' }, 'pw', () => ({ status: 404, body: '<html>Not Found</html>' }));
		await assert.rejects(c.connect(), (error: unknown) => error instanceof OdooError && error.kind === 'protocol');
	});
});

