import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { localhostHostValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

export interface Logger {
	(message: string): void;
}

/**
 * Serves MCP over Streamable HTTP on 127.0.0.1, inside the extension host.
 *
 * Running in-process (rather than as a stdio child) is what lets tool calls
 * reach extension state: the approval store, SecretStorage and the Odoo
 * clients. Every request must carry the bearer token, so other local
 * processes cannot use the server even though it listens on a port.
 *
 * The token and port are meant to be stable across activations: VS Code and
 * the Copilot agent host cache the provided definition and the latter never
 * re-resolves it, so a changing endpoint would leave them with a dead URL.
 *
 * Sessions are stateful: each `initialize` gets its own transport and
 * `McpServer`, built by `createServer(sessionId)`.
 */
export class McpHttpServer {
	readonly token: string;
	private http?: Server;
	private readonly sessions = new Map<string, NodeStreamableHTTPServerTransport>();
	private readonly validateHost = localhostHostValidation();

	constructor(
		private readonly createMcpServer: (sessionId: string) => McpServer,
		private readonly log: Logger,
		private readonly onSessionClosed?: (sessionId: string) => void,
		token?: string,
	) {
		this.token = token ?? randomBytes(32).toString('hex');
	}

	/**
	 * Starts listening, preferring `preferredPort` so the endpoint survives
	 * restarts, and falls back to a random port if that one is taken.
	 */
	async start(preferredPort = 0): Promise<{ url: string; port: number }> {
		try {
			await this.listen(preferredPort);
		} catch (error) {
			if (preferredPort === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
				throw error;
			}
			this.log(`Port ${preferredPort} is in use, picking another one`);
			await this.listen(0);
		}
		const { port } = this.http!.address() as AddressInfo;
		return { url: `http://127.0.0.1:${port}/mcp`, port };
	}

	private async listen(port: number): Promise<void> {
		const http = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			http.once('error', reject);
			http.listen(port, '127.0.0.1', () => {
				http.off('error', reject);
				resolve();
			});
		});
		this.http = http;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.validateHost(req, res)) {
			return;
		}
		if (req.headers.authorization !== `Bearer ${this.token}`) {
			res.writeHead(401).end();
			return;
		}
		if (!req.url?.startsWith('/mcp')) {
			res.writeHead(404).end();
			return;
		}

		try {
			const sessionId = header(req, 'mcp-session-id');
			const existing = sessionId ? this.sessions.get(sessionId) : undefined;
			if (existing) {
				await existing.handleRequest(req, res);
				return;
			}
			if (sessionId) {
				// Unknown session, e.g. after an extension reload: the client
				// re-initializes on 404.
				res.writeHead(404).end();
				return;
			}
			if (req.method !== 'POST') {
				res.writeHead(400).end();
				return;
			}

			const id = randomUUID();
			const transport = new NodeStreamableHTTPServerTransport({
				sessionIdGenerator: () => id,
				onsessioninitialized: (initialized) => {
					this.sessions.set(initialized, transport);
					this.log(`MCP session ${initialized} opened`);
				},
				onsessionclosed: (closed) => {
					this.sessions.delete(closed);
					this.onSessionClosed?.(closed);
					this.log(`MCP session ${closed} closed`);
				},
			});
			const server = this.createMcpServer(id);
			await server.connect(transport);
			await transport.handleRequest(req, res);
		} catch (error) {
			this.log(`MCP request failed: ${(error as Error).stack ?? error}`);
			if (!res.headersSent) {
				res.writeHead(500).end();
			}
		}
	}

	async dispose(): Promise<void> {
		for (const [id, transport] of this.sessions) {
			await transport.close().catch(() => undefined);
			this.onSessionClosed?.(id);
		}
		this.sessions.clear();
		await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
	}
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}
