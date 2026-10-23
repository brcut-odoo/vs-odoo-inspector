/**
 * Runs every auth × protocol pair against a real Odoo. Skipped unless
 * ODOO_IT_URL is set, together with ODOO_IT_DB, ODOO_IT_LOGIN,
 * ODOO_IT_PASSWORD and ODOO_IT_API_KEY.
 */
import * as assert from 'node:assert/strict';
import { OdooClient } from '../../odoo/client';
import { OdooError } from '../../odoo/errors';
import { AuthKind, ConnectionConfig, ProtocolName } from '../../odoo/types';

const env = process.env;
const url = env.ODOO_IT_URL;

(url ? suite : suite.skip)(`integration (${url ?? 'ODOO_IT_URL unset'})`, function () {
	this.timeout(60_000);
	const base: ConnectionConfig = { name: 'it', url: url ?? '', db: env.ODOO_IT_DB ?? '', login: env.ODOO_IT_LOGIN ?? 'admin' };
	let sessionToken = '';
	let major = 0;

	suiteSetup(async () => {
		const response = await fetch(`${url}/web/session/authenticate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db: base.db, login: base.login, password: env.ODOO_IT_PASSWORD } }),
		});
		sessionToken = /session_id=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? '';
		assert.ok(sessionToken, 'could not open a session for the session-token tests');
		const info = await fetch(`${url}/web/webclient/version_info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","method":"call","params":{}}' });
		major = ((await info.json()) as { result: { server_version_info: number[] } }).result.server_version_info[0];
	});

	const secretFor = (kind: AuthKind) => (kind === 'password' ? env.ODOO_IT_PASSWORD! : kind === 'apiKey' ? env.ODOO_IT_API_KEY! : sessionToken);

	const pairs: [AuthKind, ProtocolName | 'auto'][] = [
		['password', 'jsonrpc'],
		['password', 'xmlrpc'],
		['password', 'callKw'],
		['apiKey', 'jsonrpc'],
		['apiKey', 'xmlrpc'],
		['apiKey', 'json2'],
		['apiKey', 'auto'],
		['session', 'callKw'],
		['session', 'auto'],
	];

	for (const [kind, protocol] of pairs) {
		test(`${kind} + ${protocol}`, async function () {
			if (protocol === 'json2' && major < 19) {
				this.skip();
			}
			const client = new OdooClient({ connection: { ...base, authMethod: kind, protocol }, secret: secretFor(kind), rateLimitPerSecond: 0 });
			const rows = await client.searchRead('res.partner', [['id', '>', 0]], ['name', 'email'], { limit: 3, order: 'id' });
			assert.ok(rows.length > 0, 'expected partners');
			assert.deepEqual(Object.keys(rows[0]).sort(), ['email', 'id', 'name']);
			const [first] = await client.read('res.partner', [rows[0].id as number], ['display_name']);
			assert.equal(first.id, rows[0].id);
			const fields = await client.fieldsGet('res.partner');
			assert.equal(fields.email.type, 'char');
			const count = await client.executeKw('res.partner', 'search_count', [[['id', '>', 0]]]);
			assert.ok(typeof count === 'number' && count >= rows.length);
			if (protocol === 'auto') {
				const expected = kind === 'session' ? 'callKw' : major >= 19 ? 'json2' : 'jsonrpc';
				assert.equal(client.protocolName, expected);
			}
		});
	}

	test('a wrong password is an auth error on every protocol', async () => {
		for (const protocol of ['jsonrpc', 'xmlrpc', 'callKw'] as const) {
			const client = new OdooClient({ connection: { ...base, authMethod: 'password', protocol }, secret: 'definitely-wrong', rateLimitPerSecond: 0 });
			await assert.rejects(client.connect(), (error: unknown) => error instanceof OdooError && error.kind === 'auth', protocol);
		}
	});

	test('an access error is reported with its kind', async () => {
		const client = new OdooClient({ connection: { ...base, authMethod: 'password', protocol: 'xmlrpc' }, secret: env.ODOO_IT_PASSWORD!, rateLimitPerSecond: 0 });
		await assert.rejects(client.executeKw('res.partner', 'no_such_method', [[]]), OdooError);
	});
});
