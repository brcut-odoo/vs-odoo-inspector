import * as assert from 'node:assert/strict';
import { asRows, columnsOf, domainFields, groupbyFields, orderFields, project } from '../approval/columns';
import { ApprovalStore } from '../approval/store';

suite('columns', () => {
	test('extracts fields from domains, including operators and paths', () => {
		assert.deepEqual(
			domainFields(['|', '&', ['email', 'ilike', 'ceo@'], ['partner_id.country_id.code', '=', 'BE'], '!', ['active', '=', false]]).sort(),
			['active', 'email', 'partner_id'],
		);
		assert.deepEqual(domainFields([['order_line', 'any', [['product_id.name', 'ilike', 'x']]]]), ['order_line']);
		assert.deepEqual(domainFields([]), []);
		assert.deepEqual(domainFields(undefined), []);
	});

	test('extracts fields from order and groupby', () => {
		assert.deepEqual(orderFields('date desc, partner_id.name asc,id'), ['date', 'partner_id', 'id']);
		assert.deepEqual(orderFields(undefined), []);
		assert.deepEqual(groupbyFields(['date:month', 'user_id']), ['date', 'user_id']);
		assert.deepEqual(groupbyFields('stage_id'), ['stage_id']);
	});

	test('recognises tabular results', () => {
		assert.deepEqual(asRows([{ id: 1 }]), [{ id: 1 }]);
		assert.deepEqual(asRows([]), []);
		assert.equal(asRows(3), undefined);
		assert.equal(asRows([1, 2]), undefined);
		assert.equal(asRows([[1, 'a']]), undefined);
	});

	test('lists columns in row order, then filter-only fields', () => {
		assert.deepEqual(columnsOf([{ id: 1, name: 'a' }, { id: 2, email: 'b' }], ['name', 'active']), ['id', 'name', 'email', 'active']);
	});

	test('projects rows onto allowed columns, always keeping id', () => {
		assert.deepEqual(project([{ id: 1, name: 'a', phone: '1' }], ['name']), [{ id: 1, name: 'a' }]);
	});
});

suite('ApprovalStore', () => {
	const scope = ApprovalStore.scope('prod', 'res.partner');

	test('everything starts undecided, except id', () => {
		const store = new ApprovalStore();
		assert.deepEqual(store.classify('s1', scope, ['id', 'name']), { approved: ['id'], denied: [], undecided: ['name'] });
	});

	test('remembers approvals and denials per session and scope', () => {
		const store = new ApprovalStore();
		store.record('s1', scope, ['name', 'email'], ['phone']);
		assert.deepEqual(store.classify('s1', scope, ['name', 'phone', 'street']), { approved: ['name'], denied: ['phone'], undecided: ['street'] });
		assert.deepEqual(store.classify('s2', scope, ['name']).undecided, ['name'], 'other sessions are unaffected');
		assert.deepEqual(store.classify('s1', ApprovalStore.scope('prod', 'res.users'), ['name']).undecided, ['name'], 'other models are unaffected');
	});

	test('a later decision overrides an earlier one', () => {
		const store = new ApprovalStore();
		store.record('s1', scope, ['phone'], []);
		store.record('s1', scope, [], ['phone']);
		assert.deepEqual(store.classify('s1', scope, ['phone']).denied, ['phone']);
		store.record('s1', scope, ['phone'], []);
		assert.deepEqual(store.classify('s1', scope, ['phone']).approved, ['phone']);
	});

	test('id can never be denied', () => {
		const store = new ApprovalStore();
		store.record('s1', scope, [], ['id']);
		assert.deepEqual(store.classify('s1', scope, ['id']).approved, ['id']);
	});

	test('reset forgets one session or all, and notifies', () => {
		const store = new ApprovalStore();
		let changes = 0;
		store.onDidChange(() => changes++);
		store.record('s1', scope, ['name'], []);
		store.record('s2', scope, ['name'], []);
		store.reset('s1');
		assert.deepEqual(store.classify('s1', scope, ['name']).undecided, ['name']);
		assert.deepEqual(store.classify('s2', scope, ['name']).approved, ['name']);
		store.reset();
		assert.deepEqual(store.snapshot(), []);
		assert.equal(changes, 4);
	});
});
