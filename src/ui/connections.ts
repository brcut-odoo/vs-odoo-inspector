import * as vscode from 'vscode';
import { OdooClient } from '../odoo/client';
import { OdooError } from '../odoo/errors';
import { describeKind } from '../odoo/select';
import { ConnectionConfig } from '../odoo/types';
import { ConnectHints, ConnectionDetails, promptConnection, promptSecret, RecentConnection, sameUrl } from './connectPrompt';

const SECTION = 'odooInspector';
const RECENT_KEY = 'odooInspector.recentConnections';
const MAX_RECENT = 10;

export function getSetting<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

export type ConnectResult =
	| { status: 'connected'; name: string; client: OdooClient }
	| { status: 'declined' }
	| { status: 'failed'; error: unknown };

/**
 * Owns the Odoo clients. Connections are ephemeral: each is opened when the
 * model asks and the user agrees, belongs to one MCP session, and is dropped
 * with it. Secrets live only in the clients; the history kept to pre-fill the
 * prompt holds no secret.
 */
export class ConnectionManager implements vscode.Disposable {
	private readonly sessions = new Map<string, Map<string, OdooClient>>();
	/** Prompts run one at a time, so two chats never interleave input boxes. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly state: vscode.Memento,
		private readonly log: (message: string) => void,
	) {}

	/** Asks the user to open a connection for this session. */
	connect(sessionId: string, hints: ConnectHints, signal?: AbortSignal): Promise<ConnectResult> {
		return this.serialized(() => this.promptAndConnect(sessionId, hints, signal));
	}

	private serialized<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async promptAndConnect(sessionId: string, hints: ConnectHints, signal?: AbortSignal): Promise<ConnectResult> {
		const tokens = new vscode.CancellationTokenSource();
		const onAbort = () => tokens.cancel();
		signal?.addEventListener('abort', onAbort);
		try {
			let current = hints;
			for (;;) {
				const details = await promptConnection(current, this.recent(), tokens.token);
				if (!details) {
					this.log(`Session ${sessionId}: the user declined a connection${hints.reason ? ` (${hints.reason})` : ''}.`);
					return { status: 'declined' };
				}
				const client = new OdooClient({
					connection: this.configFor(sessionId, details),
					secret: details.secret,
					rateLimitPerSecond: getSetting('rateLimitPerSecond', 1),
				});
				try {
					await client.connect(signal);
				} catch (error) {
					if (signal?.aborted) {
						throw error;
					}
					const message = error instanceof OdooError ? error.describe() : String(error);
					this.log(`Session ${sessionId}: connecting to ${details.db} (${details.url}) failed: ${message}`);
					const choice = await vscode.window.showErrorMessage(`Could not connect to ${details.db} on ${details.url}.`, { modal: true, detail: message }, 'Retry');
					if (choice !== 'Retry') {
						return { status: 'failed', error };
					}
					current = { ...hints, url: details.url, db: details.db, login: details.login };
					continue;
				}
				const { connection } = client;
				this.open(sessionId).set(connection.name, client);
				await this.remember(details);
				this.log(
					`Session ${sessionId}: connected "${connection.name}" to ${connection.url} (db ${connection.db}) as ${connection.login} with ${describeKind(client.credential.kind)} over ${client.protocolName}.`,
				);
				return { status: 'connected', name: connection.name, client };
			}
		} finally {
			signal?.removeEventListener('abort', onAbort);
			tokens.dispose();
		}
	}

	/** Names a connection after its database, suffixed when the session already has one by that name. */
	private configFor(sessionId: string, details: ConnectionDetails): ConnectionConfig {
		const taken = this.open(sessionId);
		let name = details.db;
		for (let n = 2; taken.has(name); n++) {
			name = `${details.db}-${n}`;
		}
		const { url, db, login, authMethod, protocol } = details;
		return { name, url, db, login, authMethod, protocol };
	}

	private open(sessionId: string): Map<string, OdooClient> {
		let open = this.sessions.get(sessionId);
		if (!open) {
			open = new Map();
			this.sessions.set(sessionId, open);
		}
		return open;
	}

	/** The open clients of a session. */
	clients(sessionId: string): OdooClient[] {
		return [...(this.sessions.get(sessionId)?.values() ?? [])];
	}

	/** The client a tool uses: the one it names, else the session's only one. */
	client(sessionId: string, name?: string): OdooClient {
		const open = this.sessions.get(sessionId);
		if (!open?.size) {
			throw new OdooError('No Odoo connection is open in this chat.', 'validation', 'Call odoo_connect first; the user is asked for the connection details.');
		}
		const names = [...open.keys()].join(', ');
		if (name) {
			const found = open.get(name);
			if (!found) {
				throw new OdooError(`There is no open Odoo connection named "${name}".`, 'validation', `Pass "connection" as one of: ${names}, or call odoo_connect.`);
			}
			return found;
		}
		if (open.size > 1) {
			throw new OdooError('Several Odoo connections are open.', 'validation', `Pass "connection" as one of: ${names}.`);
		}
		return open.values().next().value!;
	}

	/**
	 * After an auth failure (typically an expired session token), asks once for
	 * a fresh secret and replaces the client. True to retry.
	 */
	async handleAuthFailure(sessionId: string, name: string | undefined, error: unknown): Promise<boolean> {
		if (!(error instanceof OdooError) || error.kind !== 'auth') {
			return false;
		}
		let stale: OdooClient;
		try {
			stale = this.client(sessionId, name);
		} catch {
			return false;
		}
		const { connection, credential } = stale;
		return this.serialized(async () => {
			const choice = await vscode.window.showWarningMessage(`Odoo rejected the credentials for "${connection.name}": ${error.message}`, 'Enter New Credentials');
			if (choice !== 'Enter New Credentials') {
				return false;
			}
			const secret = await promptSecret(credential.kind, connection.login, `${connection.db} (${connection.url})`);
			if (!secret) {
				return false;
			}
			this.open(sessionId).set(
				connection.name,
				new OdooClient({ connection: { ...connection, authMethod: credential.kind }, secret, rateLimitPerSecond: getSetting('rateLimitPerSecond', 1) }),
			);
			return true;
		});
	}

	private recent(): RecentConnection[] {
		return this.state.get<RecentConnection[]>(RECENT_KEY, []);
	}

	private async remember(details: ConnectionDetails): Promise<void> {
		const { url, db, login, authMethod, protocol } = details;
		const others = this.recent().filter((entry) => !(sameUrl(entry.url, url) && entry.db === db && entry.login === login));
		await this.state.update(RECENT_KEY, [{ url, db, login, authMethod, protocol, lastUsed: Date.now() }, ...others].slice(0, MAX_RECENT));
	}

	async forgetHistory(): Promise<void> {
		await this.state.update(RECENT_KEY, undefined);
	}

	closeSession(sessionId: string): void {
		if (this.sessions.delete(sessionId)) {
			this.log(`Session ${sessionId}: connections closed.`);
		}
	}

	disconnect(): void {
		this.sessions.clear();
	}

	dispose(): void {
		this.sessions.clear();
	}
}

/**
 * Earlier versions kept connections in settings and secrets in the keychain.
 * Deletes those secrets once; the settings entry is left for the user.
 */
export async function forgetLegacySecrets(context: vscode.ExtensionContext): Promise<void> {
	const flag = 'odooInspector.legacySecretsCleared';
	if (context.globalState.get<boolean>(flag)) {
		return;
	}
	const legacy = vscode.workspace.getConfiguration(SECTION).get<{ name?: string }[]>('connections', []);
	for (const { name } of Array.isArray(legacy) ? legacy : []) {
		if (name) {
			await context.secrets.delete(`odooInspector.secret.${name}`);
		}
	}
	await context.globalState.update(flag, true);
}
