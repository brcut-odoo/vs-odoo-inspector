import * as assert from 'assert';
import {
	apiModeForVersion,
	normalizeVersion,
	parseVersionPayload,
	parseVersionString,
} from '../odoo/version';

suite('Version detection', () => {
	test('parses a plain version string', () => {
		assert.deepStrictEqual(parseVersionString('19.0'), [19, 0]);
		assert.deepStrictEqual(parseVersionString('17.0+e'), [17, 0]);
		assert.deepStrictEqual(parseVersionString('18.4.1'), [18, 4, 1]);
	});

	test('strips the saas~ prefix', () => {
		assert.deepStrictEqual(parseVersionString('saas~18.4'), [18, 4]);
		assert.deepStrictEqual(parseVersionString('saas-19.1'), [19, 1]);
	});

	test('normalizes saas-prefixed version arrays', () => {
		assert.deepStrictEqual(normalizeVersion(['saas~19', 4, 0, 'e']), [19, 4]);
		assert.deepStrictEqual(normalizeVersion([17, 0, 0, 'final', 0, '']), [17, 0]);
	});

	test('selects call_kw below 18.5', () => {
		assert.strictEqual(apiModeForVersion([17, 0, 0, 'final']), 'callKw');
		assert.strictEqual(apiModeForVersion([18, 0, 0, 'final']), 'callKw');
		assert.strictEqual(apiModeForVersion([18, 4, 0, 'final']), 'callKw');
	});

	test('selects json2 at 18.5 and above', () => {
		assert.strictEqual(apiModeForVersion([18, 5, 0, 'final']), 'json2');
		assert.strictEqual(apiModeForVersion([19, 0, 0, 'final']), 'json2');
		assert.strictEqual(apiModeForVersion([20, 0, 0, 'final']), 'json2');
	});

	test('handles saas version arrays', () => {
		assert.strictEqual(apiModeForVersion(['saas~18', 4, 0, 'e']), 'callKw');
		assert.strictEqual(apiModeForVersion(['saas~19', 1, 0, 'e']), 'json2');
	});

	test('falls back to call_kw when the version is unparseable', () => {
		assert.strictEqual(apiModeForVersion([]), 'callKw');
	});

	test('parses the /json/version payload', () => {
		const result = parseVersionPayload({
			version_info: [19, 0, 0, 'final', 0, ''],
			version: '19.0+e',
		});

		assert.ok(result);
		assert.strictEqual(result.serverVersion, '19.0+e');
		assert.strictEqual(result.apiMode, 'json2');
	});

	test('parses the /web/webclient/version_info payload', () => {
		const result = parseVersionPayload({
			server_version: '17.0',
			server_version_info: [17, 0, 0, 'final', 0, ''],
			server_serie: '17.0',
		});

		assert.ok(result);
		assert.strictEqual(result.apiMode, 'callKw');
	});

	test('unwraps a JSON-RPC envelope', () => {
		const result = parseVersionPayload({
			jsonrpc: '2.0',
			id: 0,
			result: { server_version: '18.4', server_version_info: [18, 4, 0, 'final'] },
		});

		assert.ok(result);
		assert.strictEqual(result.apiMode, 'callKw');
	});

	test('returns undefined for an unrecognized payload', () => {
		assert.strictEqual(parseVersionPayload({ foo: 'bar' }), undefined);
		assert.strictEqual(parseVersionPayload(null), undefined);
	});
});
