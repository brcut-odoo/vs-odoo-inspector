# VS Odoo Inspector

Query an Odoo database from VS Code, with a table-based gate that lets you review and edit a request before it is sent — and see the results in the same table.

## What it does

- **Talks to Odoo over JSON-RPC**, auto-detecting the API mode: `/json/2` with a Bearer API key on Odoo 18.5+, `/web/dataset/call_kw` with a session cookie below that.
- **Exposes MCP tools** two ways: native VS Code language model tools, and a bundled stdio MCP server that works in any MCP client.
- **Gates every query through the Query Workbench** — a webview table whose columns are the fields that would be returned. Click a column header to include or exclude that field from the request. Click Execute and the rows render in place.

## The Query Workbench

The workbench is both the request editor and the result viewer.

| Interaction | Effect |
|---|---|
| Click a column header | Toggles that field's inclusion in the request |
| Hover a header, click the caret | Sorts by that column |
| Approve / Execute | Sends the query built from the current column selection |
| Cancel | Abandons the query; the tool reports the cancellation |

Disabled columns stay visible — dimmed, struck through, with blank cells — so re-enabling one is a single click.

### Preview

Read-only queries are sampled before the table opens, so you see the real records while reviewing rather than approving a query blind. A banner marks the rows as a sample and the button reads **Approve** instead of **Execute**.

- If you approve without changing anything, the existing sample is returned and no second request is made.
- Editing the columns, sorting, or changing the query in **Advanced (JSON)** invalidates the sample; Approve then runs the query for real.
- `odoo_call_method` is never previewed — its side effects are unknown, so it must not run before approval. Its approval table has no rows.
- If the sample fails (for example on a protected field) the banner says so and the query remains reviewable.
- The sample respects `odooInspector.maxRows`, so it never fetches more than the result table would show.

## Setup

1. Add a connection in Settings under `odooInspector.connections`:

   ```json
   {
     "odooInspector.connections": [
       {
         "name": "local",
         "url": "http://localhost:8069",
         "db": "my_database",
         "login": "admin",
         "authMode": "auto"
       }
     ]
   }
   ```

2. Run **Odoo: Set Credentials** and paste an API key (recommended), a `session_id`, or a password. Credentials go to the OS keychain via `SecretStorage`, never to settings.

3. Run **Odoo: Connect to Database**, or just invoke a tool — it connects on demand.

## Authentication

| Auth mode | API mode | Notes |
|---|---|---|
| `apiKey` | `/json/2` (18.5+) | `Authorization: Bearer <key>` + `X-Odoo-Database` |
| `apiKey` | `call_kw` (< 18.5) | The key is exchanged for a session via `/web/session/authenticate` |
| `session` | `call_kw` | `session_id` cookie; `/json/2` rejects cookies |
| `password` | `call_kw` | The password is exchanged for a session; `/json/2` only accepts API keys |

`auto` picks the mode from the credential's shape:

| Credential | Detected as | Why |
|---|---|---|
| 40 lowercase hex characters | `apiKey` | Odoo generates 20 random bytes hexlified (`API_KEY_SIZE`) |
| 42 url-safe characters | `session` | werkzeug session ids are 42 characters (`STORED_SESSION_BYTES`) |
| anything else | `password` | Exchanged for a session on connect |

Set `authMode` explicitly when the shape is ambiguous — a 40-character password that happens to be hexadecimal would be read as an API key.

### Password auth

Passwords work, with two caveats:

- **Two-factor authentication blocks it.** Odoo refuses to open an RPC session for a user with TOTP enabled and returns `uid: null`; the extension reports this and suggests an API key. Use `apiKey` for such users.
- **Prefer API keys.** They are revocable and scoped. A password in the keychain is a full login credential.

Password mode always uses `call_kw`, so it loses `/json/2` on Odoo 18.5+.

## Tools

| Tool | Read-only | Purpose |
|---|---|---|
| `odoo_list_models` | yes | List models, optionally filtered |
| `odoo_get_fields` | yes | Field metadata for a model |
| `odoo_search_read` | yes | Search and return records |
| `odoo_read_records` | yes | Read records by id |
| `odoo_count_records` | yes | Count matching records |
| `odoo_call_method` | no | Call any public method — **disabled by default** |

`odoo_call_method` is effectively unrestricted database access. Enable it only via `odooInspector.enableArbitraryMethodCalls`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `odooInspector.connections` | `[]` | Connection list |
| `odooInspector.activeConnection` | `""` | Default connection |
| `odooInspector.rateLimitPerSecond` | `1` | Request throttle; raise only for local DBs |
| `odooInspector.maxRows` | `200` | Rows returned to the language model |
| `odooInspector.queryGate` | `always` | `always` / `writes-only` / `never` |
| `odooInspector.enableArbitraryMethodCalls` | `false` | Enables `odoo_call_method` |

## MCP server

The extension registers a stdio MCP server (`dist/mcpServer.js`) via `contributes.mcpServerDefinitionProviders`. It appears under **MCP: List Servers** and in the tools picker.

Because the server is a separate process with no editor access, its gate is two-phase: the first call returns the proposed query and a token, and `odoo_confirm_query` executes it.

## Development

```bash
npm install
npm run compile      # type-check + lint + bundle all three entry points
npm run watch        # incremental rebuild
npm run test:unit    # pure-logic tests (no VS Code host needed)
npm test             # full extension tests (requires a runnable VS Code)
```

Three bundles are produced:

| Entry | Output | Target |
|---|---|---|
| `src/extension.ts` | `dist/extension.js` | Node (extension host) |
| `src/mcpServer.ts` | `dist/mcpServer.js` | Node (stdio MCP server) |
| `src/ui/workbench/main.ts` | `dist/webview/workbench.js` | Browser (webview) |

Press `F5` to launch the Extension Development Host.

## Known limitations

- Read-only by default; write tools are not exposed.
- No webview virtualization yet — very large result sets render slowly.
- Single connection at a time.
- `npm test` cannot run on NixOS without a patched VS Code binary; use `npm run test:unit`.
