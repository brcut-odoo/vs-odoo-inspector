import * as vscode from 'vscode';
import { CredentialStore } from '../config/secrets';
import { findConnection, getConnections, getMaxRows, getRateLimit } from '../config/settings';

export const MCP_PROVIDER_ID = 'odooInspector.mcp';

/**
 * Registers the bundled stdio MCP server with VS Code.
 *
 * The server is a separate Node process (`dist/mcpServer.js`), so connection
 * details are passed through the environment rather than shared memory.
 * Credentials are read from `SecretStorage` at resolve time, which is why
 * `resolveMcpServerDefinition` exists.
 */
export class McpProvider implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changeEmitter = new vscode.EventEmitter<void>();

	constructor(
		private readonly credentials: CredentialStore,
		private readonly extensionUri: vscode.Uri,
	) {
		this.disposables.push(
			vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
				onDidChangeMcpServerDefinitions: this.changeEmitter.event,
				provideMcpServerDefinitions: () => this.provide(),
				resolveMcpServerDefinition: (server) => this.resolve(server),
			}),
		);
		this.disposables.push(this.changeEmitter);
	}

	/** Notifies VS Code that the connection list changed. */
	refresh(): void {
		this.changeEmitter.fire();
	}

	private provide(): vscode.McpServerDefinition[] {
		const connections = getConnections();
		if (connections.length === 0) {
			return [];
		}

		return connections.map((connection) => {
			const server = new vscode.McpStdioServerDefinition(
				`Odoo: ${connection.name}`,
				process.execPath,
				[vscode.Uri.joinPath(this.extensionUri, 'dist', 'mcpServer.js').fsPath],
				{
					ELECTRON_RUN_AS_NODE: '1',
					ODOO_URL: connection.url,
					ODOO_DB: connection.db,
					ODOO_LOGIN: connection.login,
					ODOO_AUTH_MODE: connection.authMode ?? 'auto',
					ODOO_RATE_LIMIT: String(getRateLimit()),
					ODOO_MAX_ROWS: String(getMaxRows()),
				},
				'0.1.0',
			);
			server.cwd = this.extensionUri;
			return server;
		});
	}

	/**
	 * Injects the credential just before the server starts.
	 *
	 * Returning `undefined` cancels the start, which is what happens when the
	 * user dismisses the credential prompt.
	 */
	private async resolve(
		server: vscode.McpServerDefinition,
	): Promise<vscode.McpServerDefinition | undefined> {
		if (!(server instanceof vscode.McpStdioServerDefinition)) {
			return server;
		}

		const label = server.label.replace(/^Odoo:\s*/, '');
		const connection = findConnection(label);
		if (!connection) {
			return server;
		}

		const credential = await this.credentials.getOrPrompt(
			connection.name,
			connection.login,
			connection.authMode,
		);
		if (!credential) {
			return undefined;
		}

		server.env = {
			...server.env,
			ODOO_CREDENTIAL: credential,
			ODOO_URL: connection.url,
			ODOO_DB: connection.db,
			ODOO_LOGIN: connection.login,
		};
		return server;
	}

	dispose(): void {
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}
