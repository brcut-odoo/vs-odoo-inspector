import { homedir } from 'node:os';
import { join } from 'node:path';

// Kept free of `vscode` so the unit tests can load it.

/** Name of the entry in Claude Desktop's `mcpServers`. */
export const DESKTOP_SERVER_NAME = 'odoo-inspector';
/** Bridges Desktop's stdio transport to our Streamable HTTP server. Pinned; `--header-file` needs ≥ 0.15. */
export const MCP_REMOTE = 'mcp-remote@0.15.2';

export interface DesktopServerEntry {
	command: string;
	args: string[];
}

/** Where Claude Desktop reads its configuration on this platform. */
export function desktopConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	if (platform === 'darwin') {
		return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
	}
	if (platform === 'win32') {
		return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
	}
	// No official Linux build; community builds use the XDG location.
	return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** The token is not in the entry: `mcp-remote` reads it from `headersFile`. */
export function desktopEntry(url: string, headersFile: string): DesktopServerEntry {
	return { command: 'npx', args: ['-y', MCP_REMOTE, url, '--header-file', headersFile] };
}

/**
 * Returns `raw` (the config file's text, or undefined when it doesn't exist)
 * with our server set, keeping every other key. Throws on a file that isn't a
 * JSON object rather than overwriting it.
 */
export function withDesktopServer(raw: string | undefined, entry: DesktopServerEntry): string {
	let config: Record<string, unknown> = {};
	if (raw !== undefined && raw.trim() !== '') {
		const parsed: unknown = JSON.parse(raw);
		if (!isObject(parsed)) {
			throw new Error('the file is not a JSON object');
		}
		config = parsed;
	}
	const servers = config.mcpServers ?? {};
	if (!isObject(servers)) {
		throw new Error('its "mcpServers" is not an object');
	}
	config.mcpServers = { ...servers, [DESKTOP_SERVER_NAME]: entry };
	return `${JSON.stringify(config, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
