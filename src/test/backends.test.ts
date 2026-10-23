import * as assert from 'assert';
import { baseShape } from '../odoo/backends/backend';
import { CallKwBackend } from '../odoo/backends/callKw';
import { Json2Backend } from '../odoo/backends/json2';
import { normalizeSpec } from '../query/spec';
import { QuerySpec } from '../odoo/types';

suite('Backend shaping', () => {
	test('call_kw keeps positional args and puts options in kwargs', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			domain: [['is_company', '=', true]],
			fields: ['name', 'email'],
			limit: 10,
			offset: 5,
			order: 'name asc',
		});

		const { args, kwargs } = baseShape(spec);

		assert.deepStrictEqual(args, [[['is_company', '=', true]]]);
		assert.deepStrictEqual(kwargs, {
			fields: ['name', 'email'],
			offset: 5,
			limit: 10,
			order: 'name asc',
		});
	});

	test('call_kw omits optional kwargs that were not set', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const { args, kwargs } = baseShape(spec);

		assert.deepStrictEqual(args, [[]]);
		// `normalizeSpec` applies the default limit, so only that is present.
		assert.deepStrictEqual(kwargs, { limit: 200 });
		assert.ok(!('fields' in kwargs));
		assert.ok(!('order' in kwargs));
		assert.ok(!('offset' in kwargs));
	});

	test('call_kw read passes ids positionally', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'read',
			ids: [1, 2, 3],
			fields: ['name'],
		});
		const { args, kwargs } = baseShape(spec);

		assert.deepStrictEqual(args, [[1, 2, 3]]);
		assert.deepStrictEqual(kwargs, { fields: ['name'] });
	});

	test('call_kw search_count passes only the domain', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_count',
			domain: [['active', '=', true]],
		});
		const { args, kwargs } = baseShape(spec);

		assert.deepStrictEqual(args, [[['active', '=', true]]]);
		assert.deepStrictEqual(kwargs, {});
	});

	test('call_kw write passes ids and values positionally', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'write',
			ids: [7],
			values: { name: 'ACME' },
		});
		const { args } = baseShape(spec);

		assert.deepStrictEqual(args, [[7], { name: 'ACME' }]);
	});

	test('call_kw merges context into kwargs', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			context: { lang: 'en_US' },
		});
		const { kwargs } = baseShape(spec);

		assert.deepStrictEqual(kwargs.context, { lang: 'en_US' });
	});

	test('json2 moves everything into kwargs and drops positional args', () => {
		const backend = new Json2Backend({} as never);
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			domain: [['is_company', '=', true]],
			fields: ['name'],
			limit: 10,
		});

		const { args, kwargs } = backend.shape(spec);

		assert.deepStrictEqual(args, []);
		assert.deepStrictEqual(kwargs, {
			domain: [['is_company', '=', true]],
			fields: ['name'],
			limit: 10,
		});
	});

	test('json2 read uses a named ids parameter', () => {
		const backend = new Json2Backend({} as never);
		const spec = normalizeSpec({ model: 'res.partner', method: 'read', ids: [1, 2] });
		const { args, kwargs } = backend.shape(spec);

		assert.deepStrictEqual(args, []);
		assert.deepStrictEqual(kwargs.ids, [1, 2]);
	});

	test('json2 write uses ids and vals', () => {
		const backend = new Json2Backend({} as never);
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'write',
			ids: [7],
			values: { name: 'ACME' },
		});
		const { kwargs } = backend.shape(spec);

		assert.deepStrictEqual(kwargs.ids, [7]);
		assert.deepStrictEqual(kwargs.vals, { name: 'ACME' });
	});

	test('json2 create wraps values in vals_list', () => {
		const backend = new Json2Backend({} as never);
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'create',
			values: { name: 'ACME' },
		});
		const { kwargs } = backend.shape(spec);

		assert.deepStrictEqual(kwargs.vals_list, [{ name: 'ACME' }]);
	});

	test('json2 unlink uses a named ids parameter', () => {
		const backend = new Json2Backend({} as never);
		const spec = normalizeSpec({ model: 'res.partner', method: 'unlink', ids: [3] });
		const { kwargs } = backend.shape(spec);

		assert.deepStrictEqual(kwargs.ids, [3]);
	});

	test('call_kw and json2 disagree on the same spec', () => {
		const spec: QuerySpec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			domain: [['id', '>', 1]],
			fields: ['name'],
		});

		const callKw = baseShape(spec);
		const json2 = new Json2Backend({} as never).shape(spec);

		assert.notDeepStrictEqual(callKw, json2);
		assert.strictEqual(callKw.args.length, 1);
		assert.strictEqual(json2.args.length, 0);
	});

	test('CallKwBackend delegates shaping to baseShape', () => {
		const backend = new CallKwBackend({} as never);
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_count', domain: [] });

		assert.deepStrictEqual(backend.shape(spec), baseShape(spec));
	});
});
