import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';

/** Name of the entry in Claude Code's user-scope MCP configuration. */
export const CLAUDE_SERVER_NAME = 'odoo-inspector';
const REGISTERED_URL_KEY = 'odooInspector.claudeCodeUrl';
const HEADERS_FILE = 'claude-code-headers.json';

/**
 * Makes the in-process MCP server available to Claude Code.
 *
 * Claude Code does not read servers registered through
 * `vscode.lm.registerMcpServerDefinitionProvider`; it only reads its own
 * configuration. This writes a user-scope entry with `claude mcp add-json`.
 * The bearer token is not put in that configuration: the entry's
 * `headersHelper` prints a headers file kept in the extension's global
 * storage, readable by the user only.
 */
export class ClaudeCodeRegistration {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly url: string,
		private readonly token: string,
		private readonly log: (message: string) => void,
	) {}

	/** The command: (re)registers the server with Claude Code. */
	async register(): Promise<void> {
		const cli = claudeCli();
		try {
			const headers = await this.writeHeaders();
			const config = { type: 'http', url: this.url, headersHelper: headersHelper(headers) };
			// `add-json` refuses an existing name; a missing entry makes `remove` fail, which is fine.
			await run(cli, ['mcp', 'remove', '--scope', 'user', CLAUDE_SERVER_NAME]).catch(() => undefined);
			await run(cli, ['mcp', 'add-json', '--scope', 'user', CLAUDE_SERVER_NAME, JSON.stringify(config)]);
			await this.context.globalState.update(REGISTERED_URL_KEY, this.url);
			this.log(`Registered ${this.url} with Claude Code as "${CLAUDE_SERVER_NAME}" (${cli})`);
			void vscode.window.showInformationMessage(
				`Added Odoo Inspector to Claude Code as "${CLAUDE_SERVER_NAME}" (user scope). New Claude Code conversations can use it; restart open ones.`,
			);
		} catch (error) {
			this.log(`Could not register with Claude Code: ${(error as Error).message}`);
			void vscode.window.showErrorMessage(`Could not add Odoo Inspector to Claude Code: ${(error as Error).message}`);
		}
	}

	/**
	 * On activation, when the user registered before: refreshes the headers
	 * file and warns if this window serves a different URL than the one
	 * Claude Code was given (e.g. the preferred port was taken).
	 */
	async refresh(): Promise<void> {
		const registered = this.context.globalState.get<string>(REGISTERED_URL_KEY);
		if (!registered) {
			return;
		}
		await this.writeHeaders();
		if (registered !== this.url) {
			const choice = await vscode.window.showWarningMessage(
				`Claude Code is set up to use Odoo Inspector at ${registered}, but this window serves ${this.url} (another VS Code window may hold the port).`,
				'Point Claude Code Here',
			);
			if (choice) {
				await this.register();
			}
		}
	}

	private async writeHeaders(): Promise<string> {
		const dir = this.context.globalStorageUri.fsPath;
		await mkdir(dir, { recursive: true });
		const file = join(dir, HEADERS_FILE);
		await writeFile(file, JSON.stringify({ Authorization: `Bearer ${this.token}` }), { mode: 0o600 });
		await chmod(file, 0o600);
		return file;
	}
}

/** Shell command Claude Code runs to get the headers; it must print a JSON object. */
function headersHelper(file: string): string {
	return process.platform === 'win32' ? `type "${file}"` : `cat '${file.replace(/'/g, `'\\''`)}'`;
}

/** Prefers the CLI bundled with the Claude Code extension, which may not be on PATH. */
function claudeCli(): string {
	const extension = vscode.extensions.getExtension('anthropic.claude-code');
	if (extension) {
		return join(extension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
	}
	return 'claude';
}

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 30_000, shell: process.platform === 'win32' && file === 'claude' }, (error, stdout, stderr) => {
			if (error) {
				const code = (error as NodeJS.ErrnoException).code;
				reject(new Error(code === 'ENOENT' ? 'the Claude Code CLI was not found. Install the Claude Code extension or put `claude` on PATH.' : (stderr || stdout || error.message).trim()));
				return;
			}
			resolve(stdout);
		});
	});
}
