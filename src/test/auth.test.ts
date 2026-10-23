import * as assert from 'assert';
import { resolveAuthMode } from '../odoo/client';
import { extractSessionCookie, normalizeBaseUrl } from '../odoo/transport';
import { ConnectionConfig } from '../odoo/types';

/** A 40-character hex key, the shape `res.users.apikeys._generate` produces. */
const API_KEY = 'a'.repeat(40);
/** A 42-character url-safe id, the shape werkzeug uses for sessions. */
const SESSION_ID = 'Z'.repeat(42);

function connection(authMode?: ConnectionConfig['authMode']): ConnectionConfig {
	return {
		name: 'test',
		url: 'https://example.odoo.com',
		db: 'db',
		login: 'admin',
		authMode,
	};
}

suite('Auth mode resolution', () => {
	test('an explicit auth mode wins over the credential shape', () => {
		assert.strictEqual(resolveAuthMode(connection('password'), API_KEY), 'password');
		assert.strictEqual(resolveAuthMode(connection('session'), 'admin'), 'session');
		assert.strictEqual(resolveAuthMode(connection('apiKey'), 'admin'), 'apiKey');
	});

	test('auto treats a 40-character hex credential as an API key', () => {
		assert.strictEqual(resolveAuthMode(connection('auto'), API_KEY), 'apiKey');
		assert.strictEqual(resolveAuthMode(connection(), API_KEY.toUpperCase()), 'apiKey');
	});

	test('auto treats a 42-character url-safe credential as a session id', () => {
		assert.strictEqual(resolveAuthMode(connection('auto'), SESSION_ID), 'session');
	});

	test('auto treats anything else as a password', () => {
		// The bug this guards: a short password used to be sent as a session_id,
		// which Odoo answered with "Session expired".
		assert.strictEqual(resolveAuthMode(connection('auto'), 'admin'), 'password');
		assert.strictEqual(resolveAuthMode(connection(), 'correct horse battery staple'), 'password');
		// 40 characters, but not hex.
		assert.strictEqual(resolveAuthMode(connection('auto'), 'p'.repeat(40)), 'password');
	});

	test('ignores surrounding whitespace', () => {
		assert.strictEqual(resolveAuthMode(connection('auto'), `  ${API_KEY}\n`), 'apiKey');
	});

	test('a password is never mistaken for an API key or a session', () => {
		for (const password of ['admin', 'admin123', 'Odoo_is_fun!2024', 'x'.repeat(39)]) {
			assert.strictEqual(resolveAuthMode(connection('auto'), password), 'password');
		}
	});
});

suite('Session cookie parsing', () => {
	test('reads a session id from a simple Set-Cookie header', () => {
		const headers = new Headers({
			'set-cookie': `session_id=${SESSION_ID}; Path=/; HttpOnly`,
		});
		assert.strictEqual(extractSessionCookie(headers), SESSION_ID);
	});

	test('finds session_id among other cookies', () => {
		const headers = new Headers({
			'set-cookie': 'cids=1-2; Path=/; HttpOnly, session_id=abc123; Path=/; HttpOnly',
		});
		assert.strictEqual(extractSessionCookie(headers), 'abc123');
	});

	test('returns undefined when the cookie is absent or empty', () => {
		assert.strictEqual(extractSessionCookie(new Headers()), undefined);
		assert.strictEqual(extractSessionCookie(new Headers({ 'set-cookie': 'cids=1' })), undefined);
	});

	test('decodes a percent-encoded session id', () => {
		const headers = new Headers({ 'set-cookie': 'session_id=a%2Bb; Path=/' });
		assert.strictEqual(extractSessionCookie(headers), 'a+b');
	});
});

suite('Base URL normalization', () => {
	test('adds a scheme and strips trailing slashes', () => {
		assert.strictEqual(normalizeBaseUrl('localhost:8069///'), 'https://localhost:8069');
		assert.strictEqual(normalizeBaseUrl('http://localhost:8069/'), 'http://localhost:8069');
	});
});
