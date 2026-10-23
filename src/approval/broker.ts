import { randomUUID } from 'node:crypto';
import { FieldsGetResult, OdooRecord } from '../odoo/types';
import { ALWAYS_INCLUDED } from './columns';
import { ApprovalStore } from './store';

export type ColumnStatus = 'approved' | 'denied' | 'new';

export interface PreviewColumn {
	name: string;
	label: string;
	type: string;
	status: ColumnStatus;
	/** Used in the domain, order or groupby. */
	usedInFilter: boolean;
	/** Not returned, only filtered on: there are no values to show. */
	filterOnly: boolean;
	/** `id` cannot be withheld. */
	locked: boolean;
}

/** What the view needs to render an approval. Never sent to the model. */
export interface Preview {
	id: string;
	connection: string;
	model: string;
	method: string;
	/** Arguments the call carried, e.g. domain, order, limit. */
	request: Record<string, unknown>;
	/** True for create/write/unlink/execute_kw: values go *to* Odoo. */
	write: boolean;
	columns: PreviewColumn[];
	rows: OdooRecord[];
	rowCount: number;
	expiresAt: number;
}

export interface Decision {
	approved: boolean;
	/** Columns the user allowed, `id` included. Empty when denied. */
	columns: string[];
	/** Columns the user withheld. */
	withheld: string[];
	reason?: 'denied' | 'expired' | 'cancelled';
}

export interface ApprovalRequest {
	sessionId: string;
	connection: string;
	model: string;
	method: string;
	/** The tool arguments; used to match the view's preview request. */
	args: unknown;
	request: Record<string, unknown>;
	write: boolean;
	rows: OdooRecord[];
	/** All columns: returned ones first, then filter-only ones. */
	columns: string[];
	filterFields: string[];
	fields?: FieldsGetResult;
	/** How many rows the view gets; the model gets all approved rows. */
	previewRows: number;
	/** Columns the user cannot untick, beyond `id` (e.g. raw method arguments). */
	locked?: string[];
}

interface Pending {
	request: ApprovalRequest;
	preview: Preview;
	argsKey: string;
	settled: boolean;
	resolve(decision: Decision): void;
	timer: ReturnType<typeof setTimeout>;
}

export const APPROVAL_TTL_MS = 10 * 60_000;

/**
 * Holds requests waiting for the user. The tool call creates one, the view
 * fetches its preview and posts the decision, and the tool call reads the
 * decision. Every lookup is scoped to the MCP session that created it.
 */
export class ApprovalBroker {
	private readonly pending = new Map<string, Pending>();
	/** Tool calls still fetching from Odoo, so the view knows to keep asking. */
	private readonly loading = new Map<string, number>();

	constructor(
		private readonly store: ApprovalStore,
		private readonly ttlMs = APPROVAL_TTL_MS,
	) {}

	create(request: ApprovalRequest): { id: string; decision: Promise<Decision> } {
		const id = randomUUID();
		const scope = ApprovalStore.scope(request.connection, request.model);
		const known = this.store.classify(request.sessionId, scope, request.columns);
		const status = (name: string): ColumnStatus =>
			known.approved.includes(name) ? 'approved' : known.denied.includes(name) ? 'denied' : 'new';
		const returned = new Set(request.rows.flatMap((row) => Object.keys(row)));
		const filter = new Set(request.filterFields);

		const preview: Preview = {
			id,
			connection: request.connection,
			model: request.model,
			method: request.method,
			request: request.request,
			write: request.write,
			columns: request.columns.map((name) => ({
				name,
				label: request.fields?.[name]?.string ?? name,
				type: request.fields?.[name]?.type ?? 'unknown',
				// Writes start from a clean slate: nothing is pre-approved.
				status: request.write ? 'new' : status(name),
				usedInFilter: filter.has(name),
				filterOnly: !returned.has(name),
				locked: ALWAYS_INCLUDED.has(name) || Boolean(request.locked?.includes(name)),
			})),
			rows: request.rows.slice(0, request.previewRows),
			rowCount: request.rows.length,
			expiresAt: Date.now() + this.ttlMs,
		};

		let resolve!: (decision: Decision) => void;
		const decision = new Promise<Decision>((done) => (resolve = done));
		const entry: Pending = {
			request,
			preview,
			argsKey: stableKey(request.args),
			settled: false,
			resolve: (value) => {
				if (entry.settled) {
					return;
				}
				entry.settled = true;
				clearTimeout(entry.timer);
				resolve(value);
			},
			timer: setTimeout(() => this.settle(id, denied('expired')), this.ttlMs),
		};
		// An abandoned approval must not keep the process alive.
		entry.timer.unref?.();
		this.pending.set(id, entry);
		return { id, decision };
	}

	/** Marks a call as fetching; call the returned function when done. */
	beginLoading(sessionId: string, args: unknown): () => void {
		const key = `${sessionId}\u0000${stableKey(args)}`;
		this.loading.set(key, (this.loading.get(key) ?? 0) + 1);
		let done = false;
		return () => {
			if (done) {
				return;
			}
			done = true;
			const count = (this.loading.get(key) ?? 1) - 1;
			if (count > 0) {
				this.loading.set(key, count);
			} else {
				this.loading.delete(key);
			}
		};
	}

	isLoading(sessionId: string, args: unknown): boolean {
		return this.loading.has(`${sessionId}\u0000${stableKey(args)}`);
	}

	/**
	 * The preview for a view. A view knows its tool call by the arguments it
	 * was given (`tool-input`), or by id once the result names it.
	 */
	preview(sessionId: string, lookup: { id?: string; args?: unknown }): Preview | undefined {
		return this.find(sessionId, lookup)?.preview;
	}

	/** Applies the user's choice. Returns false when nothing was pending. */
	decide(sessionId: string, id: string, approved: boolean, allowed: string[]): boolean {
		const entry = this.find(sessionId, { id });
		if (!entry || entry.settled) {
			return false;
		}
		if (!approved) {
			this.settle(id, denied('denied'));
			return true;
		}
		const { columns, write } = entry.request;
		const locked = new Set([...ALWAYS_INCLUDED, ...(entry.request.locked ?? [])]);
		const keep = new Set([...allowed.filter((name) => columns.includes(name)), ...columns.filter((name) => locked.has(name))]);
		const withheld = columns.filter((name) => !keep.has(name));
		if (!write) {
			this.store.record(sessionId, ApprovalStore.scope(entry.request.connection, entry.request.model), keep, withheld);
		}
		this.settle(id, { approved: true, columns: [...keep], withheld });
		return true;
	}

	/** Denies a pending request, e.g. when the tool call is cancelled. */
	cancel(id: string): void {
		this.settle(id, denied('cancelled'));
	}

	/** Forgets a request once its tool call has returned. */
	release(id: string): void {
		const entry = this.pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
		}
	}

	private settle(id: string, decision: Decision): void {
		this.pending.get(id)?.resolve(decision);
	}

	private find(sessionId: string, lookup: { id?: string; args?: unknown }): Pending | undefined {
		if (lookup.id) {
			const entry = this.pending.get(lookup.id);
			return entry?.request.sessionId === sessionId ? entry : undefined;
		}
		if (lookup.args === undefined) {
			return undefined;
		}
		const key = stableKey(lookup.args);
		// Newest unsettled match: a repeated identical call supersedes older ones.
		let match: Pending | undefined;
		for (const entry of this.pending.values()) {
			if (entry.request.sessionId === sessionId && !entry.settled && entry.argsKey === key) {
				match = entry;
			}
		}
		return match;
	}
}

function denied(reason: Decision['reason']): Decision {
	return { approved: false, columns: [], withheld: [], reason };
}

/** JSON with sorted object keys, so argument order does not matter. */
export function stableKey(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
			: inner,
	);
}
