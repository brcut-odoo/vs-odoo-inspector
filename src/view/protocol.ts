/**
 * The contract between the approval view and the server's app-only tools.
 * Shared by both sides; only types, so the view bundle stays small.
 */
import type { Preview } from '../approval/broker';

export const VIEW_URI = 'ui://odoo-inspector/approval';

export const TOOL_PREVIEW = 'odoo_approval_preview';
export const TOOL_DECIDE = 'odoo_approval_decide';
export const TOOL_RESET = 'odoo_approval_reset';

/** Key of the tool result `_meta` entry the view reads. Not model-facing. */
export const SUMMARY_META = 'odooInspector/summary';

export type PreviewResponse =
	| { status: 'pending'; preview: Preview }
	/** Still fetching from Odoo: ask again shortly. */
	| { status: 'loading' }
	/** Nothing to review: auto-approved, failed, or already decided. */
	| { status: 'none' };

export interface DecideArgs {
	id: string;
	approved: boolean;
	columns: string[];
}

export interface ResultSummary {
	outcome: 'approved' | 'auto-approved' | 'denied' | 'expired' | 'cancelled' | 'error';
	rows?: number;
	columns?: string[];
	withheld?: string[];
	message?: string;
}

export type { Preview, PreviewColumn } from '../approval/broker';
