import * as assert from 'node:assert/strict';
import { OdooError } from '../odoo/errors';
import { decodeMethodResponse, encodeMethodCall, encodeValue } from '../odoo/protocols/xmlrpcCodec';

/** Wraps a `<value>` the way Python's `xmlrpc.client.dumps` does, newlines included. */
function response(value: string): string {
	return `<?xml version='1.0'?>\n<methodResponse>\n<params>\n<param>\n${value}\n</param>\n</params>\n</methodResponse>\n`;
}

suite('xmlrpcCodec', () => {
	test('encodes scalars, nil, arrays and structs', () => {
		assert.equal(encodeValue(null), '<value><nil/></value>');
		assert.equal(encodeValue(true), '<value><boolean>1</boolean></value>');
		assert.equal(encodeValue(42), '<value><int>42</int></value>');
		assert.equal(encodeValue(2 ** 40), `<value><double>${2 ** 40}</double></value>`);
		assert.equal(encodeValue(1.5), '<value><double>1.5</double></value>');
		assert.equal(encodeValue('a<b&c'), '<value><string>a&lt;b&amp;c</string></value>');
		assert.equal(
			encodeValue({ a: [1, 'x'], skip: undefined }),
			'<value><struct><member><name>a</name><value><array><data><value><int>1</int></value><value><string>x</string></value></data></array></value></member></struct></value>',
		);
	});

	test('encodes a method call', () => {
		assert.equal(
			encodeMethodCall('authenticate', ['db', 'admin', 'pw', {}]),
			'<?xml version="1.0"?><methodCall><methodName>authenticate</methodName><params>' +
				'<param><value><string>db</string></value></param><param><value><string>admin</string></value></param>' +
				'<param><value><string>pw</string></value></param><param><value><struct></struct></value></param></params></methodCall>',
		);
	});

	test('decodes every type, with Python-style whitespace', () => {
		const xml = response(
			'<value><array><data>\n' +
				'<value><int>7</int></value>\n' +
				'<value><i4>-3</i4></value>\n' +
				'<value><double>2.5</double></value>\n' +
				'<value><boolean>0</boolean></value>\n' +
				'<value><string> padded </string></value>\n' +
				'<value>bare text</value>\n' +
				'<value><string></string></value>\n' +
				'<value><nil/></value>\n' +
				'<value><array><data>\n</data></array></value>\n' +
				'<value><struct>\n<member>\n<name>id</name>\n<value><int>1</int></value>\n</member>\n' +
				'<member>\n<name>partner_id</name>\n<value><array><data>\n<value><int>3</int></value>\n<value><string>Azure &amp; Co</string></value>\n</data></array></value>\n</member>\n</struct></value>\n' +
				'</data></array></value>',
		);
		assert.deepEqual(decodeMethodResponse(xml), [
			7,
			-3,
			2.5,
			false,
			' padded ',
			'bare text',
			'',
			null,
			[],
			{ id: 1, partner_id: [3, 'Azure & Co'] },
		]);
	});

	test('decodes a single-element array as an array', () => {
		assert.deepEqual(decodeMethodResponse(response('<value><array><data><value><int>1</int></value></data></array></value>')), [1]);
	});

	test('round-trips nested values', () => {
		const value = { domain: [['name', 'ilike', 'a']], limit: 5, active: false, ctx: { lang: 'en_US' } };
		assert.deepEqual(decodeMethodResponse(response(encodeValue(value))), value);
	});

	test('turns faults into OdooError with the Odoo exception kind', () => {
		const fault =
			"<?xml version='1.0'?>\n<methodResponse>\n<fault>\n<value><struct>\n" +
			'<member>\n<name>faultCode</name>\n<value><string>You are not allowed to access this document.</string></value>\n</member>\n' +
			'<member>\n<name>faultString</name>\n<value><string>Traceback (most recent call last):\nodoo.exceptions.AccessError: You are not allowed</string></value>\n</member>\n' +
			'</struct></value>\n</fault>\n</methodResponse>\n';
		assert.throws(
			() => decodeMethodResponse(fault),
			(error: unknown) =>
				error instanceof OdooError && error.kind === 'access' && error.message === 'You are not allowed to access this document.',
		);
	});

	test('rejects non-XML-RPC bodies', () => {
		assert.throws(() => decodeMethodResponse('<html><body>Not Found</body></html>'), OdooError);
	});
});
