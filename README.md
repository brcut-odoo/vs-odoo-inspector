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

### "Lifetime of the chat"

Approvals are kept in memory per **MCP session**, and nothing is written to disk. VS Code may share one MCP session across several chats, so in practice approvals can outlive a single chat until the MCP server restarts or the window reloads. To clear them:

- the **Reset approvals for this chat** link in the approval view;
- **Odoo: Reset Column Approvals** (everything) or **Odoo: Manage Column Approvals** (per session; also the shield item in the status bar).

## Setup

1. **Odoo: Add Connection** asks for the URL, database, login, credential kind, protocol, a name, and then the secret.
2. In Chat (agent mode), enable the **Odoo Inspector** MCP server in the tools picker.
3. Ask something like *"Which 5 customers have the largest open invoices?"*

Credentials are stored in the OS keychain (VS Code `SecretStorage`), never in settings.

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
| `odoo_list_models`, `odoo_get_fields` | none (metadata only) |
| `odoo_search_read`, `odoo_read`, `odoo_read_group` | column approval |
| `odoo_execute_kw` | read methods: column approval. Everything else: always reviewed before sending. **Off** unless `odooInspector.enableExecuteKw` is set. |
| `odoo_approval_preview`, `odoo_approval_decide`, `odoo_approval_reset` | app-only: called by the approval view, hidden from the model |

When the model asks for no fields, a default set of up to 12 useful stored fields is fetched. Binary, HTML and x2many fields are skipped.

## Settings

| Setting | Default | |
|---|---|---|
| `odooInspector.connections` | `[]` | Managed by **Add Connection** |
| `odooInspector.activeConnection` | `""` | Used when a tool names no connection |
| `odooInspector.rateLimitPerSecond` | `1` | Odoo SaaS throttles hard; 0 disables |
| `odooInspector.maxRows` | `200` | Most rows a read returns |
| `odooInspector.approval.previewRows` | `50` | Rows shown in the approval table |
| `odooInspector.approval.autoApproveKnownColumns` | `true` | Skip the view when every column is already approved |
| `odooInspector.enableExecuteKw` | `false` | Expose `odoo_execute_kw` |

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
