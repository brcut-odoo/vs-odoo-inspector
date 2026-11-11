# VS Odoo Inspector

Lets AI chat in VS Code query Odoo databases, while you decide exactly which columns and values reach the model.

The extension runs an MCP server inside VS Code. When a tool reads Odoo data, the chat shows the real rows in a table **inside the conversation**, with a checkbox on every column. Only the columns you tick are returned to the model. Columns you approve stay approved for the rest of the chat session, so follow-up questions don't ask again.

## How approval works

1. The model calls a read tool, for example `odoo_search_read`.
2. The extension fetches the records from Odoo and keeps them. Nothing goes to the model yet.
3. The chat renders the approval view (an [MCP App](https://modelcontextprotocol.io/extensions/apps/overview)). It shows the rows, one checkbox per column, and badges:

   | Badge | Meaning |
   |---|---|
   | approved | You approved this column earlier in the chat |
   | withheld before | You withheld it earlier; it starts unticked |
   | new | Not decided yet |
   | filter | The query filters, sorts or groups on it. Filtering can reveal values, so it needs approval even when it isn't returned |

4. **Approve selected**, **Approve all** or **Deny**. The tool call returns only the approved columns. The model is told the names of withheld columns, never their values.
5. On later reads in the same chat session, if every column was already approved, the call goes through without asking. Withheld columns are still removed. Turn this off with `odooInspector.approval.autoApproveKnownColumns`.

**Writes are always reviewed.** Writes are `odoo_execute_kw` with `create`, `write`, `unlink` or any non-read method. Stored approvals never cover them. For `create`/`write`, you can untick fields to remove them from the values before anything is sent. **Deny** sends no request to Odoo.

Clients without MCP Apps but with elicitation get a form with one checkbox per column, with sample values in each description. Clients with neither get a refusal, because there's no way to ask you.

Some hosts, such as Claude Desktop, support MCP Apps but only show the view after the tool call returns. If no view has loaded the request within 10 seconds, the call returns a fetch id instead of data. Later calls in the same chat return their fetch id right away instead of waiting 10 seconds again.

The view then appears with that call, and the model calls `odoo_fetch_approved` with the fetch id. The fetch id differs from the id the view uses to approve, so the model can't use it to approve its own request. `odoo_fetch_approved` waits until you approve or deny in the view, then returns the result or your denial. A read returns the rows you reviewed, with only the approved columns, and isn't fetched from Odoo again. A write is sent exactly as you reviewed it, minus the fields you removed. Each approval can be fetched once. If the fetch is cancelled, the approval stays open and the model can fetch it again. An unanswered request expires after 10 minutes.

### "Lifetime of the chat"

Approvals are kept in memory per **MCP session**, and nothing is written to disk. VS Code may share one MCP session across several chats, so in practice approvals can outlive a single chat until the MCP server restarts or the window reloads. To clear them:

- the **Reset approvals for this chat** link in the approval view;
- **Odoo: Reset Column Approvals** (everything) or **Odoo: Manage Column Approvals** (per session; also the shield item in the status bar).

## Setup

There is nothing to configure ahead of time.

1. In Chat (agent mode), enable the **Odoo Inspector** MCP server in the tools picker.
2. Ask something like *"Which 5 customers have the largest open invoices?"*
3. The model calls `odoo_connect`, and VS Code asks whether to connect. Pick a recent connection, **New connection…**, or **Decline** (Escape declines too). The model is told you declined and won't ask again unless you do.

A new connection asks for the server URL and then the database. The database list comes from the server (`/web/database/list`, falling back to `db.list`). If the server won't list its databases (`list_db = False`) or can't be reached, you type the name instead. After that come the login, the credential kind, the protocol and the secret.

### Claude Desktop

Run **Odoo: Add to Claude Desktop**, then quit and reopen Claude Desktop. The command adds an `odoo-inspector` entry to `claude_desktop_config.json` and leaves the rest of the file unchanged. If the file isn't valid JSON, the command leaves it alone and tells you why. The config file is in:

- macOS: `~/Library/Application Support/Claude/`
- Windows: `%APPDATA%\Claude\`
- Linux (community builds): `~/.config/Claude/`

Claude Desktop can't reach the server directly. It only launches local stdio servers from its config, and its custom connectors are called from Anthropic's servers, which can't reach `127.0.0.1`. So the entry runs [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with `npx` to bridge stdio to the extension's HTTP endpoint. Node.js must be installed and on the PATH Claude Desktop sees.

The bearer token isn't stored in Desktop's config. `mcp-remote` reads it from a `--header-file` in the extension's global storage, readable only by you (mode 0600). The server only answers while a VS Code window with this extension is open. If that window ends up on a different port, for example because another window already holds it, you're warned and can point Claude Desktop at it. The command refuses to run from a remote window (SSH, WSL, containers), because Desktop on your computer couldn't reach the server there.

### Connection lifetime

Connections are **ephemeral**. Each belongs to the chat's MCP session and is dropped when that session ends, the window reloads, or you run **Odoo: Disconnect**. Secrets are held in memory only, and never written to settings or the keychain. To pre-fill later prompts, the extension remembers the last 10 connections' URL, database, login, credential kind and protocol, but never the secret. A recent connection only asks for the secret. **Odoo: Forget Connection History** clears that list.

## Authentication and protocols

| | `jsonrpc` (`/jsonrpc`) | `xmlrpc` (`/xmlrpc/2`) | `callKw` (`/web/dataset/call_kw`) | `json2` (`/json/2`) |
|---|---|---|---|---|
| **Password** | ✓ | ✓ | ✓ (exchanged for a session) | — |
| **API key** | ✓ | ✓ | — (Odoo refuses API keys for web sessions) | ✓ (Odoo 18.5+) |
| **Session token** | — | — | ✓ | — |

With `protocol: auto`:
- a session token uses `callKw`;
- an API key uses `json2` on Odoo 18.5+ and `jsonrpc` below that;
- a password uses `jsonrpc`.

A combination that can't work fails at once with an explanation.

- **Users with two-factor authentication** can't use a password over RPC. Use an API key, or a session token copied from a logged-in browser (the `session_id` cookie).
- **Session tokens expire.** When Odoo rejects one, you're asked once for a new credential.
- `/jsonrpc` and `/xmlrpc/2` are deprecated from Odoo 19. Prefer an API key with `json2` where available.

## Tools

| Tool | Gate |
|---|---|
| `odoo_connect` | the user fills in the connection details, or declines |
| `odoo_list_connections` | none (lists this chat's open connections) |
| `odoo_fetch_approved` | waits for your answer in the view, then returns the approved result (hosts that show the view only after the call returns) |
| `odoo_list_models`, `odoo_get_fields` | none (metadata only) |
| `odoo_search_read`, `odoo_read`, `odoo_read_group` | column approval |
| `odoo_execute_kw` | read methods: column approval. Everything else: always reviewed before sending. |
| `odoo_approval_preview`, `odoo_approval_decide`, `odoo_approval_reset` | app-only: called by the approval view, hidden from the model |

When the model asks for no fields, a default set of up to 12 useful stored fields is fetched. Binary, HTML and x2many fields are skipped.

## Settings

| Setting | Default | |
|---|---|---|
| `odooInspector.rateLimitPerSecond` | `1` | Odoo SaaS throttles hard; 0 disables |
| `odooInspector.maxRows` | `200` | Most rows a read returns |
| `odooInspector.approval.previewRows` | `50` | Rows shown in the approval table |
| `odooInspector.approval.autoApproveKnownColumns` | `true` | Skip the view when every column is already approved |
## Development

```sh
pnpm install
pnpm run compile        # type-check + lint + bundle (extension + inlined view)
pnpm run lint           # ESLint (typescript-eslint, type-aware promise checks)
pnpm test               # unit tests
pnpm run check:view     # drives the approval view in headless Chrome (CHROME=/path/to/chrome)
```

Against a real Odoo:

```sh
export ODOO_IT_URL=http://127.0.0.1:8069 ODOO_IT_DB=mydb ODOO_IT_LOGIN=admin ODOO_IT_PASSWORD=admin ODOO_IT_API_KEY=…
pnpm run test:integration   # every auth × protocol pair
pnpm run e2e                # full approval flow through a real MCP client
```

Press F5 to start an Extension Development Host. **Odoo: Show Output** logs every connection, approval and decision.
