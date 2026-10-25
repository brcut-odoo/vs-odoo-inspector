import * as vscode from 'vscode';
import { listDatabases } from '../odoo/databases';
import { describeKind } from '../odoo/select';
import { AuthKind, ProtocolName } from '../odoo/types';

/** What the model suggests; only used to pre-fill the prompt. */
export interface ConnectHints {
	url?: string;
	db?: string;
	login?: string;
	/** Why the model wants the connection, shown to the user. */
	reason?: string;
}

/** A connection used before. Never holds the secret. */
export interface RecentConnection {
	url: string;
	db: string;
	login: string;
	authMethod: AuthKind;
	protocol: ProtocolName | 'auto';
	lastUsed: number;
}

export interface ConnectionDetails {
	url: string;
	db: string;
	login: string;
	authMethod: AuthKind;
	protocol: ProtocolName | 'auto';
	secret: string;
}

const TITLE = 'Odoo connection requested by chat';

/**
 * Asks the user to open a connection: a recent one (then only the secret is
 * asked) or a new one (URL → database → login → credential kind → protocol →
 * secret). Undefined when the user declines at any step.
 */
export async function promptConnection(hints: ConnectHints, recent: RecentConnection[], token: vscode.CancellationToken): Promise<ConnectionDetails | undefined> {
	type Item = vscode.QuickPickItem & { recent?: RecentConnection; action?: 'new' | 'decline' };
	const matches = (entry: RecentConnection) =>
		Number(Boolean(hints.url) && sameUrl(entry.url, hints.url!)) + Number(entry.db === hints.db) + Number(entry.login === hints.login);
	const sorted = [...recent].sort((a, b) => matches(b) - matches(a) || b.lastUsed - a.lastUsed);
	const items: Item[] = [
		...sorted.map((entry) => ({
			label: `$(database) ${entry.db}`,
			description: `${entry.login} @ ${entry.url}`,
			detail: `${describeKind(entry.authMethod)} · ${entry.protocol === 'auto' ? 'automatic protocol' : entry.protocol}`,
			recent: entry,
		})),
		{ label: '$(add) New connection…', action: 'new' },
		{ label: '$(close) Decline', action: 'decline' },
	];
	const wanted = [hints.db && `database ${hints.db}`, hints.url && `on ${hints.url}`].filter(Boolean).join(' ');
	const picked = await vscode.window.showQuickPick(
		items,
		{
			title: TITLE,
			placeHolder: `${hints.reason ? `${hints.reason} — ` : ''}${wanted ? `Suggested: ${wanted}. ` : ''}Pick a connection, or press Escape to decline.`,
			ignoreFocusOut: true,
			matchOnDescription: true,
		},
		token,
	);
	if (!picked || picked.action === 'decline') {
		return undefined;
	}
	if (picked.recent) {
		const { url, db, login, authMethod, protocol } = picked.recent;
		const secret = await promptSecret(authMethod, login, `${db} (${url})`, token);
		return secret ? { url, db, login, authMethod, protocol, secret } : undefined;
	}
	return promptNew(hints, recent, token);
}

async function promptNew(hints: ConnectHints, recent: RecentConnection[], token: vscode.CancellationToken): Promise<ConnectionDetails | undefined> {
	const input = (step: string, prompt: string, value = '', validate?: (v: string) => string | undefined) =>
		vscode.window.showInputBox({ title: `${TITLE} (${step})`, prompt, value, ignoreFocusOut: true, validateInput: validate }, token);

	const rawUrl = await input('1/6', 'Server URL', hints.url ?? 'https://', (v) => (/^https?:\/\/[^/]+/.test(v.trim()) ? undefined : 'Enter an http(s) URL'));
	if (!rawUrl) {
		return undefined;
	}
	const url = rawUrl.trim().replace(/\/+$/, '');
	const known = recent.filter((entry) => sameUrl(entry.url, url));
	const db = await pickDatabase(url, hints.db ?? known[0]?.db ?? guessDb(url), token);
	if (!db) {
		return undefined;
	}
	const login = await input('3/6', 'Login (usually an email address)', hints.login ?? known.find((entry) => entry.db === db)?.login ?? known[0]?.login ?? '', (v) =>
		v.trim() ? undefined : 'Required',
	);
	if (!login) {
		return undefined;
	}
	const authMethod = await pickAuthKind('4/6', token);
	if (!authMethod) {
		return undefined;
	}
	const protocol = await pickProtocol(authMethod, token);
	if (!protocol) {
		return undefined;
	}
	const secret = await promptSecret(authMethod, login.trim(), `${db} (${url})`, token, '6/6');
	return secret ? { url, db, login: login.trim(), authMethod, protocol, secret } : undefined;
}

/**
 * Lists the server's databases to pick from; when the server will not list
 * them (or cannot be reached), asks for the name instead.
 */
async function pickDatabase(url: string, preferred: string, token: vscode.CancellationToken): Promise<string | undefined> {
	const title = `${TITLE} (2/6)`;
	const abort = new AbortController();
	const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
	quickPick.title = title;
	quickPick.placeholder = `Listing the databases of ${url}…`;
	quickPick.ignoreFocusOut = true;
	quickPick.busy = true;
	let fallback = false;
	const picked = new Promise<string | undefined>((resolve) => {
		const cancellation = token.onCancellationRequested(() => quickPick.hide());
		quickPick.onDidAccept(() => {
			const choice = quickPick.selectedItems[0]?.label;
			if (choice) {
				resolve(choice);
				quickPick.hide();
			}
		});
		quickPick.onDidHide(() => {
			cancellation.dispose();
			abort.abort();
			quickPick.dispose();
			resolve(undefined);
		});
	});
	quickPick.show();
	void listDatabases(url, abort.signal)
		.catch(() => undefined)
		.then((names) => {
			if (abort.signal.aborted) {
				return;
			}
			if (!names?.length) {
				fallback = true;
				quickPick.hide();
				return;
			}
			quickPick.busy = false;
			quickPick.placeholder = `Database on ${url}`;
			quickPick.items = names.map((label) => ({ label }));
			const active = quickPick.items.find((item) => item.label === preferred);
			if (active) {
				quickPick.activeItems = [active];
			}
		});
	const choice = await picked;
	if (choice || !fallback || token.isCancellationRequested) {
		return choice;
	}
	const typed = await vscode.window.showInputBox(
		{
			title,
			prompt: `Database name (${url} does not list its databases)`,
			value: preferred,
			ignoreFocusOut: true,
			validateInput: (v) => (v.trim() ? undefined : 'Required'),
		},
		token,
	);
	return typed?.trim() || undefined;
}

const PROMPTS: Record<AuthKind, string> = {
	apiKey: 'An API key from Preferences → Account Security → New API Key. Kept in memory for this chat only.',
	password: "The user's password. Kept in memory for this chat only. Not usable for users with two-factor authentication.",
	session: 'The session_id cookie from a logged-in browser. Kept in memory for this chat only. It stops working when the session expires.',
};

/** Asks for the secret of a known credential kind. Never stored. */
export async function promptSecret(kind: AuthKind, login: string, where: string, token?: vscode.CancellationToken, step?: string): Promise<string | undefined> {
	const secret = await vscode.window.showInputBox(
		{
			title: `${describeKind(kind)} for ${login} on ${where}${step ? ` (${step})` : ''}`,
			prompt: PROMPTS[kind],
			password: true,
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim() ? undefined : 'Required'),
		},
		token,
	);
	return secret?.trim() || undefined;
}

async function pickAuthKind(step: string, token: vscode.CancellationToken): Promise<AuthKind | undefined> {
	const items: (vscode.QuickPickItem & { auth: AuthKind })[] = [
		{ auth: 'apiKey', label: 'API key', description: 'Recommended', detail: 'Revocable, works with two-factor authentication, uses json2 on Odoo 18.5+.' },
		{ auth: 'password', label: 'Password', detail: 'Not usable with two-factor authentication.' },
		{ auth: 'session', label: 'Session token', detail: 'A session_id cookie copied from the browser. Expires with the session.' },
	];
	const picked = await vscode.window.showQuickPick(items, { title: `${TITLE} (${step}): how do you want to authenticate?`, ignoreFocusOut: true }, token);
	return picked?.auth;
}

async function pickProtocol(kind: AuthKind, token: vscode.CancellationToken): Promise<ProtocolName | 'auto' | undefined> {
	const all: (vscode.QuickPickItem & { protocol: ProtocolName | 'auto'; accepts: AuthKind[] })[] = [
		{ protocol: 'auto', label: 'Automatic', description: 'Recommended', detail: 'json2 for API keys on 18.5+, callKw for sessions, otherwise jsonrpc.', accepts: ['apiKey', 'password', 'session'] },
		{ protocol: 'jsonrpc', label: 'External JSON-RPC (/jsonrpc)', detail: 'All versions; deprecated from Odoo 19.', accepts: ['apiKey', 'password'] },
		{ protocol: 'xmlrpc', label: 'XML-RPC (/xmlrpc/2)', detail: 'All versions; deprecated from Odoo 19.', accepts: ['apiKey', 'password'] },
		{ protocol: 'callKw', label: 'Web client (/web/dataset/call_kw)', detail: 'Session cookie; a password is exchanged for one.', accepts: ['password', 'session'] },
		{ protocol: 'json2', label: 'JSON-2 (/json/2)', detail: 'Odoo 18.5+ with an API key.', accepts: ['apiKey'] },
	];
	const picked = await vscode.window.showQuickPick(all.filter((item) => item.accepts.includes(kind)),{ title: `${TITLE} (5/6): protocol`, ignoreFocusOut: true }, token);
	return picked?.protocol;
}

function guessDb(url: string): string {
	// `https://acme.odoo.com` usually hosts the database `acme`.
	return /^https?:\/\/([^./]+)\.odoo\.com/.exec(url)?.[1] ?? '';
}

export function sameUrl(a: string, b: string): boolean {
	return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
}
