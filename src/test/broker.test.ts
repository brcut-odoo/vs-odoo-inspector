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
		// `email` was only filtered on: allowed for this call, but its values were never shown.
		assert.deepEqual(known, { approved: ['name'], denied: ['phone'], undecided: ['email'] });
		assert.equal(broker.decide('s1', id, true, ['phone']), false, 'a settled request cannot be decided again');
	});

	test('a withheld filter-only column is remembered as denied', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const { id, decision } = broker.create(request());
		broker.decide('s1', id, true, ['name', 'phone']);
		assert.deepEqual((await decision).withheld, ['email']);
		assert.deepEqual(store.classify('s1', ApprovalStore.scope('prod', 'res.partner'), ['email']).denied, ['email']);
	});

	test('approving a filter-only column does not auto-approve a later read of its values', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const first = broker.create(request());
		broker.decide('s1', first.id, true, ['name', 'phone', 'email']);
		await first.decision;
		const later = broker.create(request({ rows: [{ id: 1, name: 'A', phone: '111', email: 'a@acme.com' }], columns: ['id', 'name', 'phone', 'email'], filterFields: [] }));
		const email = broker.preview('s1', { id: later.id })!.columns.find((c) => c.name === 'email')!;
		assert.deepEqual([email.status, email.filterOnly], ['new', false]);
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

	const appContext = () => ({
		signal: new AbortController().signal,
		notify: async () => undefined,
		elicitInput: async () => assert.fail('should not elicit'),
	});

	test('defers when no view asks within the wait, keeping the request for the view', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => true, 20);
		const outcome = await gate.approve(request(), 'app', appContext());
		assert.equal(outcome.reason, 'deferred');
		assert.ok(outcome.id);
		assert.equal(broker.preview('s1', { id: outcome.id })?.model, 'res.partner');
		assert.equal(broker.decide('s1', outcome.id, true, ['name']), true);
		// Decided: no longer pending for any view.
		assert.equal(broker.preview('s1', { id: outcome.id }), undefined);
	});

	test('the decision on a deferred request is collected by id, once, in its own session', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 20);
		const { id, fetchId } = await gate.approve(request(), 'app', appContext());
		assert.equal(broker.collect('s1', fetchId!), 'pending');
		assert.equal(broker.collect('s2', fetchId!), undefined);
		broker.decide('s1', id!, true, ['name']);
		assert.equal(broker.collect('s2', fetchId!), undefined);
		const decision = broker.collect('s1', fetchId!);
		assert.ok(decision && decision !== 'pending');
		assert.deepEqual([decision.approved, decision.columns.sort(), decision.withheld], [true, ['id', 'name'], ['phone', 'email']]);
		assert.equal(broker.collect('s1', fetchId!), undefined);
	});

	test('waitFor blocks until the user answers, then hands out the decision once', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 10);
		const { id, fetchId } = await gate.approve(request(), 'app', appContext());
		let settled = false;
		const waiting = broker.waitFor('s1', fetchId!).then((decision) => ((settled = true), decision));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled, false);
		broker.decide('s1', id!, true, ['name']);
		const decision = await waiting;
		assert.deepEqual([decision?.approved, decision?.columns.sort()], [true, ['id', 'name']]);
		assert.equal(await broker.waitFor('s1', fetchId!), undefined);
	});

	test('waitFor gives up on abort and leaves the request open', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 10);
		const { fetchId } = await gate.approve(request(), 'app', appContext());
		const abort = new AbortController();
		const waiting = broker.waitFor('s1', fetchId!, abort.signal);
		abort.abort();
		assert.equal(await waiting, undefined);
		assert.equal(broker.collect('s1', fetchId!), 'pending');
		assert.equal(await broker.waitFor('s2', fetchId!), undefined);
	});

	test('waitFor returns nothing when the request expires unanswered', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store, 40);
		const gate = new ApprovalGate(broker, store, () => false, 10);
		const { fetchId } = await gate.approve(request(), 'app', appContext());
		assert.equal(await broker.waitFor('s1', fetchId!), undefined);
	});

	test('the fetch id the model gets cannot preview or decide; the approval id cannot fetch', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 10);
		const { id, fetchId } = await gate.approve(request(), 'app', appContext());
		assert.ok(id && fetchId && id !== fetchId);
		assert.equal(broker.preview('s1', { id: fetchId }), undefined);
		assert.equal(broker.decide('s1', fetchId, true, ['name', 'phone']), false);
		assert.equal(broker.collect('s1', id), undefined);
		assert.equal(await broker.waitFor('s1', id), undefined);
		// Still pending for the view, which approves with the approval id.
		assert.equal(broker.collect('s1', fetchId), 'pending');
		broker.decide('s1', id, true, ['name']);
		const decision = broker.collect('s1', fetchId);
		assert.ok(decision && decision !== 'pending');
		assert.deepEqual(decision.columns.sort(), ['id', 'name']);
	});

	test('a denial is collected too', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 20);
		const { id, fetchId } = await gate.approve(request(), 'app', appContext());
		broker.decide('s1', id!, false, []);
		const decision = broker.collect('s1', fetchId!);
		assert.ok(decision && decision !== 'pending');
		assert.deepEqual([decision.approved, decision.reason], [false, 'denied']);
	});

	test('an unanswered deferred request expires and leaves nothing to collect', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store, 30);
		const gate = new ApprovalGate(broker, store, () => false, 10);
		const { id, fetchId } = await gate.approve(request(), 'app', appContext());
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(broker.preview('s1', { id }), undefined);
		assert.equal(broker.collect('s1', fetchId!), undefined);
	});

	test('a lookup with nothing loading or pending does not mark a later identical call as viewed', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 20);
		const req = request();
		// e.g. a view rendered after an auto-approved result, or a restored chat
		assert.equal(broker.preview('s1', { args: req.args }), undefined);
		const outcome = await gate.approve(req, 'app', appContext());
		assert.equal(outcome.reason, 'deferred');
	});

	test('a view showing up while a call fetches makes its session block from then on', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 20);
		assert.equal((await gate.approve(request(), 'app', appContext())).reason, 'deferred');
		// Flagged now; this time the view polls while the call is still fetching.
		const req = request({ args: { other: 1 } });
		const endLoading = broker.beginLoading('s1', req.args);
		broker.preview('s1', { args: req.args });
		const pending = gate.approve(req, 'app', appContext());
		endLoading();
		await new Promise((resolve) => setTimeout(resolve, 40));
		broker.decide('s1', broker.preview('s1', { args: req.args })!.id, true, ['name']);
		assert.equal((await pending).approved, true);
		// Known to render live now: the next call blocks even though no view asks.
		assert.equal(await stillBlocking(gate, request({ args: { other: 2 } })), true);
	});

	/** Whether an unviewed call is still pending well past the wait; cancels it either way. */
	const stillBlocking = async (gate: ApprovalGate, req: ApprovalRequest, waitMs = 60) => {
		const abort = new AbortController();
		const call = gate.approve(req, 'app', { ...appContext(), signal: abort.signal });
		const result = await Promise.race([call.then(() => false), new Promise<true>((resolve) => setTimeout(() => resolve(true), waitMs))]);
		abort.abort();
		await call;
		return result;
	};

	/** A call whose view asks while it is still fetching, then approves. */
	const approveLive = async (broker: ApprovalBroker, gate: ApprovalGate, req: ApprovalRequest) => {
		const endLoading = broker.beginLoading(req.sessionId, req.args);
		broker.preview(req.sessionId, { args: req.args });
		const pending = gate.approve(req, 'app', appContext());
		endLoading();
		broker.decide(req.sessionId, broker.preview(req.sessionId, { args: req.args })!.id, true, ['name']);
		assert.equal((await pending).approved, true);
	};

	test('a client seen rendering views live is remembered across sessions', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 20);
		gate.setClient('s1', 'Visual Studio Code');
		await approveLive(broker, gate, request());
		gate.forgetSession('s1');
		// A new session of the same client, whose view fails to render: no deferral.
		gate.setClient('s2', 'Visual Studio Code');
		assert.equal(await stillBlocking(gate, request({ sessionId: 's2' })), true);
		// Another client still defers.
		gate.setClient('s3', 'claude-ai');
		assert.equal((await gate.approve(request({ sessionId: 's3' }), 'app', appContext())).reason, 'deferred');
	});

	test('after one deferral, the session defers at once; other sessions still wait', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => false, 200);
		const elapsed = async (req: ApprovalRequest) => {
			const start = Date.now();
			const outcome = await gate.approve(req, 'app', appContext());
			assert.equal(outcome.reason, 'deferred');
			return Date.now() - start;
		};
		assert.ok((await elapsed(request())) >= 190);
		assert.ok((await elapsed(request({ args: { other: 1 } }))) < 100);
		assert.ok((await elapsed(request({ sessionId: 's2' }))) >= 190);
		gate.forgetSession('s1');
		assert.ok((await elapsed(request({ args: { other: 2 } }))) >= 190);
	});

	test('keeps waiting for a decision once a view has asked', async () => {
		const store = new ApprovalStore();
		const broker = new ApprovalBroker(store);
		const gate = new ApprovalGate(broker, store, () => true, 20);
		const req = request();
		const endLoading = broker.beginLoading('s1', req.args);
		broker.preview('s1', { args: req.args }); // the view polls while the call is still fetching
		const pending = gate.approve(req, 'app', appContext());
		endLoading();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const id = broker.preview('s1', { args: req.args })!.id;
		broker.decide('s1', id, true, ['name']);
		const outcome = await pending;
		assert.deepEqual([outcome.approved, outcome.columns.sort()], [true, ['id', 'name']]);
	});
});
