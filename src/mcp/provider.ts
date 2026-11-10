import * as vscode from 'vscode';

export const MCP_PROVIDER_ID = 'odooInspector.mcp';

/**
 * Tells VS Code about the in-process MCP server.
 *
 * The definition carries the real URL and bearer token, because that is all
 * the Copilot agent host uses: it builds its MCP configuration straight from
 * the provided definition and never calls `resolveMcpServerDefinition`. The
 * extension keeps the port and token stable across activations (see
 * `extension.ts`), so a definition cached by VS Code stays valid. The token is
 * sent as a header with every request, so nothing else on the machine can use
 * the server.
 */
export function registerMcpProvider(url: string, token: string, version: string): vscode.Disposable {
	return vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
		provideMcpServerDefinitions: () => [
			new vscode.McpHttpServerDefinition('Odoo Inspector', vscode.Uri.parse(url), { Authorization: `Bearer ${token}` }, version),
		],
	});
}
