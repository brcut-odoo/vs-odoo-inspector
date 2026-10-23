import * as vscode from 'vscode';
import { AuthMode } from '../odoo/types';

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

	/**
	 * Prompts for a credential and stores it. Returns `undefined` on cancel.
	 *
	 * `authMode` only changes the wording: the field accepts an API key, a
	 * `session_id` or a password.
	 */
	async prompt(
		connectionName: string,
		login: string,
		authMode: AuthMode | 'auto' = 'auto',
	): Promise<string | undefined> {
		const value = await vscode.window.showInputBox({
			title: `Credentials for ${connectionName}`,
			prompt: credentialPrompt(login, authMode),
			password: true,
			ignoreFocusOut: true,
			placeHolder: credentialPlaceholder(authMode),
		});
		if (!value) {
			return undefined;
		}
		await this.set(connectionName, value);
		return value;
	}

	/** Returns the stored credential, prompting for one if absent. */
	async getOrPrompt(
		connectionName: string,
		login: string,
		authMode: AuthMode | 'auto' = 'auto',
	): Promise<string | undefined> {
		const existing = await this.get(connectionName);
		if (existing) {
			return existing;
		}
		return this.prompt(connectionName, login, authMode);
	}
}

function credentialPrompt(login: string, authMode: AuthMode | 'auto'): string {
	switch (authMode) {
		case 'password':
			return `Password for "${login}". Stored in the OS keychain. It is exchanged for a session and cannot be used with two-factor authentication.`;
		case 'apiKey':
			return `API key for "${login}". Stored in the OS keychain.`;
		case 'session':
			return `session_id for "${login}". Stored in the OS keychain. Sessions expire, so prefer an API key.`;
		default:
			return `API key, session id or password for "${login}". A 40-character key is used as an API key, a 42-character id as a session, and anything else as a password. Stored in the OS keychain.`;
	}
}

function credentialPlaceholder(authMode: AuthMode | 'auto'): string {
	switch (authMode) {
		case 'password':
			return "Paste the user's password";
		case 'apiKey':
			return 'Paste an API key';
		case 'session':
			return 'Paste a session_id';
		default:
			return 'Paste an API key (recommended), a session_id, or a password';
	}
}
