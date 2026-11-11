import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { DESKTOP_SERVER_NAME, desktopConfigPath, desktopEntry, MCP_REMOTE, withDesktopServer } from '../mcp/desktopConfig';

suite('claude desktop config', () => {
	const entry = desktopEntry('http://127.0.0.1:1234/mcp', '/s/headers.txt');

	test('builds an mcp-remote entry that reads the token from the headers file', () => {
		assert.deepEqual(entry, {
			command: 'npx',
			args: ['-y', MCP_REMOTE, 'http://127.0.0.1:1234/mcp', '--header-file', '/s/headers.txt'],
		});
		assert.ok(!JSON.stringify(entry).includes('Bearer'));
	});

	test('creates the config when there is none', () => {
		assert.deepEqual(JSON.parse(withDesktopServer(undefined, entry)), { mcpServers: { [DESKTOP_SERVER_NAME]: entry } });
		assert.deepEqual(JSON.parse(withDesktopServer('  \n', entry)), { mcpServers: { [DESKTOP_SERVER_NAME]: entry } });
	});

	test('keeps other servers and settings, and replaces our previous entry', () => {
		const raw = JSON.stringify({
			globalShortcut: 'Ctrl+Space',
			mcpServers: { other: { command: 'x' }, [DESKTOP_SERVER_NAME]: { command: 'old', args: [] } },
		});
		assert.deepEqual(JSON.parse(withDesktopServer(raw, entry)), {
			globalShortcut: 'Ctrl+Space',
			mcpServers: { other: { command: 'x' }, [DESKTOP_SERVER_NAME]: entry },
		});
	});

	test('refuses files it would clobber', () => {
		assert.throws(() => withDesktopServer('{ broken', entry));
		assert.throws(() => withDesktopServer('[]', entry), /not a JSON object/);
		assert.throws(() => withDesktopServer('{"mcpServers": []}', entry), /mcpServers/);
	});

	test('resolves the config path per platform', () => {
		assert.equal(desktopConfigPath('darwin', {}, '/Users/u'), join('/Users/u', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
		assert.equal(desktopConfigPath('win32', { APPDATA: 'C:\\AppData' }, 'C:\\Users\\u'), join('C:\\AppData', 'Claude', 'claude_desktop_config.json'));
		assert.equal(desktopConfigPath('linux', {}, '/home/u'), join('/home/u', '.config', 'Claude', 'claude_desktop_config.json'));
		assert.equal(desktopConfigPath('linux', { XDG_CONFIG_HOME: '/x' }, '/home/u'), join('/x', 'Claude', 'claude_desktop_config.json'));
	});
});
