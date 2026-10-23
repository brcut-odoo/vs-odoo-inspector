import * as vscode from 'vscode';
import { AuthMode, ConnectionConfig } from '../odoo/types';

export const CONFIG_SECTION = 'odooInspector';

/** Reads the configured connections from settings. */
export function getConnections(): ConnectionConfig[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<ConnectionConfig[]>('connections', []);
	return raw
		.filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim())
		.map((entry) => ({
			name: entry.name.trim(),
			url: (entry.url ?? '').trim(),
			db: (entry.db ?? '').trim(),
			login: (entry.login ?? '').trim(),
			authMode: normalizeAuthMode(entry.authMode),
		}));
}

/**
 * Settings can hold anything (users edit `settings.json` by hand), so unknown
 * auth modes fall back to `auto` rather than reaching the client.
 */
export function normalizeAuthMode(value: unknown): AuthMode | 'auto' {
	return value === 'apiKey' || value === 'session' || value === 'password' ? value : 'auto';
}

/** The name of the connection the user last selected. */
export function getActiveConnectionName(): string | undefined {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('activeConnection') || undefined;
}

export async function setActiveConnectionName(name: string | undefined): Promise<void> {
	await vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.update('activeConnection', name, vscode.ConfigurationTarget.Global);
}

export function getRateLimit(): number {
	const value = vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<number>('rateLimitPerSecond', 1);
	return typeof value === 'number' && value >= 0 ? value : 1;
}

export function getMaxRows(): number {
	const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('maxRows', 200);
	return typeof value === 'number' && value > 0 ? value : 200;
}

export type QueryGateMode = 'always' | 'writes-only' | 'never';

export function getQueryGateMode(): QueryGateMode {
	const value = vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<QueryGateMode>('queryGate', 'always');
	return value === 'writes-only' || value === 'never' ? value : 'always';
}

export function isMethodCallsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<boolean>('enableArbitraryMethodCalls', false);
}

/** Finds a connection by name, or the active one when no name is given. */
export function findConnection(name?: string): ConnectionConfig | undefined {
	const connections = getConnections();
	if (name) {
		return connections.find((entry) => entry.name === name);
	}
	const active = getActiveConnectionName();
	if (active) {
		const match = connections.find((entry) => entry.name === active);
		if (match) {
			return match;
		}
	}
	return connections[0];
}
