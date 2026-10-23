import { QuerySpec } from '../../odoo/types';
import { Column } from '../../query/columns';

/** Result metadata shown in the workbench footer. */
export interface ResultMeta {
	/** Number of rows returned. */
	rowCount: number;
	/** Wall-clock duration of the RPC, in milliseconds. */
	elapsedMs: number;
	/** Which backend served the request. */
	apiMode: string;
	/** The model that was queried. */
	model: string;
	/** Whether the row count hit the requested limit. */
	truncated: boolean;
}

/** Messages sent from the extension host to the webview. */
export type HostMessage =
	| {
			type: 'init';
			spec: QuerySpec;
			columns: Column[];
			rows: Record<string, unknown>[];
			meta?: ResultMeta;
			/** Whether the Execute button should be shown (false for read-only views). */
			editable: boolean;
	  }
	| { type: 'results'; rows: Record<string, unknown>[]; columns: Column[]; meta: ResultMeta }
	| { type: 'columns'; columns: Column[] }
	| { type: 'busy'; busy: boolean }
	| { type: 'error'; message: string; hint?: string }
	| { type: 'spec'; spec: QuerySpec };

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'toggleColumn'; field: string; enabled: boolean }
	| { type: 'execute'; spec: QuerySpec }
	| { type: 'cancel' }
	| { type: 'sort'; field: string; direction: 'asc' | 'desc' }
	| { type: 'addColumn'; field: string }
	| { type: 'openAdvanced' }
	| { type: 'copyJson' };

/** Narrows an arbitrary webview message to our union. */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const type = (value as { type?: unknown }).type;
	return (
		typeof type === 'string' &&
		[
			'ready',
			'toggleColumn',
			'execute',
			'cancel',
			'sort',
			'addColumn',
			'openAdvanced',
			'copyJson',
		].includes(type)
	);
}
