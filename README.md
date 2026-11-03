# Buddy

Buddy is a local-first Linux desktop control center for configuring Odoo instances and operating its bundled OpenAI tunnel-client and first-class MCP server.

## Run and build

Install Node.js and project dependencies, then run `npm start`.

Buddy owns its tunnel-client and MCP server. It requires an SSH configuration for SSH-backed instance diagnostics and GNOME Keyring / Secret Service (`secret-tool`) for tunnel runtime keys. Nothing starts automatically.

## Security model

- Keys are saved through GNOME Keyring and are never written to Buddy settings, process arguments, or the UI after saving.
- Settings, generated runtime profiles, logs, and audit records live in Electron's user-data directory, not this checkout.
- Buddy exposes a narrow IPC API. The renderer cannot access Node, arbitrary commands, filesystems, or raw Electron IPC.
- The Buddy MCP server speaks stdio MCP to the tunnel-client and crosses an ephemeral authenticated Unix socket to the main process. The main process resolves instances, enforces permissions, executes operations, and writes audit records. Git push and arbitrary shell commands are not supported.

## Connector verification

Buddy can verify the tunnel process, health endpoint, and control-plane poll. MCP `not observed` means the client has not observed stdio discovery; it is not proof of failure or success. After starting Buddy, invoke a real configured ChatGPT connector tool to verify end-to-end discovery and execution.
