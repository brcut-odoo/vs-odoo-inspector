import * as vscode from 'vscode';
import { OdooClient } from '../odoo/client';
import { ConnectionConfig, OdooError, ResolvedConnection } from '../odoo/types';
import { CredentialStore } from '../config/secrets';
import {
	findConnection,
	getActiveConnectionName,
	getConnections,
	getRateLimit,
	setActiveConnectionName,
} from '../config/settings';

/**
 * Owns the active `OdooClient` and the status bar indicator.
 *
 * Tools and commands go through here rather than constructing clients, so a
 * single connection (and its `fields_get` cache) is shared.
 */
export class ConnectionManager implements vscode.Disposable {
	private client?: OdooClient;
	private resolved?: ResolvedConnection;
	private readonly statusBar: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly credentials: CredentialStore,
		private readonly output: vscode.OutputChannel,
	) {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.statusBar.command = 'odooInspector.connect';
		this.disposables.push(this.statusBar);
		this.updateStatusBar();
		this.statusBar.show();
	}

	/** The connected client, or `undefined` when not connected. */
	get activeClient(): OdooClient | undefined {
		return this.client;
	}

	get activeConnection(): ResolvedConnection | undefined {
		return this.resolved;
	}

	/**
	 * Returns the active client, connecting first if needed.
	 *
	 * Throws a user-facing error when no connection is configured.
	 */
	async requireClient(): Promise<OdooClient> {
		if (this.client) {
			return this.client;
		}
		return this.connect();
	}

	/** Connects to a named connection, or the active one. */
	async connect(name?: string): Promise<OdooClient> {
		const connection = findConnection(name);
		if (!connection) {
			throw new OdooError(
				'No Odoo connection is configured. Add one in Settings under "odooInspector.connections".',
				'validation',
			);
		}

		const credential = await this.credentials.getOrPrompt(connection.name, connection.login);
		if (!credential) {
			throw new OdooError('No credential provided for this connection.', 'auth');
		}

		return this.connectWith(connection, credential);
	}

	/** Connects with an explicit credential, bypassing the store. */
	async connectWith(connection: ConnectionConfig, credential: string): Promise<OdooClient> {
		this.output.appendLine(
			`[connect] ${connection.name} -> ${connection.url} (db=${connection.db})`,
		);

		const client = new OdooClient({
			connection,
			credential,
			rateLimitPerSecond: getRateLimit(),
		});

		try {
			const resolved = await client.connect();
			this.client = client;
			this.resolved = resolved;
			await setActiveConnectionName(connection.name);
			this.output.appendLine(
				`[connect] ok: version=${resolved.serverVersion ?? '?'} apiMode=${resolved.apiMode} auth=${resolved.authMode}`,
			);
			this.updateStatusBar();
			return client;
		} catch (error) {
			this.output.appendLine(`[connect] failed: ${(error as Error).message}`);
			this.client = undefined;
			this.resolved = undefined;
			this.updateStatusBar();
			throw error;
		}
	}

	/** Drops the connection and its caches. */
	disconnect(): void {
		this.client?.clearCache();
		this.client = undefined;
		this.resolved = undefined;
		this.updateStatusBar();
	}

	/** Interactive connection picker. */
	async pickAndConnect(): Promise<OdooClient | undefined> {
		const connections = getConnections();
		if (connections.length === 0) {
			const action = await vscode.window.showWarningMessage(
				'No Odoo connections are configured.',
				'Open Settings',
			);
			if (action === 'Open Settings') {
				await vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'odooInspector.connections',
				);
			}
			return undefined;
		}

		const active = getActiveConnectionName();
		const picked = await vscode.window.showQuickPick(
			connections.map((connection) => ({
				label: connection.name,
				description: `${connection.url} · ${connection.db}`,
				detail: connection.name === active ? 'Currently active' : undefined,
				connection,
			})),
			{ title: 'Connect to an Odoo database', placeHolder: 'Select a connection' },
		);
		if (!picked) {
			return undefined;
		}

		try {
			return await this.connect(picked.connection.name);
		} catch (error) {
			void vscode.window.showErrorMessage(
				`Could not connect to ${picked.connection.name}: ${(error as Error).message}`,
			);
			return undefined;
		}
	}

	private updateStatusBar(): void {
		if (this.resolved) {
			this.statusBar.text = `$(database) ${this.resolved.name}`;
			this.statusBar.tooltip = [
				`Odoo: ${this.resolved.url}`,
				`Database: ${this.resolved.db}`,
				`Version: ${this.resolved.serverVersion ?? 'unknown'}`,
				`API: ${this.resolved.apiMode}`,
				`Auth: ${this.resolved.authMode}`,
			].join('\n');
			this.statusBar.backgroundColor = undefined;
		} else {
			this.statusBar.text = '$(database) Odoo: not connected';
			this.statusBar.tooltip = 'Click to connect to an Odoo database';
			this.statusBar.backgroundColor = undefined;
		}
	}

	dispose(): void {
		this.disconnect();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}
