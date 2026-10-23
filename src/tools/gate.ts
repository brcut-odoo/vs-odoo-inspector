import { ApprovalBroker, ApprovalRequest, Decision } from '../approval/broker';
import { ApprovalStore } from '../approval/store';

interface BooleanField {
	type: 'boolean';
	title?: string;
	description?: string;
	default?: boolean;
}

/** The parts of an MCP tool-call context the gate uses. */
export interface CallContext {
	signal: AbortSignal;
	progressToken?: string | number;
	notify(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
	elicitInput(params: {
		mode: 'form';
		message: string;
		requestedSchema: { type: 'object'; properties: Record<string, BooleanField> };
	}): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;
}

export type ApprovalUi = 'app' | 'elicitation' | 'none';

export interface GateOutcome extends Decision {
	/** True when nothing needed asking: every column was approved earlier. */
	auto: boolean;
}

/**
 * Decides whether a request needs the user, and if so asks through the
 * in-chat view (MCP Apps) or, for clients without it, an elicitation form.
 */
export class ApprovalGate {
	constructor(
		private readonly broker: ApprovalBroker,
		private readonly store: ApprovalStore,
		private readonly autoApproveKnown: () => boolean,
	) {}

	async approve(request: ApprovalRequest, ui: ApprovalUi, context: CallContext): Promise<GateOutcome> {
		// No records means no values to share; nothing is recorded, so the
		// columns are still asked about once there is data.
		if (!request.write && request.rows.length === 0) {
			return { approved: true, auto: true, columns: request.columns, withheld: [] };
		}
		if (!request.write && this.autoApproveKnown()) {
			const known = this.store.classify(request.sessionId, ApprovalStore.scope(request.connection, request.model), request.columns);
			if (known.undecided.length === 0) {
				return { approved: true, auto: true, columns: known.approved, withheld: known.denied };
			}
		}
		switch (ui) {
			case 'app':
				return { ...(await this.viaApp(request, context)), auto: false };
			case 'elicitation':
				return { ...(await this.viaElicitation(request, context)), auto: false };
			case 'none':
				return { approved: false, auto: false, columns: [], withheld: [], reason: 'denied' };
		}
	}

	/**
	 * Blocks the tool call until the view posts a decision. Progress
	 * notifications keep the client from timing the call out meanwhile.
	 */
	private async viaApp(request: ApprovalRequest, context: CallContext): Promise<Decision> {
		const { id, decision } = this.broker.create(request);
		const onAbort = () => this.broker.cancel(id);
		context.signal.addEventListener('abort', onAbort);
		let ticks = 0;
		const heartbeat =
			context.progressToken === undefined
				? undefined
				: setInterval(() => {
						void context
							.notify({
								method: 'notifications/progress',
								params: { progressToken: context.progressToken, progress: ++ticks, message: 'Waiting for your approval in the chat…' },
							})
							.catch(() => undefined);
					}, 10_000);
		try {
			return await decision;
		} finally {
			if (heartbeat) {
				clearInterval(heartbeat);
			}
			context.signal.removeEventListener('abort', onAbort);
			this.broker.release(id);
		}
	}

	/**
	 * One checkbox per column. Elicitation forms cannot show a table, so each
	 * column's description carries a few sample values instead.
	 */
	private async viaElicitation(request: ApprovalRequest, context: CallContext): Promise<Decision> {
		const scope = ApprovalStore.scope(request.connection, request.model);
		const known = this.store.classify(request.sessionId, scope, request.columns);
		const locked = new Set(['id', ...(request.locked ?? [])]);
		const properties: Record<string, BooleanField> = {};
		for (const column of request.columns) {
			if (locked.has(column)) {
				continue;
			}
			const label = request.fields?.[column]?.string ?? column;
			const samples = request.rows
				.slice(0, 3)
				.map((row) => sample(row[column]))
				.filter(Boolean);
			const filterNote = request.filterFields.includes(column) ? ' Used in the filter.' : '';
			properties[column] = {
				type: 'boolean',
				title: `${label} (${column})`,
				description: (samples.length ? `e.g. ${samples.join(', ')}${request.rows.length > 3 ? ` … ${request.rows.length} rows` : ''}.` : 'No values (filter only).') + filterNote,
				default: !known.denied.includes(column),
			};
		}
		const what = request.write
			? `Send these fields to Odoo (${request.method} on ${request.model}, connection ${request.connection})?`
			: `Share these columns of ${request.rows.length} ${request.model} record(s) from ${request.connection} with the model?`;
		const result = await context.elicitInput({ mode: 'form', message: what, requestedSchema: { type: 'object', properties } });
		if (result.action !== 'accept') {
			return { approved: false, columns: [], withheld: [], reason: result.action === 'cancel' ? 'cancelled' : 'denied' };
		}
		const allowed = request.columns.filter((column) => locked.has(column) || result.content?.[column] === true);
		const withheld = request.columns.filter((column) => !allowed.includes(column));
		if (!request.write) {
			this.store.record(request.sessionId, scope, allowed, withheld);
		}
		return { approved: true, columns: allowed, withheld };
	}
}

function sample(value: unknown): string {
	if (value === false || value === null || value === undefined || value === '') {
		return '';
	}
	const text = Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' ? value[1] : typeof value === 'object' ? JSON.stringify(value) : String(value);
	return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** What the connected client can show, from its `initialize` capabilities. */
export function approvalUiFor(capabilities: { elicitation?: unknown; extensions?: Record<string, unknown> } | undefined): ApprovalUi {
	if (capabilities?.extensions?.['io.modelcontextprotocol/ui']) {
		return 'app';
	}
	if (capabilities?.elicitation) {
		return 'elicitation';
	}
	return 'none';
}
