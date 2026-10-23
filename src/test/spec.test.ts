import * as assert from 'assert';
import {
	clampLimit,
	DEFAULT_LIMIT,
	isReadOnlyMethod,
	MAX_LIMIT,
	normalizeSpec,
	parseSpec,
} from '../query/spec';
import { validateSpec } from '../query/validate';
import { FieldsGetResult } from '../odoo/types';

const FIELDS: FieldsGetResult = {
	name: { type: 'char', string: 'Name', store: true },
	email: { type: 'char', string: 'Email', store: true },
	active: { type: 'boolean', string: 'Active', store: true },
};

suite('Spec normalization', () => {
	test('fills in defaults', () => {
		const spec = normalizeSpec({ model: 'res.partner' });

		assert.strictEqual(spec.method, 'search_read');
		assert.deepStrictEqual(spec.domain, []);
		assert.deepStrictEqual(spec.fields, []);
		assert.strictEqual(spec.limit, DEFAULT_LIMIT);
		assert.strictEqual(spec.offset, 0);
	});

	test('clamps an excessive limit', () => {
		assert.strictEqual(clampLimit(999999), MAX_LIMIT);
	});

	test('treats a zero or negative limit as the default', () => {
		assert.strictEqual(clampLimit(0), DEFAULT_LIMIT);
		assert.strictEqual(clampLimit(-5), DEFAULT_LIMIT);
	});

	test('drops an empty order string', () => {
		const spec = normalizeSpec({ model: 'res.partner', order: '   ' });
		assert.strictEqual(spec.order, undefined);
	});

	test('drops an empty context object', () => {
		const spec = normalizeSpec({ model: 'res.partner', context: {} });
		assert.strictEqual(spec.context, undefined);
	});

	test('copies the fields array rather than aliasing it', () => {
		const fields = ['name'];
		const spec = normalizeSpec({ model: 'res.partner', fields });
		fields.push('email');

		assert.deepStrictEqual(spec.fields, ['name']);
	});
});

suite('Read-only detection', () => {
	test('treats the query methods as read-only', () => {
		for (const method of ['search_read', 'search', 'search_count', 'read', 'fields_get', 'name_search']) {
			assert.strictEqual(isReadOnlyMethod(method), true, method);
		}
	});

	test('treats mutations and arbitrary calls as unsafe to preview', () => {
		// `call` matters most: `odoo_call_method` can invoke anything, so a
		// preview would execute an unknown side effect before the user approves.
		for (const method of ['call', 'create', 'write', 'unlink', 'something_else']) {
			assert.strictEqual(isReadOnlyMethod(method), false, method);
		}
	});
});

suite('Spec parsing', () => {
	test('parses valid JSON', () => {
		const spec = parseSpec('{"model": "res.partner", "fields": ["name"]}');

		assert.strictEqual(spec.model, 'res.partner');
		assert.deepStrictEqual(spec.fields, ['name']);
	});

	test('rejects malformed JSON with a readable message', () => {
		assert.throws(() => parseSpec('{not json'), /Invalid JSON/);
	});

	test('rejects a non-object payload', () => {
		assert.throws(() => parseSpec('[]'), /must be a JSON object/);
	});

	test('rejects a missing model', () => {
		assert.throws(() => parseSpec('{"fields": []}'), /non-empty "model"/);
	});
});

suite('Spec validation', () => {
	test('accepts a valid spec', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			domain: [['active', '=', true]],
			fields: ['name'],
		});

		assert.deepStrictEqual(validateSpec(spec, FIELDS), []);
	});

	test('flags an unknown field', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['nope'],
		});
		const issues = validateSpec(spec, FIELDS);

		assert.strictEqual(issues.length, 1);
		assert.strictEqual(issues[0].severity, 'error');
		assert.match(issues[0].message, /does not exist/);
	});

	test('flags an unknown field in the domain', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			domain: [['ghost', '=', 1]],
		});
		const issues = validateSpec(spec, FIELDS);

		assert.strictEqual(issues.length, 1);
		assert.match(issues[0].message, /unknown field "ghost"/);
	});

	test('flags an unknown domain operator', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			domain: [['name', '~~', 'x']],
		});
		const issues = validateSpec(spec, FIELDS);

		assert.strictEqual(issues.length, 1);
		assert.match(issues[0].message, /Unknown domain operator/);
	});

	test('accepts a nested domain with boolean prefixes', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			domain: ['|', ['name', 'ilike', 'a'], '&', ['active', '=', true], ['email', '!=', false]],
		});

		assert.deepStrictEqual(validateSpec(spec, FIELDS), []);
	});

	test('flags an unknown sort field', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			order: 'ghost desc',
		});
		const issues = validateSpec(spec, FIELDS);

		assert.strictEqual(issues.length, 1);
		assert.match(issues[0].message, /Cannot sort on unknown field/);
	});

	test('accepts a multi-clause order', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			order: 'name asc, email desc',
		});

		assert.deepStrictEqual(validateSpec(spec, FIELDS), []);
	});
});
