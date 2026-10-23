import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/server';
import { ApprovalBroker } from './approval/broker';
import { ApprovalStore } from './approval/store';
import { CredentialStore } from './auth/credentials';
import { McpHttpServer } from './mcp/httpServer';
import { registerMcpProvider } from './mcp/provider';
import { ApprovalGate } from './tools/gate';
import { registerOdooTools } from './tools/odooTools';
import { ConnectionManager, getSetting } from './ui/connections';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Odoo Inspector', { log: true });
	context.subscriptions.push(output);
	const log = (message: string) => output.info(message);
	const version: string = context.extension.packageJSON.version;

	const connections = new ConnectionManager(new CredentialStore(context.secrets), log);
	const store = new ApprovalStore();
	const broker = new ApprovalBroker(store);
	const gate = new ApprovalGate(broker, store, () => getSetting('approval.autoApproveKnownColumns', true));

	const http = new McpHttpServer((sessionId) => {
		const server = new McpServer({ name: 'odoo-inspector', version });
		registerOdooTools(server, {
			sessionId,
			broker,
			store,
			gate,
			client: (name) => connections.client(name),
			onAuthFailure: (name, error) => connections.handleAuthFailure(name, error),
			settings: () => ({
				maxRows: getSetting('maxRows', 200),
				previewRows: getSetting('approval.previewRows', 50),
				enableExecuteKw: getSetting('enableExecuteKw', false),
			}),
			log,
		});
		return server;
	}, log);
	const url = await http.start();
	log(`MCP server listening on ${url}`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	status.command = 'odooInspector.manageApprovals';
	const refreshStatus = () => {
		const rows = store.snapshot();
		const approved = rows.reduce((sum, row) => sum + row.approved.length, 0);
		const withheld = rows.reduce((sum, row) => sum + row.denied.length, 0);
		status.text = `$(shield) Odoo ${approved}/${withheld}`;
		status.tooltip = `Odoo Inspector: ${approved} column(s) approved and ${withheld} withheld in open chat sessions. Click to review or reset.`;
		status.show();
	};
	refreshStatus();

	context.subscriptions.push(
		connections,
		status,
		store.onDidChange(refreshStatus),
		registerMcpProvider(url, http.token, version),
		{ dispose: () => void http.dispose() },
		vscode.commands.registerCommand('odooInspector.addConnection', () => connections.addConnection()),
		vscode.commands.registerCommand('odooInspector.setCredentials', () => connections.setCredentials()),
		vscode.commands.registerCommand('odooInspector.connect', () => connections.connect()),
		vscode.commands.registerCommand('odooInspector.disconnect', () => {
			connections.disconnect();
			void vscode.window.showInformationMessage('Disconnected from Odoo.');
		}),
		vscode.commands.registerCommand('odooInspector.resetApprovals', () => {
			store.reset();
			void vscode.window.showInformationMessage('Odoo column approvals cleared. The next query asks again.');
		}),
		vscode.commands.registerCommand('odooInspector.manageApprovals', () => manageApprovals(store)),
		vscode.commands.registerCommand('odooInspector.showOutput', () => output.show()),
	);
}

/** Lists remembered decisions and lets the user clear one session or all. */
async function manageApprovals(store: ApprovalStore): Promise<void> {
	const rows = store.snapshot();
	if (rows.length === 0) {
		void vscode.window.showInformationMessage('No Odoo column approvals are remembered.');
		return;
	}
	type Item = vscode.QuickPickItem & { session?: string };
	const items: Item[] = [{ label: '$(trash) Reset all approvals' }];
	for (const row of rows) {
		const [connection, model] = row.scope.split('|');
		items.push({
			label: `${model}`,
			description: `${connection} · session ${row.session.slice(0, 8)}`,
			detail: `Approved: ${row.approved.join(', ') || '—'}   Withheld: ${row.denied.join(', ') || '—'}`,
			session: row.session,
		});
	}
	const picked = await vscode.window.showQuickPick(items, { title: 'Odoo column approvals — pick one to reset its chat session', matchOnDetail: true });
	if (!picked) {
		return;
	}
	store.reset(picked.session);
}

export function deactivate(): void {
	// Disposables registered on the context handle teardown.
}
