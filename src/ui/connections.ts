import * as vscode from 'vscode';
import { CredentialStore, pickAuthKind } from '../auth/credentials';
import { OdooClient } from '../odoo/client';
import { OdooError } from '../odoo/errors';
import { describeKind } from '../odoo/select';
import { AuthKind, ConnectionConfig, ProtocolName } from '../odoo/types';

const SECTION = 'odooInspector';

export function getConnections(): ConnectionConfig[] {
	return vscode.workspace.getConfiguration(SECTION).get<ConnectionConfig[]>('connections', []);
}

export function getSetting<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

/**
 * Owns the Odoo clients, one per connection, created on first use.
 *
 * The connection a tool uses is the one it names, else `activeConnection`,
 * else the only configured one.
 */
export class ConnectionManager implements vscode.Disposable {
	private readonly clients = new Map<string, Promise<OdooClient>>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly credentials: CredentialStore,
		private readonly log: (message: string) => void,
	) {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(`${SECTION}.connections`) || event.affectsConfiguration(`${SECTION}.rateLimitPerSecond`)) {
					this.clients.clear();
				}
			}),
		);
	}

	resolve(name?: string): ConnectionConfig {
		const connections = getConnections();
		if (connections.length === 0) {
			throw new OdooError('No Odoo connection is configured.', 'auth', 'Ask the user to run "Odoo: Add Connection".');
		}
		const wanted = name || getSetting('activeConnection', '') || (connections.length === 1 ? connections[0].name : '');
		const found = connections.find((connection) => connection.name === wanted);
		if (!found) {
			throw new OdooError(
				wanted ? `There is no Odoo connection named "${wanted}".` : 'Several Odoo connections exist and none is active.',
				'validation',
				`Pass "connection" as one of: ${connections.map((c) => c.name).join(', ')}.`,
			);
		}
		return found;
	}

	/** A connected client, prompting for credentials when none are stored. */
	async client(name?: string): Promise<OdooClient> {
		const connection = this.resolve(name);
		let pending = this.clients.get(connection.name);
		if (!pending) {
			pending = this.open(connection);
			this.clients.set(connection.name, pending);
			pending.catch(() => this.clients.delete(connection.name));
		}
		return pending;
	}

	private async open(connection: ConnectionConfig): Promise<OdooClient> {
		const preset = connection.authMethod && connection.authMethod !== 'auto' ? connection.authMethod : undefined;
		const stored = (await this.credentials.get(connection.name)) ?? (await this.credentials.prompt(connection.name, connection.login, preset));
		if (!stored) {
			throw new OdooError(`No credentials for "${connection.name}".`, 'auth', 'Ask the user to run "Odoo: Set Credentials".');
		}
		const client = new OdooClient({
			connection: { ...connection, authMethod: preset ?? stored.kind ?? 'auto' },
			secret: stored.secret,
			rateLimitPerSecond: getSetting('rateLimitPerSecond', 1),
		});
		await client.connect();
		this.log(`Connected to ${connection.name} (${connection.url}, db ${connection.db}) as ${connection.login} with ${describeKind(client.credential.kind)} over ${client.protocolName}.`);
		return client;
	}

	/**
	 * Drops a client after an auth failure. A session token that expired cannot
	 * be renewed silently, so the user is asked once for a fresh credential.
	 */
	async handleAuthFailure(name: string | undefined, error: unknown): Promise<boolean> {
		if (!(error instanceof OdooError) || error.kind !== 'auth') {
			return false;
		}
		const connection = this.resolve(name);
		this.clients.delete(connection.name);
		const choice = await vscode.window.showWarningMessage(
			`Odoo rejected the credentials for "${connection.name}": ${error.message}`,
			'Enter New Credentials',
		);
		if (choice !== 'Enter New Credentials') {
			return false;
		}
		return Boolean(await this.credentials.prompt(connection.name, connection.login));
	}

	disconnect(): void {
		this.clients.clear();
	}

	dispose(): void {
		this.clients.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** "Odoo: Add Connection": URL → database → login → auth kind → secret → protocol. */
	async addConnection(): Promise<void> {
		const input = (title: string, prompt: string, value = '', validate?: (v: string) => string | undefined) =>
			vscode.window.showInputBox({ title, prompt, value, ignoreFocusOut: true, validateInput: validate });

		const url = await input('Add Odoo connection (1/5)', 'Server URL', 'https://', (v) => (/^https?:\/\/[^/]+/.test(v) ? undefined : 'Enter an http(s) URL'));
		if (!url) {
			return;
		}
		const db = await input('Add Odoo connection (2/5)', 'Database name', guessDb(url));
		if (!db) {
			return;
		}
		const login = await input('Add Odoo connection (3/5)', 'Login (usually an email address)');
		if (!login) {
			return;
		}
		const kind: AuthKind | undefined = await pickAuthKind();
		if (!kind) {
			return;
		}
		const protocol = await pickProtocol(kind);
		if (!protocol) {
			return;
		}
		const existing = getConnections();
		const name = await input('Add Odoo connection (5/5)', 'A short name for this connection', db, (v) =>
			!v.trim() ? 'Required' : existing.some((c) => c.name === v.trim()) ? 'That name is taken' : undefined,
		);
		if (!name) {
			return;
		}
		const connection: ConnectionConfig = { name: name.trim(), url: url.replace(/\/+$/, ''), db, login, authMethod: kind, protocol };
		const stored = await this.credentials.prompt(connection.name, login, kind);
		if (!stored) {
			return;
		}
		await vscode.workspace.getConfiguration(SECTION).update('connections', [...existing, connection], vscode.ConfigurationTarget.Global);
		try {
			const client = await this.client(connection.name);
			void vscode.window.showInformationMessage(`Connected to ${connection.name} over ${client.protocolName}.`);
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof OdooError ? error.describe() : String(error));
		}
	}

	async setCredentials(): Promise<void> {
		const connection = await this.pick('Set credentials for');
		if (!connection) {
			return;
		}
		const preset = connection.authMethod && connection.authMethod !== 'auto' ? connection.authMethod : undefined;
		if (await this.credentials.prompt(connection.name, connection.login, preset)) {
			this.clients.delete(connection.name);
			void vscode.window.showInformationMessage(`Credentials stored for ${connection.name}.`);
		}
	}

	async connect(): Promise<void> {
		const connection = await this.pick('Connect to');
		if (!connection) {
			return;
		}
		try {
			const client = await this.client(connection.name);
			void vscode.window.showInformationMessage(`Connected to ${connection.name} over ${client.protocolName}.`);
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof OdooError ? error.describe() : String(error));
		}
	}

	private async pick(title: string): Promise<ConnectionConfig | undefined> {
		const connections = getConnections();
		if (connections.length === 0) {
			void vscode.window.showWarningMessage('No Odoo connection is configured. Run "Odoo: Add Connection" first.');
			return undefined;
		}
		if (connections.length === 1) {
			return connections[0];
		}
		const picked = await vscode.window.showQuickPick(
			connections.map((connection) => ({ label: connection.name, description: `${connection.login} @ ${connection.url} / ${connection.db}`, connection })),
			{ title },
		);
		return picked?.connection;
	}
}

function guessDb(url: string): string {
	// `https://acme.odoo.com` usually hosts the database `acme`.
	return /^https?:\/\/([^./]+)\.odoo\.com/.exec(url)?.[1] ?? '';
}

async function pickProtocol(kind: AuthKind): Promise<ProtocolName | 'auto' | undefined> {
	const all: (vscode.QuickPickItem & { protocol: ProtocolName | 'auto'; accepts: AuthKind[] })[] = [
		{ protocol: 'auto', label: 'Automatic', description: 'Recommended', detail: 'json2 for API keys on 18.5+, callKw for sessions, otherwise jsonrpc.', accepts: ['apiKey', 'password', 'session'] },
		{ protocol: 'jsonrpc', label: 'External JSON-RPC (/jsonrpc)', detail: 'All versions; deprecated from Odoo 19.', accepts: ['apiKey', 'password'] },
		{ protocol: 'xmlrpc', label: 'XML-RPC (/xmlrpc/2)', detail: 'All versions; deprecated from Odoo 19.', accepts: ['apiKey', 'password'] },
		{ protocol: 'callKw', label: 'Web client (/web/dataset/call_kw)', detail: 'Session cookie; a password is exchanged for one.', accepts: ['password', 'session'] },
		{ protocol: 'json2', label: 'JSON-2 (/json/2)', detail: 'Odoo 18.5+ with an API key.', accepts: ['apiKey'] },
	];
	const picked = await vscode.window.showQuickPick(
		all.filter((item) => item.accepts.includes(kind)),
		{ title: 'Add Odoo connection (4/5): protocol', ignoreFocusOut: true },
	);
	return picked?.protocol;
}
