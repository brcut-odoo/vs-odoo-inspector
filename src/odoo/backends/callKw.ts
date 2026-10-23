import { OdooError, QuerySpec } from '../types';
import { Transport, extractErrorMessage } from '../transport';
import { RpcBackend, baseShape, methodName } from './backend';

/**
 * `/web/dataset/call_kw` backend.
 *
 * Payload shape (from `support-tools/lib/rpc/odoo_jsonrpc.py`):
 * ```json
 * { "jsonrpc": "2.0", "method": "call", "id": 0,
 *   "params": { "model": "...", "method": "...", "args": [], "kwargs": {} } }
 * ```
 * Authentication is a `session_id` cookie; there is no login call.
 */
export class CallKwBackend implements RpcBackend {
	readonly name = 'call_kw';

	constructor(private readonly transport: Transport) {}

	shape(spec: QuerySpec): { args: unknown[]; kwargs: Record<string, unknown> } {
		return baseShape(spec);
	}

	async call(spec: QuerySpec, signal?: AbortSignal): Promise<unknown> {
		const { args, kwargs } = this.shape(spec);
		const payload = {
			jsonrpc: '2.0',
			method: 'call',
			id: 0,
			params: {
				model: spec.model,
				method: methodName(spec),
				args,
				kwargs,
			},
		};

		const response = await this.transport.postJson('/web/dataset/call_kw', payload);
		return unwrapJsonRpcResult(response.body, spec);
	}
}

/**
 * Unwraps a JSON-RPC envelope, raising a typed error when Odoo reported one.
 *
 * Note: `call_kw` returns HTTP 200 even for application errors, so the error
 * check has to happen on the body rather than the status code.
 */
export function unwrapJsonRpcResult(body: unknown, spec: QuerySpec): unknown {
	if (!body || typeof body !== 'object') {
		throw new OdooError(
			`Unexpected empty response from ${spec.model}.${methodName(spec)}`,
			'server',
			undefined,
			body,
		);
	}

	const record = body as Record<string, unknown>;
	if (record.error) {
		const message =
			extractErrorMessage(body) ?? `Call to ${spec.model}.${methodName(spec)} failed`;
		throw new OdooError(message, classifyOdooError(message), undefined, record.error);
	}

	return record.result;
}

/** Maps Odoo's error text onto our error kinds. */
export function classifyOdooError(message: string): OdooError['kind'] {
	if (/access\s*(denied|error)|not allowed to access|access rights/i.test(message)) {
		return 'access';
	}
	if (/does not exist|not found|invalid model|no such method/i.test(message)) {
		return 'notFound';
	}
	if (/validation|invalid|expected|must be|cannot|missing/i.test(message)) {
		return 'validation';
	}
	if (/session|expired|log ?in|credential|api key/i.test(message)) {
		return 'auth';
	}
	return 'server';
}
