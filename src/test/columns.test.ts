import * as assert from 'assert';
import {
	buildColumns,
	DEFAULT_COLUMN_CAP,
	defaultFieldNames,
	requestedFields,
	toggleColumn,
} from '../query/columns';
import { normalizeSpec } from '../query/spec';
import { FieldsGetResult } from '../odoo/types';

const FIELDS: FieldsGetResult = {
	id: { type: 'integer', string: 'ID', store: true },
	display_name: { type: 'char', string: 'Display Name', store: true },
	name: { type: 'char', string: 'Name', store: true },
	email: { type: 'char', string: 'Email', store: true },
	active: { type: 'boolean', string: 'Active', store: true },
	create_date: { type: 'datetime', string: 'Created on', store: true },
	partner_id: { type: 'many2one', string: 'Customer', store: true, relation: 'res.partner' },
	line_ids: { type: 'one2many', string: 'Lines', store: true, relation: 'sale.order.line' },
	tag_ids: { type: 'many2many', string: 'Tags', store: true, relation: 'res.partner.category' },
	image_1920: { type: 'binary', string: 'Image', store: true },
	description: { type: 'html', string: 'Description', store: true },
	computed_field: { type: 'char', string: 'Computed', store: false },
};

suite('Column model', () => {
	test('excludes one2many and many2many columns entirely', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const columns = buildColumns(FIELDS, spec);
		const names = columns.map((column) => column.name);

		assert.ok(!names.includes('line_ids'));
		assert.ok(!names.includes('tag_ids'));
	});

	test('enables display_name plus stored scalars by default', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const columns = buildColumns(FIELDS, spec);
		const enabled = columns.filter((column) => column.enabled).map((column) => column.name);

		assert.ok(enabled.includes('display_name'));
		assert.ok(enabled.includes('name'));
		assert.ok(enabled.includes('email'));
	});

	test('prefers well-known fields over alphabetical order', () => {
		// Regression: `res.partner` used to default to autopost_bills,
		// barcode, buyer_id — alphabetically first but useless.
		const noisy: FieldsGetResult = {
			aaa_junk: { type: 'char', string: 'Junk', store: true },
			zzz_name: { type: 'char', string: 'Name', store: true },
			name: { type: 'char', string: 'Name', store: true },
			email: { type: 'char', string: 'Email', store: true },
		};
		const names = defaultFieldNames(noisy);

		assert.ok(names.includes('name'), 'name should be preferred');
		assert.ok(names.includes('email'), 'email should be preferred');
		assert.ok(
			names.indexOf('name') < names.indexOf('aaa_junk'),
			'preferred fields come before alphabetical filler',
		);
	});

	test('does not enable heavy types by default', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const columns = buildColumns(FIELDS, spec);
		const enabled = columns.filter((column) => column.enabled).map((column) => column.name);

		assert.ok(!enabled.includes('image_1920'), 'binary should not be enabled by default');
		assert.ok(!enabled.includes('description'), 'html should not be enabled by default');
	});

	test('keeps heavy types available but disabled', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const columns = buildColumns(FIELDS, spec);
		const image = columns.find((column) => column.name === 'image_1920');

		assert.ok(image, 'binary column should still be listed');
		assert.strictEqual(image.enabled, false);
	});

	test('does not enable non-stored computed fields by default', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const columns = buildColumns(FIELDS, spec);
		const computed = columns.find((column) => column.name === 'computed_field');

		assert.ok(computed);
		assert.strictEqual(computed.enabled, false);
	});

	test('respects an explicit field list', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name', 'email'],
		});
		const columns = buildColumns(FIELDS, spec);
		const enabled = columns.filter((column) => column.enabled).map((column) => column.name);

		assert.deepStrictEqual(enabled.sort(), ['email', 'name']);
	});

	test('adds a column for an explicit field missing from fields_get', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name', 'ghost_field'],
		});
		const columns = buildColumns(FIELDS, spec);
		const ghost = columns.find((column) => column.name === 'ghost_field');

		assert.ok(ghost, 'unknown explicit fields still get a column');
		assert.strictEqual(ghost.enabled, true);
		assert.strictEqual(ghost.type, 'unknown');
	});

	test('sorts enabled columns before disabled ones', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['email'],
		});
		const columns = buildColumns(FIELDS, spec);
		const firstDisabled = columns.findIndex((column) => !column.enabled);
		const lastEnabled = columns.map((column) => column.enabled).lastIndexOf(true);

		assert.ok(lastEnabled < firstDisabled, 'all enabled columns come first');
	});

	test('marks many2one columns as relational', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const columns = buildColumns(FIELDS, spec);
		const partner = columns.find((column) => column.name === 'partner_id');

		assert.ok(partner);
		assert.strictEqual(partner.relational, true);
	});

	test('uses the human label when available', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const columns = buildColumns(FIELDS, spec);
		const email = columns.find((column) => column.name === 'email');

		assert.strictEqual(email?.label, 'Email');
	});

	test('caps the default column count', () => {
		const many: FieldsGetResult = {};
		for (let i = 0; i < 40; i++) {
			many[`field_${i}`] = { type: 'char', string: `Field ${i}`, store: true };
		}
		const names = defaultFieldNames(many);

		assert.ok(names.length <= DEFAULT_COLUMN_CAP, `expected <= ${DEFAULT_COLUMN_CAP}, got ${names.length}`);
	});
});

suite('Column toggling', () => {
	test('disabling a field removes it from the spec', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name', 'email'],
		});
		const next = toggleColumn(spec, 'email', false);

		assert.deepStrictEqual(next.fields, ['name']);
	});

	test('enabling a field adds it to the spec', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name'],
		});
		const next = toggleColumn(spec, 'email', true);

		assert.deepStrictEqual(next.fields, ['name', 'email']);
	});

	test('enabling an already-enabled field is a no-op', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name'],
		});
		const next = toggleColumn(spec, 'name', true);

		assert.deepStrictEqual(next.fields, ['name']);
	});

	test('disabling an absent field is a no-op', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name'],
		});
		const next = toggleColumn(spec, 'ghost', false);

		assert.deepStrictEqual(next.fields, ['name']);
	});

	test('does not mutate the original spec', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name'],
		});
		toggleColumn(spec, 'email', true);

		assert.deepStrictEqual(spec.fields, ['name']);
	});

	test('toggling round-trips back to the original', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name', 'email'],
		});
		const off = toggleColumn(spec, 'email', false);
		const on = toggleColumn(off, 'email', true);

		assert.deepStrictEqual(on.fields, ['name', 'email']);
	});

	test('a disabled column disappears from the request', () => {
		const spec = normalizeSpec({
			model: 'res.partner',
			method: 'search_read',
			fields: ['name', 'email'],
		});
		const next = toggleColumn(spec, 'email', false);

		assert.deepStrictEqual(requestedFields(next, FIELDS), ['name']);
	});

	test('an empty field list falls back to the defaults', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const requested = requestedFields(spec, FIELDS);

		assert.ok(requested.includes('display_name'));
		assert.ok(requested.length > 0);
	});

	test('toggling with no explicit fields materializes the defaults first', () => {
		// Regression: without this, disabling one header on a fresh query
		// collapsed the request to the single remaining toggled field.
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const defaults = defaultFieldNames(FIELDS);
		const next = toggleColumn(spec, 'email', false, FIELDS);

		assert.ok(next.fields, 'fields should be materialized');
		assert.ok(next.fields!.length > 1, 'the other default columns must survive');
		assert.ok(!next.fields!.includes('email'));
		for (const name of defaults) {
			if (name !== 'email') {
				assert.ok(next.fields!.includes(name), `${name} should still be requested`);
			}
		}
	});

	test('enabling a column with no explicit fields keeps the defaults', () => {
		const spec = normalizeSpec({ model: 'res.partner', method: 'search_read' });
		const next = toggleColumn(spec, 'partner_id', true, FIELDS);

		assert.ok(next.fields!.includes('partner_id'));
		assert.ok(next.fields!.includes('display_name'));
		assert.ok(next.fields!.length > 1);
	});
});
