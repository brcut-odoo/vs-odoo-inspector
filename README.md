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
| Execute | Sends the query built from the current column selection |
| Cancel | Abandons the query; the tool reports the cancellation |

Disabled columns stay visible — dimmed, struck through, with blank cells — so re-enabling one is a single click.

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

2. Run **Odoo: Set Credentials** and paste an API key (recommended) or a `session_id`. Credentials go to the OS keychain via `SecretStorage`, never to settings.

3. Run **Odoo: Connect to Database**, or just invoke a tool — it connects on demand.

## Authentication

| Auth mode | API mode | Notes |
|---|---|---|
| `apiKey` | `/json/2` (18.5+) | `Authorization: Bearer <key>` + `X-Odoo-Database` |
| `apiKey` | `call_kw` (< 18.5) | The key is exchanged for a session via `/web/session/authenticate` |
| `session` | `call_kw` | `session_id` cookie; `/json/2` rejects cookies |

`auto` treats a credential of 40+ characters as an API key.

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
