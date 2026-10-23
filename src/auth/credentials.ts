import * as vscode from 'vscode';
import { describeKind } from '../odoo/select';
import { AuthKind } from '../odoo/types';

/**
 * Credentials live only in SecretStorage (the OS keychain), keyed by
 * connection name. The kind is stored with the secret so a password is never
 * mistaken for a session token by shape detection.
 */
export class CredentialStore {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	private key(connection: string): string {
		return `odooInspector.secret.${connection}`;
	}

	async get(connection: string): Promise<{ kind?: AuthKind; secret: string } | undefined> {
		const raw = await this.secrets.get(this.key(connection));
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as { kind?: AuthKind; secret?: string };
			return parsed.secret ? { kind: parsed.kind, secret: parsed.secret } : undefined;
		} catch {
			return undefined;
		}
	}

	async set(connection: string, kind: AuthKind, secret: string): Promise<void> {
		await this.secrets.store(this.key(connection), JSON.stringify({ kind, secret }));
	}

	async delete(connection: string): Promise<void> {
		await this.secrets.delete(this.key(connection));
	}

	/** Asks for the credential kind (unless known) and the secret, then stores it. */
	async prompt(connection: string, login: string, kind?: AuthKind): Promise<{ kind: AuthKind; secret: string } | undefined> {
		const chosen = kind ?? (await pickAuthKind());
		if (!chosen) {
			return undefined;
		}
		const secret = await vscode.window.showInputBox({
			title: `${describeKind(chosen)} for ${login} on ${connection}`,
			prompt: PROMPTS[chosen],
			password: true,
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim() ? undefined : 'Required'),
		});
		if (!secret) {
			return undefined;
		}
		await this.set(connection, chosen, secret.trim());
		return { kind: chosen, secret: secret.trim() };
	}
}

const PROMPTS: Record<AuthKind, string> = {
	apiKey: 'An API key from Preferences → Account Security → New API Key. Stored in the OS keychain.',
	password: "The user's password. Stored in the OS keychain. Not usable for users with two-factor authentication.",
	session: 'The session_id cookie from a logged-in browser. Stored in the OS keychain. It stops working when the session expires.',
};

export async function pickAuthKind(): Promise<AuthKind | undefined> {
	const items: (vscode.QuickPickItem & { auth: AuthKind })[] = [
		{ auth: 'apiKey', label: 'API key', description: 'Recommended', detail: 'Revocable, works with two-factor authentication, uses json2 on Odoo 18.5+.' },
		{ auth: 'password', label: 'Password', detail: 'Not usable with two-factor authentication.' },
		{ auth: 'session', label: 'Session token', detail: 'A session_id cookie copied from the browser. Expires with the session.' },
	];
	const picked = await vscode.window.showQuickPick(items, { title: 'How do you want to authenticate?', ignoreFocusOut: true });
	return picked?.auth;
}
