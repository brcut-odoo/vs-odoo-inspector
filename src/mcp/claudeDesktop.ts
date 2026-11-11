import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { DESKTOP_SERVER_NAME, desktopConfigPath, desktopEntry, withDesktopServer } from './desktopConfig';

const REGISTERED_URL_KEY = 'odooInspector.claudeDesktopUrl';
const HEADERS_FILE = 'claude-desktop-headers.txt';

/**
 * Makes the in-process MCP server available to Claude Desktop.
 *
 * Desktop only launches stdio servers from its config file, and its remote
 * connectors are called from Anthropic's servers, which can't reach
 * 127.0.0.1. So the entry runs `mcp-remote`, which bridges stdio to our HTTP
 * endpoint. The bearer token stays out of Desktop's config: `mcp-remote`
 * reads it from a headers file in the extension's global storage, readable
 * by the user only.
 */
export class ClaudeDesktopRegistration {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly url: string,
		private readonly token: string,
		private readonly log: (message: string) => void,
	) {}

	/** The command: adds or updates the entry in Claude Desktop's config. */
	async register(): Promise<void> {
		try {
			if (vscode.env.remoteName) {
				throw new Error(`this window runs the extension on a remote host (${vscode.env.remoteName}), which Claude Desktop on this computer can't reach. Use a local window.`);
			}
			const configPath = desktopConfigPath();
			try {
				await access(dirname(configPath));
			} catch {
				throw new Error(`Claude Desktop doesn't seem to be installed: ${dirname(configPath)} does not exist. Install and open it once, then retry.`);
			}
			const headers = await this.writeHeaders();
			const raw = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					return undefined;
				}
				throw error;
			});
			let next: string;
			try {
				next = withDesktopServer(raw, desktopEntry(this.url, headers));
			} catch (error) {
				throw new Error(`left ${configPath} untouched because ${(error as Error).message}. Fix it and retry.`);
			}
			// Write beside it and rename, so Desktop never reads a half-written file.
			const temp = `${configPath}.odoo-inspector.tmp`;
			await writeFile(temp, next);
			await rename(temp, configPath);
			await this.context.globalState.update(REGISTERED_URL_KEY, this.url);
			this.log(`Registered ${this.url} with Claude Desktop as "${DESKTOP_SERVER_NAME}" in ${configPath}`);
			void vscode.window.showInformationMessage(
				`Added Odoo Inspector to Claude Desktop as "${DESKTOP_SERVER_NAME}". Quit and reopen Claude Desktop to load it. Node.js (npx) must be installed, and this VS Code window must stay open.`,
			);
		} catch (error) {
			this.log(`Could not register with Claude Desktop: ${(error as Error).message}`);
			void vscode.window.showErrorMessage(`Could not add Odoo Inspector to Claude Desktop: ${(error as Error).message}`);
		}
	}

	/**
	 * On activation, when the user registered before: refreshes the headers
	 * file and warns if this window serves a different URL than the one
	 * Claude Desktop was given (e.g. the preferred port was taken).
	 */
	async refresh(): Promise<void> {
		const registered = this.context.globalState.get<string>(REGISTERED_URL_KEY);
		if (!registered) {
			return;
		}
		await this.writeHeaders();
		if (registered !== this.url) {
			const choice = await vscode.window.showWarningMessage(
				`Claude Desktop is set up to use Odoo Inspector at ${registered}, but this window serves ${this.url} (another VS Code window may hold the port).`,
				'Point Claude Desktop Here',
			);
			if (choice) {
				await this.register();
			}
		}
	}

	/** `mcp-remote --header-file` format: one `Name: value` per line. */
	private async writeHeaders(): Promise<string> {
		const dir = this.context.globalStorageUri.fsPath;
		await mkdir(dir, { recursive: true });
		const file = join(dir, HEADERS_FILE);
		await writeFile(file, `Authorization: Bearer ${this.token}\n`, { mode: 0o600 });
		await chmod(file, 0o600);
		return file;
	}
}
