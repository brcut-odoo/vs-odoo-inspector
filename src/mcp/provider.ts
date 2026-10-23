import * as vscode from 'vscode';

export const MCP_PROVIDER_ID = 'odooInspector.mcp';

/**
 * Tells VS Code about the in-process MCP server.
 *
 * The bearer token is passed as a header on the definition, so VS Code sends
 * it with every request and nothing else on the machine can.
 */
export function registerMcpProvider(url: string, token: string, version: string): vscode.Disposable {
	return vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
		provideMcpServerDefinitions: () => [
			new vscode.McpHttpServerDefinition(
				'Odoo Inspector',
				vscode.Uri.parse(url),
				{ Authorization: `Bearer ${token}` },
				version,
			),
		],
	});
}
