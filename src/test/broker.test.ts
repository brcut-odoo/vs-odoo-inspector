import * as assert from 'node:assert/strict';
import { ApprovalBroker, ApprovalRequest, stableKey } from '../approval/broker';
import { ApprovalStore } from '../approval/store';
import { ApprovalGate } from '../tools/gate';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		sessionId: 's1',
		connection: 'prod',
		model: 'res.partner',
		method: 'search_read',
		args: { model: 'res.partner', domain: [['email', 'ilike', '@acme']], fields: ['name', 'phone'] },
		request: { domain: [['email', 'ilike', '@acme']] },
		write: false,
		rows: [
			{ id: 1, name: 'A', phone: '111' },
			{ id: 2, name: 'B', phone: '222' },
		],
		columns: ['id', 'name', 'phone', 'email'],
		filterFields: ['email'],
		fields: { name: { type: 'char', string: 'Name' }, phone: { type: 'char', string: 'Phone' }, email: { type: 'char', string: 'Email' } },
		previewRows: 1,
		...overrides,
	};
}

suite('ApprovalBroker', () => {
	test('builds a preview with column metadata and capped rows', () => {
		const broker = new ApprovalBroker(new ApprovalStore());
		const { id } = broker.create(request());
		const preview = broker.preview('s1', { id })!;
		assert.equal(preview.rows.length, 1);
		assert.equal(preview.rowCount, 2);
		const email = preview.columns.find((c) => c.name === 'email')!;
		assert.deepEqual([email.label, email.status, email.usedInFilter, email.filterOnly], ['Email', 'new', true, true]);
		const idColumn = preview.columns.find((c) => c.name === 'id')!;
		assert.deepEqual([idColumn.status, idColumn.locked], ['approved', true]);
	});

	test('the view finds its request by arguments, in any key order, within its session only', () => {
		const broker = new ApprovalBroker(new ApprovalStore());
		const { id } = broker.create(request());
		const reordered = { fields: ['name', 'phone'], domain: [['email', 'ilike', '@acme']], model: 'res.partner' };
		assert.equal(broker.preview('s1', { args: reordered })?.id, id);
		assert.equal(broker.preview('s2', { args: reordered }), undefined);
		assert.equal(broker.preview('s2', { id }), undefined);
	});

	test('approval projects onto the chosen columns and is remembered', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const { id, decision } = broker.create(request());
		assert.equal(broker.decide('s1', id, true, ['name', 'email', 'not-a-column']), true);
		const result = await decision;
		assert.deepEqual(result, { approved: true, columns: ['name', 'email', 'id'], withheld: ['phone'] });
		const known = store.classify('s1', ApprovalStore.scope('prod', 'res.partner'), ['name', 'phone', 'email']);
		assert.deepEqual(known, { approved: ['name', 'email'], denied: ['phone'], undecided: [] });
		assert.equal(broker.decide('s1', id, true, ['phone']), false, 'a settled request cannot be decided again');
	});

	test('a later preview shows remembered statuses', () => {
		const store = new ApprovalStore();
		store.record('s1', ApprovalStore.scope('prod', 'res.partner'), ['name'], ['phone']);
		const broker = new ApprovalBroker(store);
		const { id } = broker.create(request());
		const statuses = Object.fromEntries(broker.preview('s1', { id })!.columns.map((c) => [c.name, c.status]));
		assert.deepEqual(statuses, { id: 'approved', name: 'approved', phone: 'denied', email: 'new' });
	});

	test('writes are never remembered and never pre-approved', async () => {
		const store = new ApprovalStore();
		store.record('s1', ApprovalStore.scope('prod', 'res.partner'), ['name'], []);
		const broker = new ApprovalBroker(store);
		const { id, decision } = broker.create(request({ method: 'write', write: true, rows: [{ name: 'X', phone: '9' }], columns: ['name', 'phone'], filterFields: [] }));
		assert.equal(broker.preview('s1', { id })!.columns.find((c) => c.name === 'name')!.status, 'new');
		broker.decide('s1', id, true, ['phone']);
		assert.deepEqual((await decision).columns, ['phone']);
		assert.deepEqual(store.classify('s1', ApprovalStore.scope('prod', 'res.partner'), ['phone']).undecided, ['phone']);
	});

	test('deny, cancel and expiry all resolve as not approved', async () => {
		const broker = new ApprovalBroker(new ApprovalStore(), 20);
		const denied = broker.create(request());
		broker.decide('s1', denied.id, false, ['name']);
		assert.deepEqual(await denied.decision, { approved: false, columns: [], withheld: [], reason: 'denied' });

		const cancelled = broker.create(request());
		broker.cancel(cancelled.id);
		assert.equal((await cancelled.decision).reason, 'cancelled');

		const expired = broker.create(request());
		assert.equal((await expired.decision).reason, 'expired');
	});

	test('stableKey ignores object key order but not array order', () => {
		assert.equal(stableKey({ a: 1, b: { c: 2, d: 3 } }), stableKey({ b: { d: 3, c: 2 }, a: 1 }));
		assert.notEqual(stableKey([1, 2]), stableKey([2, 1]));
	});
});

suite('ApprovalGate', () => {
	test('a read with no records is approved without asking', async () => {
		const store = new ApprovalStore();
		const gate = new ApprovalGate(new ApprovalBroker(store), store, () => true);
		const context = {
			signal: new AbortController().signal,
			notify: async () => undefined,
			elicitInput: async () => assert.fail('should not ask'),
		};
		const outcome = await gate.approve(request({ rows: [] }), 'elicitation', context);
		assert.deepEqual([outcome.approved, outcome.auto, outcome.withheld], [true, true, []]);
		assert.deepEqual(store.classify('s1', ApprovalStore.scope('prod', 'res.partner'), ['name']).undecided, ['name']);
	});
});
