import * as vscode from 'vscode';

/**
 * Credentials live in `SecretStorage`, never in settings.
 *
 * The key is derived from the connection name so renaming a connection
 * invalidates its secret rather than silently reusing the wrong one.
 */
export class CredentialStore {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	private key(connectionName: string): string {
		return `odooInspector.credential.${connectionName}`;
	}

	async get(connectionName: string): Promise<string | undefined> {
		return this.secrets.get(this.key(connectionName));
	}

	async set(connectionName: string, credential: string): Promise<void> {
		await this.secrets.store(this.key(connectionName), credential);
	}

	async delete(connectionName: string): Promise<void> {
		await this.secrets.delete(this.key(connectionName));
	}

	/** Prompts for a credential and stores it. Returns `undefined` on cancel. */
	async prompt(connectionName: string, login: string): Promise<string | undefined> {
		const value = await vscode.window.showInputBox({
			title: `Credentials for ${connectionName}`,
			prompt: `API key or session id for "${login}". Stored in the OS keychain.`,
			password: true,
			ignoreFocusOut: true,
			placeHolder: 'Paste an API key (recommended) or a session_id',
		});
		if (!value) {
			return undefined;
		}
		await this.set(connectionName, value);
		return value;
	}

	/** Returns the stored credential, prompting for one if absent. */
	async getOrPrompt(connectionName: string, login: string): Promise<string | undefined> {
		const existing = await this.get(connectionName);
		if (existing) {
			return existing;
		}
		return this.prompt(connectionName, login);
	}
}
