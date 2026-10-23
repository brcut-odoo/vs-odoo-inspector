/**
 * Standalone stdio MCP server.
 *
 * This is a separate process from the extension host, so it cannot touch VS
 * Code APIs. It reuses the same tool registry, but the interactive gate is
 * replaced by a two-phase protocol: the first call returns the proposed query
 * and a token, the second call with `confirm: true` executes it.
 *
 * Configuration comes from environment variables set by the extension's
 * `McpServerDefinitionProvider`:
 *   ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_CREDENTIAL, ODOO_API_MODE
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { OdooClient } from './odoo/client';
import { ApiMode, OdooError, QuerySpec } from './odoo/types';
import { createTools, ToolContext, ToolDefinition } from './tools/registry';
import { shapeOf } from './tools/jsonSchemaToZod';
import { normalizeSpec } from './query/spec';

/** Pending queries awaiting a `confirm` call. */
const pending = new Map<string, QuerySpec>();

function readEnv(name: string): string | undefined {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : undefined;
}

async function createClient(): Promise<OdooClient> {
	const url = readEnv('ODOO_URL');
	const db = readEnv('ODOO_DB');
	const login = readEnv('ODOO_LOGIN');
	const credential = readEnv('ODOO_CREDENTIAL');
	const apiMode = readEnv('ODOO_API_MODE') as ApiMode | undefined;

	if (!url || !db || !login || !credential) {
		throw new Error(
			'Missing Odoo connection settings. The MCP server expects ODOO_URL, ODOO_DB, ODOO_LOGIN and ODOO_CREDENTIAL.',
		);
	}

	const client = new OdooClient({
		connection: { name: 'mcp', url, db, login, authMode: 'auto' },
		credential,
		rateLimitPerSecond: Number(readEnv('ODOO_RATE_LIMIT') ?? 1),
		forceApiMode: apiMode === 'json2' || apiMode === 'callKw' ? apiMode : undefined,
	});
	await client.connect();
	return client;
}

/**
 * The MCP gate: instead of opening an editor, return the proposed query and
 * require the caller to re-invoke with `confirm: true`.
 *
 * Throwing `PendingConfirmation` unwinds out of the tool handler, which turns
 * it into a "here is the query, call odoo_confirm_query" response.
 */
function createGate(): ToolContext['gate'] {
	return async (spec) => {
		const token = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		pending.set(token, spec);
		throw new PendingConfirmation(token, spec);
	};
}

class PendingConfirmation extends Error {
	constructor(
		readonly token: string,
		readonly spec: QuerySpec,
	) {
		super('pending-confirmation');
	}
}

/** Converts a registry tool into an MCP tool registration. */
function registerTool(
	server: McpServer,
	tool: ToolDefinition,
	getContext: () => Promise<ToolContext>,
): void {
	server.registerTool(
		tool.name,
		{
			title: tool.title,
			description: tool.description,
			inputSchema: shapeOf(tool.inputSchema),
			annotations: {
				title: tool.title,
				readOnlyHint: tool.readOnly,
				destructiveHint: !tool.readOnly,
			},
		},
		async (args: Record<string, unknown>) => {
			try {
				const context = await getContext();
				const result = await tool.run(args, context);
				return { content: [{ type: 'text' as const, text: result.text }] };
			} catch (error) {
				if (error instanceof PendingConfirmation) {
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`This query needs confirmation before it runs.\n\n` +
									`Proposed query:\n\`\`\`json\n${JSON.stringify(error.spec, null, 2)}\n\`\`\`\n\n` +
									`To execute it, call \`odoo_confirm_query\` with token "${error.token}". ` +
									`To change it first, call the tool again with your edits.`,
							},
						],
					};
				}
				const message = error instanceof OdooError
					? `${error.message}\n\nHint: ${error.hint}`
					: (error as Error).message;
				return {
					content: [{ type: 'text' as const, text: message }],
					isError: true,
				};
			}
		},
	);
}

async function main(): Promise<void> {
	const server = new McpServer({ name: 'vs-odoo-inspector', version: '0.1.0' });

	let clientPromise: Promise<OdooClient> | undefined;
	const getClient = (): Promise<OdooClient> => {
		clientPromise ??= createClient();
		return clientPromise;
	};

	const getContext = async (): Promise<ToolContext> => ({
		client: await getClient(),
		maxRows: Number(readEnv('ODOO_MAX_ROWS') ?? 200),
		gate: createGate(),
	});

	for (const tool of createTools()) {
		registerTool(server, tool, getContext);
	}

	// The confirmation half of the two-phase gate.
	server.registerTool(
		'odoo_confirm_query',
		{
			title: 'Confirm a pending Odoo query',
			description:
				'Executes a query that was previously proposed by another Odoo tool and returned a confirmation token. ' +
				'Only call this after the user has agreed to run the query.',
			inputSchema: shapeOf({
				type: 'object',
				properties: {
					token: { type: 'string', description: 'The token returned by the proposing tool.' },
				},
				required: ['token'],
			}),
			annotations: { title: 'Confirm a pending Odoo query', readOnlyHint: false },
		},
		async (args: Record<string, unknown>) => {
			const token = String(args.token ?? '');
			const spec = pending.get(token);
			if (!spec) {
				return {
					content: [{ type: 'text' as const, text: `Unknown or expired token "${token}".` }],
					isError: true,
				};
			}
			pending.delete(token);

			try {
				const client = await getClient();
				const result = await client.call(normalizeSpec(spec));
				const text = Array.isArray(result)
					? JSON.stringify(result, null, 2)
					: String(result);
				return { content: [{ type: 'text' as const, text }] };
			} catch (error) {
				const message = error instanceof OdooError
					? `${error.message}\n\nHint: ${error.hint}`
					: (error as Error).message;
				return { content: [{ type: 'text' as const, text: message }], isError: true };
			}
		},
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	process.stderr.write(`vs-odoo-inspector MCP server failed: ${(error as Error).message}\n`);
	process.exit(1);
});
