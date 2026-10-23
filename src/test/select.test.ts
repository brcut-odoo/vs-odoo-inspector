import * as assert from 'node:assert/strict';
import { OdooError } from '../odoo/errors';
import { detectAuthKind, parseVersionInfo, selectProtocol, supportsJson2 } from '../odoo/select';

const V17 = { major: 17, minor: 0 };
const V18_4 = parseVersionInfo(['saas~18', 4, 0, 'final', 0, ''], 'saas~18.4');
const V19 = parseVersionInfo([19, 0, 0, 'final', 0, ''], '19.0');
const UNKNOWN = {};

suite('select', () => {
	test('detects the credential kind from its shape', () => {
		assert.equal(detectAuthKind('0123456789abcdef0123456789abcdef01234567'), 'apiKey');
		assert.equal(detectAuthKind('a'.repeat(42)), 'session');
		assert.equal(detectAuthKind('Abc_-'.repeat(14)), 'session');
		assert.equal(detectAuthKind('hunter2'), 'password');
		assert.equal(detectAuthKind('0123456789ABCDEF0123456789ABCDEF01234567'), 'password');
	});

	test('parses version info, including saas', () => {
		assert.deepEqual(V18_4, { serverVersion: 'saas~18.4', major: 18, minor: 4 });
		assert.equal(supportsJson2(V18_4), false);
		assert.equal(supportsJson2({ major: 18, minor: 5 }), true);
		assert.equal(supportsJson2(V19), true);
		assert.equal(supportsJson2(UNKNOWN), false);
		assert.deepEqual(parseVersionInfo(undefined, '17.0+e'), { serverVersion: '17.0+e', major: 17, minor: 0 });
	});

	test('picks a protocol automatically', () => {
		assert.equal(selectProtocol('session', V19), 'callKw');
		assert.equal(selectProtocol('apiKey', V19), 'json2');
		assert.equal(selectProtocol('apiKey', V17), 'jsonrpc');
		assert.equal(selectProtocol('apiKey', UNKNOWN), 'jsonrpc');
		assert.equal(selectProtocol('password', V19), 'jsonrpc');
		assert.equal(selectProtocol('password', V19, 'auto'), 'jsonrpc');
	});

	test('honours a forced protocol when it fits the credential', () => {
		assert.equal(selectProtocol('password', V17, 'xmlrpc'), 'xmlrpc');
		assert.equal(selectProtocol('password', V17, 'callKw'), 'callKw');
		assert.equal(selectProtocol('apiKey', V19, 'jsonrpc'), 'jsonrpc');
		assert.equal(selectProtocol('apiKey', UNKNOWN, 'json2'), 'json2');
	});

	test('rejects forced protocols that cannot work', () => {
		for (const [kind, forced] of [
			['session', 'xmlrpc'],
			['session', 'jsonrpc'],
			['session', 'json2'],
			['password', 'json2'],
			['apiKey', 'callKw'],
		] as const) {
			assert.throws(() => selectProtocol(kind, V19, forced), OdooError, `${kind} + ${forced}`);
		}
		assert.throws(() => selectProtocol('apiKey', V17, 'json2'), /18\.5/);
	});
});
