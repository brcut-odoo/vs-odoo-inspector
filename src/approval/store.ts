import { ALWAYS_INCLUDED } from './columns';

/** Approvals for one model on one connection, within one chat session. */
export interface ScopeApprovals {
	approved: Set<string>;
	denied: Set<string>;
}

/** What the store already knows about a request's columns. */
export interface Classification {
	/** Columns the user approved earlier. */
	approved: string[];
	/** Columns the user withheld earlier. */
	denied: string[];
	/** Columns never decided on. */
	undecided: string[];
}

/**
 * Remembers which columns the user approved or withheld, per chat session
 * and per `connection|model` scope. In memory only: a reload or a reset
 * forgets everything, which is the conservative failure.
 */
export class ApprovalStore {
	private readonly sessions = new Map<string, Map<string, ScopeApprovals>>();
	private readonly listeners = new Set<() => void>();

	static scope(connection: string, model: string): string {
		return `${connection}|${model}`;
	}

	classify(session: string, scope: string, columns: string[]): Classification {
		const entry = this.sessions.get(session)?.get(scope);
		const result: Classification = { approved: [], denied: [], undecided: [] };
		for (const column of columns) {
			if (ALWAYS_INCLUDED.has(column) || entry?.approved.has(column)) {
				result.approved.push(column);
			} else if (entry?.denied.has(column)) {
				result.denied.push(column);
			} else {
				result.undecided.push(column);
			}
		}
		return result;
	}

	/** Records a decision. A column moves between approved and denied freely. */
	record(session: string, scope: string, approved: Iterable<string>, denied: Iterable<string>): void {
		let scopes = this.sessions.get(session);
		if (!scopes) {
			scopes = new Map();
			this.sessions.set(session, scopes);
		}
		let entry = scopes.get(scope);
		if (!entry) {
			entry = { approved: new Set(), denied: new Set() };
			scopes.set(scope, entry);
		}
		for (const column of approved) {
			entry.approved.add(column);
			entry.denied.delete(column);
		}
		for (const column of denied) {
			if (ALWAYS_INCLUDED.has(column)) {
				continue;
			}
			entry.denied.add(column);
			entry.approved.delete(column);
		}
		this.changed();
	}

	/** Forgets one session, or every session when omitted. */
	reset(session?: string): void {
		if (session === undefined) {
			this.sessions.clear();
		} else {
			this.sessions.delete(session);
		}
		this.changed();
	}

	/** A read-only snapshot, for the status bar and the reset picker. */
	snapshot(session?: string): { session: string; scope: string; approved: string[]; denied: string[] }[] {
		const rows: { session: string; scope: string; approved: string[]; denied: string[] }[] = [];
		for (const [id, scopes] of this.sessions) {
			if (session !== undefined && id !== session) {
				continue;
			}
			for (const [scope, entry] of scopes) {
				rows.push({ session: id, scope, approved: [...entry.approved].sort(), denied: [...entry.denied].sort() });
			}
		}
		return rows;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private changed(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
