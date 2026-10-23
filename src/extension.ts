import * as vscode from 'vscode';
import { CredentialStore } from './config/secrets';
import { findConnection, getConnections } from './config/settings';
import { ConnectionManager } from './ui/connectionManager';
import { WorkbenchPanel } from './ui/workbench/panel';
import { LmToolAdapter } from './tools/lmTools';
import { McpProvider } from './tools/mcpProvider';
import { normalizeSpec } from './query/spec';
import { OdooError } from './odoo/types';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Odoo Inspector');
	context.subscriptions.push(output);

	const credentials = new CredentialStore(context.secrets);
	const connections = new ConnectionManager(credentials, output);
	context.subscriptions.push(connections);

	// Native language model tools.
	const lmTools = new LmToolAdapter(connections, context.extensionUri);
	context.subscriptions.push(lmTools);

	// The bundled stdio MCP server.
	const mcpProvider = new McpProvider(credentials, context.extensionUri);
	context.subscriptions.push(mcpProvider);

	context.subscriptions.push(
		vscode.commands.registerCommand('odooInspector.connect', async () => {
			await connections.pickAndConnect();
		}),

		vscode.commands.registerCommand('odooInspector.disconnect', () => {
			connections.disconnect();
			void vscode.window.showInformationMessage('Disconnected from Odoo.');
		}),

		vscode.commands.registerCommand('odooInspector.setCredentials', async () => {
			const connection = findConnection();
			if (!connection) {
				void vscode.window.showWarningMessage('No Odoo connection is configured.');
				return;
			}
			const credential = await credentials.prompt(connection.name, connection.login);
			if (credential) {
				void vscode.window.showInformationMessage(
					`Credentials stored for ${connection.name}.`,
				);
			}
		}),

		vscode.commands.registerCommand('odooInspector.openWorkbench', async () => {
			await openWorkbench(connections, context.extensionUri);
		}),

		vscode.commands.registerCommand('odooInspector.showOutput', () => {
			output.show();
		}),

		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('odooInspector.connections')) {
				mcpProvider.refresh();
			}
		}),
	);

	output.appendLine('Odoo Inspector activated.');
}

/**
 * Opens the workbench on a model the user picks.
 *
 * This is the manual entry point; the LM tools open it with a proposed query.
 */
async function openWorkbench(
	connections: ConnectionManager,
	extensionUri: vscode.Uri,
): Promise<void> {
	let client;
	try {
		client = await connections.requireClient();
	} catch (error) {
		void vscode.window.showErrorMessage(
			error instanceof OdooError ? `${error.message} ${error.hint}` : (error as Error).message,
		);
		return;
	}

	const model = await vscode.window.showInputBox({
		title: 'Open Odoo Query Workbench',
		prompt: 'Model to query',
		value: 'res.partner',
		placeHolder: 'e.g. res.partner, sale.order, product.template',
		ignoreFocusOut: true,
	});
	if (!model) {
		return;
	}

	try {
		const fields = await client.fieldsGet(model);
		await WorkbenchPanel.open(
			{
				client,
				spec: normalizeSpec({ model, method: 'search_read' }),
				fields,
				editable: true,
			},
			extensionUri,
		);
	} catch (error) {
		void vscode.window.showErrorMessage(
			error instanceof OdooError ? `${error.message} ${error.hint}` : (error as Error).message,
		);
	}
}

export function deactivate(): void {
	// Disposables registered on the context handle teardown.
}

/** Exposed for tests. */
export { getConnections };
