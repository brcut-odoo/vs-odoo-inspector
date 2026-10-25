import * as assert from 'node:assert/strict';
import { listDatabases } from '../odoo/databases';

/** A `fetch` that answers per path and records the paths asked. */
function fakeFetch(answers: Record<string, { status?: number; body: string }>): { fetch: typeof fetch; paths: string[] } {
	const paths: string[] = [];
	const impl = async (input: string | URL | Request) => {
		const path = new URL(String(input)).pathname;
		paths.push(path);
		const answer = answers[path] ?? { status: 404, body: '<html>Not Found</html>' };
		return new Response(answer.body, { status: answer.status ?? 200 });
	};
	return { fetch: impl as typeof fetch, paths };
}

const json = (value: unknown) => JSON.stringify(value);

suite('listDatabases', () => {
	test('reads /web/database/list', async () => {
		const fake = fakeFetch({ '/web/database/list': { body: json({ jsonrpc: '2.0', id: 1, result: ['a', 'b'] }) } });
		assert.deepEqual(await listDatabases('https://odoo.test/', undefined, fake.fetch), ['a', 'b']);
		assert.deepEqual(fake.paths, ['/web/database/list']);
	});

	test('falls back to the external db.list', async () => {
		const fake = fakeFetch({ '/jsonrpc': { body: json({ jsonrpc: '2.0', id: 1, result: ['c'] }) } });
		assert.deepEqual(await listDatabases('https://odoo.test', undefined, fake.fetch), ['c']);
		assert.deepEqual(fake.paths, ['/web/database/list', '/jsonrpc']);
	});

	test('is undefined when listing is disabled', async () => {
		const denied = { body: json({ jsonrpc: '2.0', id: 1, error: { message: 'Access Denied', data: { name: 'odoo.exceptions.AccessDenied' } } }) };
		const fake = fakeFetch({ '/web/database/list': denied, '/jsonrpc': denied });
		assert.equal(await listDatabases('https://odoo.test', undefined, fake.fetch), undefined);
	});

	test('is undefined when the server is unreachable', async () => {
		const failing = (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		assert.equal(await listDatabases('https://odoo.test', undefined, failing), undefined);
	});
});
