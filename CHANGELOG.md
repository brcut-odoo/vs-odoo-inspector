# Changelog

All notable changes to the "vs-odoo-inspector" extension.

## [0.1.0]

Initial implementation.

### Added

- **Odoo JSON-RPC client** with automatic API-mode detection:
  - `/json/2/<model>/<method>` with Bearer API keys on Odoo 18.5+.
  - `/web/dataset/call_kw` with a `session_id` cookie on older versions.
  - API keys are exchanged for a session when the server predates `/json/2`.
- **Query Workbench** webview: a table whose columns are the fields that would be returned. Clicking a column header toggles that field's inclusion in the request; results render in the same table after execution.
- **Native language model tools**: `odoo_list_models`, `odoo_get_fields`, `odoo_search_read`, `odoo_read_records`, `odoo_count_records`, `odoo_call_method`.
- **Bundled stdio MCP server** registered via `contributes.mcpServerDefinitionProviders`, exposing the same tools to any MCP client. Its gate is two-phase (`odoo_confirm_query`) because it has no editor access.
- **Query validation** against `fields_get`: unknown fields, unknown domain operators, and unknown sort fields are caught before a round-trip.
- **Credential storage** in the OS keychain via `SecretStorage`.
- **Rate limiting**, defaulting to 1 request/second to match Odoo SaaS throttling.
- Unit tests for backend shaping, version detection, the column model, and spec validation.

### Known limitations

- Read-only by default; `odoo_call_method` is disabled behind a setting.
- No webview row virtualization.
- One active connection at a time.
