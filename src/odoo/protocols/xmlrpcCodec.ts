import { XMLParser } from 'fast-xml-parser';
import { hintFor, kindOf, OdooError } from '../errors';

/**
 * The XML-RPC subset Odoo speaks: Python's `xmlrpc.client` with `allow_none`.
 *
 * Values: int/i4, double, boolean, string (or bare text), array, struct,
 * nil, dateTime.iso8601 and base64.
 */

const MAX_I4 = 2 ** 31 - 1;
const MIN_I4 = -(2 ** 31);

export function encodeMethodCall(method: string, params: unknown[]): string {
	const body = params.map((param) => `<param>${encodeValue(param)}</param>`).join('');
	return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${body}</params></methodCall>`;
}

export function encodeValue(value: unknown): string {
	return `<value>${encodeInner(value)}</value>`;
}

function encodeInner(value: unknown): string {
	if (value === null || value === undefined) {
		return '<nil/>';
	}
	switch (typeof value) {
		case 'boolean':
			return `<boolean>${value ? 1 : 0}</boolean>`;
		case 'number':
			// Python's marshaller rejects ints outside i4 range, so send those as doubles.
			return Number.isInteger(value) && value >= MIN_I4 && value <= MAX_I4
				? `<int>${value}</int>`
				: `<double>${value}</double>`;
		case 'string':
			return `<string>${escapeXml(value)}</string>`;
		case 'bigint':
			return `<string>${value}</string>`;
	}
	if (value instanceof Date) {
		return `<dateTime.iso8601>${formatDateTime(value)}</dateTime.iso8601>`;
	}
	if (value instanceof Uint8Array) {
		return `<base64>${Buffer.from(value).toString('base64')}</base64>`;
	}
	if (Array.isArray(value)) {
		return `<array><data>${value.map(encodeValue).join('')}</data></array>`;
	}
	if (typeof value === 'object') {
		const members = Object.entries(value as Record<string, unknown>)
			.filter(([, member]) => member !== undefined)
			.map(([name, member]) => `<member><name>${escapeXml(name)}</name>${encodeValue(member)}</member>`)
			.join('');
		return `<struct>${members}</struct>`;
	}
	throw new OdooError(`Cannot encode ${typeof value} as XML-RPC.`, 'protocol');
}

/** `20260123T14:05:09`, the format Python's `xmlrpc.client.DateTime` uses. */
function formatDateTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
	);
}

export function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const parser = new XMLParser({
	ignoreAttributes: true,
	parseTagValue: false,
	trimValues: false,
	// Repeated children must always be arrays, even when there is only one.
	isArray: (name) => name === 'value' || name === 'member' || name === 'param',
	processEntities: true,
});

type Node = Record<string, unknown>;

/** Decodes a `methodResponse`, throwing `OdooError` for a fault. */
export function decodeMethodResponse(xml: string): unknown {
	let doc: Node;
	try {
		doc = parser.parse(xml) as Node;
	} catch (error) {
		throw new OdooError(`Malformed XML-RPC response: ${(error as Error).message}`, 'protocol');
	}
	const response = doc.methodResponse as Node | undefined;
	if (!response || typeof response !== 'object') {
		throw new OdooError('The server did not return an XML-RPC methodResponse.', 'protocol', 'Check the URL points at an Odoo server.');
	}
	if (response.fault) {
		const fault = decodeValue(firstValue(response.fault as Node)) as { faultCode?: unknown; faultString?: string };
		throw faultToError(fault);
	}
	const params = (response.params as Node | undefined)?.param as Node[] | undefined;
	if (!params?.length) {
		return null;
	}
	return decodeValue(firstValue(params[0]));
}

function firstValue(node: Node): Node | string {
	const values = node.value as (Node | string)[] | undefined;
	if (!values?.length) {
		throw new OdooError('XML-RPC element has no <value>.', 'protocol');
	}
	return values[0];
}

/** Child element names of a parsed node, ignoring whitespace text. */
function elements(node: Node): string[] {
	return Object.keys(node).filter((key) => key !== '#text');
}

export function decodeValue(node: Node | string): unknown {
	// `<value>text</value>` with no type element is a string.
	if (typeof node === 'string') {
		return node;
	}
	const [type] = elements(node);
	if (!type) {
		return typeof node['#text'] === 'string' ? node['#text'] : '';
	}
	const inner = node[type];
	const text = typeof inner === 'string' ? inner : typeof inner === 'object' && inner ? String((inner as Node)['#text'] ?? '') : '';

	switch (type) {
		case 'int':
		case 'i4':
		case 'i8':
			return Number.parseInt(text.trim(), 10);
		case 'double':
			return Number.parseFloat(text.trim());
		case 'boolean':
			return text.trim() === '1';
		case 'string':
			return text;
		case 'nil':
			return null;
		case 'dateTime.iso8601':
			// Odoo serializes datetimes as strings; a real dateTime is rare, keep it as text.
			return text.trim();
		case 'base64':
			return text.replace(/\s+/g, '');
		case 'array': {
			const data = (inner as Node | string | undefined) && typeof inner === 'object' ? ((inner as Node).data as Node | string | undefined) : undefined;
			const values = data && typeof data === 'object' ? ((data.value as (Node | string)[] | undefined) ?? []) : [];
			return values.map(decodeValue);
		}
		case 'struct': {
			const members = inner && typeof inner === 'object' ? (((inner as Node).member as Node[] | undefined) ?? []) : [];
			const result: Record<string, unknown> = {};
			for (const member of members) {
				const name = String(member.name ?? '');
				result[name] = decodeValue(firstValue(member));
			}
			return result;
		}
		default:
			throw new OdooError(`Unsupported XML-RPC type <${type}>.`, 'protocol');
	}
}

/**
 * Odoo puts the exception text in `faultString` (with a traceback) and the
 * exception message, or a numeric code, in `faultCode`.
 */
function faultToError(fault: { faultCode?: unknown; faultString?: string }): OdooError {
	const faultString = fault.faultString ?? '';
	const odooName = /\b(odoo\.(?:exceptions|http)\.\w+)/.exec(faultString)?.[1] ?? (/Access Denied/i.test(faultString) ? 'odoo.exceptions.AccessDenied' : undefined);
	const lastLine = faultString.trim().split('\n').at(-1) ?? '';
	const message =
		(typeof fault.faultCode === 'string' && fault.faultCode.trim()) ||
		lastLine.replace(/^[\w.]+:\s*/, '') ||
		'Odoo returned an XML-RPC fault.';
	const kind = kindOf(odooName);
	return new OdooError(message, kind, hintFor(kind, odooName), odooName);
}
