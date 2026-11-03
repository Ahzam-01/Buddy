# Buddy --- Final Product Development Sprint Plan

**Purpose:** Give Codex a self-contained, implementation-oriented plan
to turn the existing Buddy repository into a usable, near-final desktop
application in one focused sprint.

**Working rule:** Implement the sprint as a coherent batch. Do not run
verification commands after every small change. Inspect the repository
first, implement related changes together, then run the small set of
final checks near the end. Only run an intermediate test when a decision
depends on its result or a change is unusually risky.

---

## 1. Mission and definition of done

Buddy is a local-first desktop control center that lets the user manage
connections to Odoo environments and expose approved tools to ChatGPT
through the OpenAI tunnel-client. The app must be useful as a real
application, not a static UI mockup.

The sprint should deliver:

1.  A coherent, polished desktop UI with functional Overview, Instances,
    Permissions, Activity & Logs, and Settings pages.
2.  Configurable tunnel profiles, including tunnel ID, profile name,
    runtime paths, and secure API-key replacement.
3.  Persistent local settings and instance configuration.
4.  Reliable, explicit Start/Stop behavior for the tunnel client and the
    MCP bridge process that the tunnel profile launches.
5.  Honest connection diagnostics that distinguish local process state,
    tunnel health/control-plane state, MCP initialization/tool
    discovery, and connector reachability.
6.  Environment-specific permission configuration enforced by the
    backend---not merely displayed in the UI.
7.  A useful audit trail with redacted logs and log rotation.
8.  A safe IPC boundary and no arbitrary shell execution exposed to the
    renderer.
9.  A Linux distributable with product metadata branded as Buddy.
10. One final verification pass after implementation, rather than
    repeated checks throughout the sprint.

Do not expand scope into a new hosted Flask/PythonAnywhere service, a
second MCP server, or a new tunnel architecture. Preserve the working
local Node.js bridge and existing tunnel-client unless repository
inspection reveals a concrete blocker.

## 2. Existing project and verified context

The repository is an Electron Forge + Vite + TypeScript application,
currently using a vanilla TypeScript renderer rather than React.

Current project facts from the provided archive:

- Main project path on the user's machine:
  `/home/ahzam/Documents/Buddy`
- UI entry point: `src/renderer.ts`
- Styles: `src/index.css`
- Electron main process: `src/main.ts`
- Preload bridge: `src/preload.ts`
- HTML entry: `index.html`
- Package metadata: `package.json`
- TypeScript configuration: `tsconfig.json`
- Existing scripts include `start`, `package`, `make`, `release`,
  `lint`, `lint:fix`, and `typecheck`.
- Electron context isolation is enabled, Node integration is disabled,
  and the window uses a preload script.
- The main process already contains tunnel lifecycle logic, GNOME
  Keyring lookup, health polling, rotating logs, and secret-redaction
  logic.
- The current tunnel profile launches the local Node.js MCP bridge as
  a child process over `stdio`.
- The existing local bridge exposes two read-only tools:
  `staging_ssh_connectivity` and `staging_docker_status`.
- The bridge was independently tested: MCP `initialize` succeeded,
  `tools/list` returned both tools, and `staging_ssh_connectivity`
  successfully connected through the existing SSH alias `mcit`.
- The tunnel-client health endpoint reported `live: true`,
  `ready: true`, and a successful control-plane poll. Its MCP health
  snapshot showed `status: unknown`, `state: not_observed`,
  `initialize_epoch: 0`, and no observed `tools/list`. The
  tunnel-client's own troubleshooting help says that health reads do
  not trigger discovery and that `stdio` may be ready before discovery
  is observed.
- Therefore, do not claim end-to-end ChatGPT tool discovery is
  verified. The local bridge and control-plane connection are verified
  independently; the full connector path still needs one final
  end-to-end check.
- The existing `src/renderer.ts` has an Overview layout, but
  Instances, Permissions, Activity & Logs, and Settings are
  placeholders.
- The existing renderer exposes only `getTunnelStatus`, `startTunnel`,
  and `stopTunnel` through `window.buddy`.
- The current `src/main.ts` contains hard-coded local paths for the
  tunnel profile and tunnel-client executable and uses a fixed tunnel
  health URL/port.
- `package.json` still uses `buddy-starter` as `name` and
  `productName`, has a starter description, and includes Electron
  Forge makers for deb, rpm, squirrel, and zip.
- The archive included `node_modules` and `.git`; do not commit those
  into product source or include them in new project artifacts.

Treat the repository currently checked out in Codex as authoritative.
The uploaded archive may lag behind local changes. Inspect `git status`
and current files before editing, and preserve unrelated user changes.

## 3. Product principles

### 3.1 Local-first, explicit control

- Opening Buddy must not start the tunnel or MCP server.
- Only an explicit Start action starts runtime processes.
- Stop must shut down the tunnel-client and its child MCP bridge
  cleanly.
- Closing the app should stop the managed tunnel process unless the
  user explicitly chooses a future, deliberately implemented
  background mode.
- Do not create duplicate tunnel-client or bridge processes.
- Do not silently create or switch tunnel IDs.
- Do not silently run privileged or destructive operations.

### 3.2 Security boundaries

- Never expose `child_process`, filesystem access, arbitrary command
  execution, Node APIs, or raw `ipcRenderer` to the renderer.
- Use a narrow typed API in `preload.ts`; validate all IPC inputs in
  the main process.
- No generic `runShell(command)` tool or UI action.
- No Git push capability. Do not implement a push command, hidden
  shortcut, or alternative path to push.
- Never log API keys, SSH private keys, credential values,
  authorization headers, or environment dumps.
- Do not read or display arbitrary environment variables to diagnose a
  service.
- Keep the existing tunnel runtime key in GNOME Keyring / OS
  credential storage. Never store the raw key in the JSON settings
  file.
- Do not include secrets in process arguments. Passing the runtime key
  through the child process environment, as the existing code does, is
  preferable to putting it in argv.
- Redact secrets before writing process output to logs. Avoid
  returning sensitive log lines to the renderer.
- Restrict file operations and configured paths to explicitly
  authorized workspace roots.
- Require confirmation for dangerous or irreversible actions.
- Permission enforcement must happen in the main/backend layer at the
  point of execution, not just by disabling UI controls.

### 3.3 Fast implementation, one final verification pass

- Do not run `npm run typecheck`, lint, package, or tests after every
  individual file edit.
- Inspect all relevant source files first, then design a consistent
  implementation and make related edits in batches.
- Avoid installing new dependencies unless they are genuinely
  required. Prefer Node built-ins and existing dependencies.
- Avoid broad rewrites or migrations from vanilla TypeScript to React.
- Reuse the current visual design and improve it coherently instead of
  replacing it with an unrelated UI framework.
- Run at most one final static-check batch after the implementation is
  complete. Package/build only once after those checks pass.
- If a command fails, diagnose the root cause and fix it; do not rerun
  every unrelated check.
- Do not claim something passed unless the command was actually run
  and its result observed.

## 4. Target architecture

Keep the existing Electron architecture:

- **Renderer (`src/renderer.ts`, `src/index.css`)**: presentation and
  user interaction only.
- **Preload (`src/preload.ts`)**: narrow, typed, allowlisted IPC
  methods.
- **Main process (`src/main.ts`, plus small modules if appropriate)**:
  configuration, credential access, SQLite or JSON persistence,
  lifecycle management, diagnostics, permissions, logging, and audit
  events.
- **Tunnel-client**: launched explicitly by Buddy using the selected
  profile.
- **MCP bridge**: launched by tunnel-client according to the profile's
  configured stdio command. Avoid launching a second bridge process
  separately unless the tunnel-client documentation/configuration
  makes that necessary.
- **Local persistence**: use `app.getPath('userData')` for Buddy's
  database/settings/logs. Do not save user data in the project
  directory or packaged application directory.

Prefer a small, understandable backend module structure if it reduces
risk, for example:

- `src/main.ts` --- Electron window and IPC registration/bootstrap.
- `src/backend/config-store.ts` --- typed persistent configuration and
  migration/defaults.
- `src/backend/credential-store.ts` --- OS keyring access and secret
  replacement.
- `src/backend/tunnel-manager.ts` --- start/stop/status, child
  lifecycle, health polling.
- `src/backend/health.ts` --- parse/normalize health snapshots.
- `src/backend/audit-log.ts` --- structured audit events and rotating
  logs.
- `src/backend/permissions.ts` --- permission policy defaults and
  enforcement.
- `src/shared/types.ts` --- shared serializable types and IPC
  contracts.

These are suggestions, not a mandate to split every function into a
module. A compact implementation is preferable to excessive abstraction.
Keep TypeScript types explicit.

## 5. Configuration and tunnel profiles

This is a top priority because the current paths and tunnel
configuration are hard-coded.

### 5.1 Settings model

Implement versioned persisted settings in the Electron user-data
directory. Use a schema with safe defaults and validation. A JSON file
is acceptable for the first complete sprint if writes are atomic and
schema migration is implemented; SQLite is also acceptable if already
available without substantial setup. Do not add a dependency solely for
a simple configuration file.

A suggested shape:

```ts
type BuddySettings = {
  schemaVersion: number;
  activeProfileId: string | null;
  profiles: TunnelProfile[];
  paths: RuntimePaths;
  general: {
    startOnAppLaunch: false; // must remain false in this sprint
    minimizeToTray: false; // only implement if already supported; otherwise omit
    logRetentionDays: number;
  };
};

type TunnelProfile = {
  id: string;
  name: string;
  tunnelId: string;
  credentialRef: string; // reference/identifier only, never the key itself
  controlPlaneBaseUrl: string;
  healthBaseUrl: string;
  enabled: boolean;
};

type RuntimePaths = {
  tunnelClientPath: string;
  profileDirectory: string;
  mcpBridgeCommand: string;
  mcpBridgeWorkingDirectory: string;
  sshConfigPath: string;
  stagingSshAlias: string;
};
```

Adapt names and exact shape to the existing code, but preserve these
requirements:

- Store a stable profile ID separate from the display name and tunnel
  ID.
- Support adding, editing, selecting, enabling/disabling, and deleting
  profiles. Do not permit deletion of the currently running profile
  until it is stopped.
- Do not assume a profile name uniquely identifies a tunnel.
- Validate tunnel IDs against the documented format `tunnel_` followed
  by 32 lowercase hexadecimal characters, unless official
  documentation for the installed client says otherwise.
- Validate local paths and show actionable errors when an
  executable/profile/bridge file is missing.
- Allow a configurable local health port/base URL only if the
  tunnel-client supports it. Avoid hard-coded port assumptions where
  configuration is available.
- Make the currently active profile obvious and display the selected
  tunnel ID in a masked/truncated form where appropriate.
- Use atomic settings writes (temporary file + rename) and restrictive
  permissions on Linux.
- On corrupt or incompatible settings, preserve the old file, show a
  recoverable error, and provide safe defaults rather than silently
  wiping configuration.
- Never include credentials in settings exports, audit events,
  diagnostics, or UI state.

### 5.2 API-key management

- Add a secure API-key entry/replacement flow to Settings.
- The key is entered into a password input and must never be
  re-displayed after save.
- Store it through GNOME Keyring/Secret Service on Linux; use a small
  credential-store abstraction so other OS credential stores can be
  supported later. Do not pretend Linux keyring support automatically
  makes Windows/macOS credential handling complete.
- Store only a credential reference in Buddy settings.
- The UI may show "Credential saved" / "Credential missing" and a
  "Replace key" action; never return the stored key to the renderer.
- Ensure the main process reads the key only at Start time and passes
  it to the tunnel-client in the child environment, consistent with
  the existing profile's `env:CONTROL_PLANE_API_KEY` behavior.
- Never put the key in the generated YAML, logs, command-line
  arguments, crash details, notifications, or clipboard.
- If `secret-tool` is unavailable or the keyring is locked, show a
  clear actionable error and do not start the tunnel.
- Do not request the user to paste keys into ChatGPT. The app should
  accept them locally.
- Do not include any previously shared key or other secret in source,
  documentation, or test fixtures.

### 5.3 Profile generation

- Buddy should own a safe generated runtime profile under its
  user-data directory or another user-configured runtime directory.
- Generate profile content from validated settings. Do not modify the
  user's manually maintained profile unexpectedly.
- Use the selected profile's tunnel ID, base URL, and credential
  environment-variable reference.
- Preserve the existing stdio MCP channel command and environment
  variables for the bridge, but make local paths/alias configurable.
- Quote/escape YAML values correctly. Prefer a YAML serializer only if
  a dependency already exists or is justified; otherwise implement a
  small, carefully tested serializer for only the supported scalar
  values and reject newlines/control characters.
- Use restrictive file permissions for generated profiles (`0600` on
  Linux).
- Clearly distinguish the user's original profile from Buddy-generated
  profiles in the UI.
- When a profile is edited while running, do not silently mutate a
  live connection. Require stop, save, and restart.
- Avoid creating multiple competing runtime profiles for the same
  active profile without cleanup.

## 6. Runtime lifecycle and status model

### 6.1 Start/Stop lifecycle

Refactor the existing lifecycle carefully; preserve its useful behavior
(health polling, output logging, rotation, key redaction, keyring
lookup, startup timeout, child cleanup) unless a concrete defect is
identified.

Required lifecycle states:

- `stopped`
- `starting`
- `running`
- `stopping`
- `error`

Also track independent component health rather than collapsing
everything into one boolean:

- tunnel process: stopped/starting/running/failed
- local health endpoint: reachable/unreachable
- control-plane poll: successful/stale/failed/unknown
- MCP child process: running/exited/unknown
- MCP initialization: confirmed/not observed/failed/unknown
- tool discovery: confirmed/not observed/failed/unknown, including
  discovered tool names/count if available
- ChatGPT connector reachability: unverified/verified/failed, only
  when a real supported check exists

Important semantics:

- `tunnel-client health --require-control-plane-poll --json` verifies
  process liveness/readiness and a successful control-plane poll; it
  does **not** by itself prove MCP initialization or ChatGPT tool
  access.
- `/health/mcp` is observational. A `not_observed` result does not
  automatically mean initialization failed, especially with `stdio`
  transport. Do not loop on health reads expecting them to trigger
  discovery.
- Do not mark MCP as "connected" solely because the tunnel process is
  running or `/readyz` returns 200.
- Do not report MCP initialization failure solely because the tunnel
  client's snapshot is `not_observed`.
- Show "Not observed yet" / "Unverified" distinctly from "Failed".
- Use the tunnel-client's documented diagnostics and connector flow to
  determine actual readiness; do not invent undocumented CLI flags or
  endpoints.
- Keep a sensible timeout and cancellation behavior.
- If Start is clicked twice, reuse the in-progress start promise
  rather than spawning a duplicate process.
- If Stop is clicked during startup, cancel readiness polling and
  terminate the child.
- Handle child `error`, `exit`, and `close` without double-resolving
  or leaving the UI stuck.
- Ensure the API responds with the latest status and error.
- On application quit, attempt graceful stop, wait briefly, then
  force-kill only the owned child if needed. Do not kill unrelated
  tunnel-client processes.
- The UI must show a meaningful, non-secret error message and point to
  the local log file when appropriate.
- A healthy tunnel with unobserved MCP discovery should be displayed
  as partial readiness, not full success.

### 6.2 Logging and diagnostics

- Preserve rotating logs, currently designed around a 2 MiB log and
  two backups, unless implementation suggests a better sensible limit.
- Rotate logs without losing the newest line; create log directories
  with restrictive permissions.
- Add structured audit events for lifecycle operations, settings
  changes, permission changes, and tool/command actions.
- Log event time, category, action, environment/profile, result,
  duration if available, and a sanitized summary.
- Never log credentials, authorization headers, full process
  environments, private key contents, or arbitrary file contents.
- Keep application audit events distinct from tunnel-client
  stdout/stderr.
- Add an Activity & Logs screen with filter/search by time, event
  type, environment/profile, and result; allow viewing details for an
  event and opening the log folder.
- Include export of redacted logs only if straightforward. Never
  export keyring contents or raw credentials.
- Log retention must be configurable and applied conservatively. Do
  not delete logs silently without policy and user awareness.
- Add a clear "Clear old logs" action only if it confirms the scope
  and preserves current logs when useful.

### 6.3 Health refresh and IPC

- Avoid rapid polling. Use a moderate interval while the dashboard is
  visible and stop polling when not needed.
- IPC calls must return serializable DTOs, not `ChildProcess`, Error
  objects with internal details, or filesystem handles.
- Validate the active profile and runtime path before Start.
- Do not make network calls from the renderer. The main process owns
  health polling.
- The renderer should render status from backend snapshots and must
  not fabricate success state locally.

## 7. Odoo instances page

Instances represent Odoo environments, separate from tunnel profiles. A
tunnel profile controls how ChatGPT connects; an Odoo instance describes
the target environment and its policy.

Implement a useful first-class instance management screen:

- List instances as cards or rows.
- Add, edit, select active, disable/enable, and delete an instance.
- Fields: stable ID, display name, environment type (`development`,
  `staging`, `production`), connection method, host/base URL or SSH
  alias, enabled flag, notes/description, and optional tags.
- Do not ask users to store Odoo passwords in plaintext settings.
  Prefer SSH aliases or a credential-store reference if credentials
  are later supported.
- Make environment labels and warning treatments visually distinct.
  Production should have stronger confirmation and conservative
  defaults.
- Show configured/not-configured and last-known diagnostic status;
  don't claim the instance is reachable unless a real check ran.
- Validate URL/host syntax and reject dangerous schemes or malformed
  values.
- Provide a "Test connection" action only if the backend has a
  specific, safe, read-only implementation for that connection method.
  The existing staging SSH alias can be supported as a first
  implementation.
- Do not run any connection check on app startup.
- Persist configuration and handle empty/loading/error states.
- Add sensible starter defaults only if they are explicitly labeled
  and safe; do not silently invent the user's production/staging
  instances.
- Provide empty-state copy explaining how to add the first instance.
- Do not implement arbitrary remote command execution as an instance
  feature.

## 8. Permissions page and backend enforcement

Permissions are environment-specific and operation-specific. The UI must
reflect actual backend policy.

Define a small capability registry, for example:

- `diagnostics.connectivity` --- run a fixed read-only connectivity
  check
- `diagnostics.docker_status` --- list container
  names/images/status/ports only
- `files.read` --- read approved project files within configured roots
- `files.search` --- search approved roots
- `files.write` --- modify approved files, if implemented in this
  sprint
- `commands.typecheck` --- run `npm run typecheck` in an approved
  workspace
- `commands.lint` --- run the project's lint script
- `commands.tests` --- run a known test script
- `commands.package` --- build/package the app
- `git.status` and `git.diff` --- read-only repository inspection

Do not add a generic arbitrary command capability. Do not add Git push.
Avoid enabling `commands.package`, writes, or potentially destructive
operations by default unless the user explicitly enables them.

Requirements:

- Define safe defaults by environment. Development can permit more
  than staging; production must default to read-only and require
  explicit opt-in for every powerful action.
- The backend checks the permission for every tool/action immediately
  before executing it.
- A denied action returns a structured denial and records an audit
  event.
- The UI explains what each capability permits in plain language.
- Permission changes persist and are auditable.
- Changes to the policy apply to future operations immediately. Do not
  silently revoke a currently running operation mid-write unless safe
  cancellation is supported.
- Do not rely on UI visibility/disabled buttons for security.
- Make "reset to safe defaults" available with a confirmation.
- Include a visible statement that Git push is not supported by Buddy.
- If the current sprint does not implement arbitrary development
  tools, do not pretend the permission toggles control capabilities
  that don't exist. Only display permissions backed by actual
  registered operations.

## 9. Activity & Logs page

Build this page as a functional audit viewer rather than a placeholder:

- Recent activity table/list with timestamp, environment/profile,
  action, result, and duration where known.
- Filters for success/failure/denied, action category, and
  profile/instance.
- Search across safe metadata and redacted messages.
- Detail view for one event.
- Clear empty state, loading state, and error state.
- Button to open the logs directory using a fixed, validated
  main-process action; do not expose arbitrary shell commands.
- Optional export of redacted audit records if simple and safe.
- Keep audit data bounded using retention/rotation.
- Record application start/stop, tunnel start/stop/failure, settings
  updates, profile changes, credential replaced/missing status (never
  the credential value), instance changes, permission changes,
  connection-test outcomes, denied actions, and permitted tool
  execution outcomes.
- Avoid logging every renderer event or normal UI click; audit
  meaningful operations only.

## 10. Settings page

The Settings page must be a real, persisted form with sections.

### Connection/profile settings

- Profiles list and selected profile.
- Add/edit/duplicate/delete profile with safe validation.
- Tunnel ID, control-plane base URL, local health base URL/port where
  supported.
- Credential status and replace-key flow.
- Start/stop status and selected profile state.
- Explain that changes to a running profile take effect after stopping
  and restarting.

### Runtime paths

- Tunnel-client executable path.
- Profile/runtime directory.
- MCP bridge entrypoint.
- Bridge working directory.
- SSH config path and alias.
- Validate executable/file/directory existence when user requests
  "Validate settings" or when starting, not repeatedly on every
  keystroke.
- Provide Browse buttons for local files/directories using native
  Electron dialogs if straightforward.
- Do not allow browsing outside an authorized path without clear user
  intent; the paths themselves can be user-configured.
- Avoid hard-coding `/home/ahzam/...` as the only supported location.
  Defaults may point there for this existing machine, but must be
  editable and show invalid/missing paths clearly.

### General and logs

- Log retention period.
- Open logs directory.
- App version and runtime versions.
- Security notes: keys live in OS credential storage, no auto-start,
  Git push disabled.
- Show actual application version, not a hard-coded stale value.

### Save behavior

- Use explicit Save/Cancel or clear autosave indicators. Do not
  silently discard unsaved edits.
- Show field-level validation and actionable error messages.
- Protect unsaved settings if the user navigates away.
- Prevent edits to active connection settings while the tunnel is
  running, or explain that a restart is required.
- No settings page may display a saved secret.

## 11. Overview page

Turn the Overview into an operational dashboard:

- Selected tunnel profile and selected Odoo instance.
- Separate status cards for Buddy process manager, tunnel/control
  plane, MCP bridge/discovery, and instance diagnostics.
- Start/Stop action with progress and actionable errors.
- Explicit partial states: stopped, starting, running, stopping,
  error, unverified/not observed.
- Shortcuts to manage instances, permissions, settings, and activity.
- Recent meaningful audit events.
- No fake status such as "MCP connected" unless confirmed by evidence.
- No automatic Start on launch.
- Do not reload the entire window to navigate back to Overview; update
  the view without losing state.
- Ensure status refresh updates all relevant components and does not
  leave stale placeholder badges.
- Responsive layout for typical desktop widths and reasonable window
  resizing.

## 12. UI and usability expectations

- Preserve the existing dark visual identity and lime accent; improve
  consistency rather than redesigning from scratch.
- Keep navigation labels: Overview, Odoo instances, Permissions,
  Activity & logs, Settings.
- Use consistent page headers, panels, buttons, forms, status pills,
  empty states, confirmation dialogs, and toast/inline feedback.
- Replace emoji/symbol placeholders with a consistent icon strategy if
  an existing dependency is available; avoid adding a large UI library
  just for icons.
- Use accessible labels, keyboard focus states, appropriate button
  semantics, and visible disabled/loading states.
- Never use `innerHTML` with untrusted user-provided strings. Prefer
  DOM APIs/textContent or proper escaping/template helpers for
  instance names, logs, profile names, paths, and error messages.
- This is especially important because the current renderer inserts
  page titles/descriptions using `innerHTML`. Fix that pattern while
  making the pages functional.
- Avoid inline `onclick` handlers and keep event wiring explicit.
- Prevent double-submit on save/start/stop actions.
- Keep success/error messaging concise and useful.
- Do not add marketing pages, onboarding tours, or decorative features
  that don't help the user operate Buddy.

## 13. IPC contract and preload API

Expand the current `window.buddy` API using explicit, typed methods. Do
not expose a generic `invoke(channel, args)` or raw IPC.

Potential API shape (adapt as needed):

```ts
interface BuddyApi {
  getOverview(): Promise<OverviewSnapshot>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SaveSettingsInput): Promise<OperationResult>;
  listProfiles(): Promise<TunnelProfileSummary[]>;
  saveProfile(input: SaveProfileInput): Promise<OperationResult>;
  deleteProfile(profileId: string): Promise<OperationResult>;
  setActiveProfile(profileId: string): Promise<OperationResult>;
  setCredential(profileId: string, secret: string): Promise<OperationResult>;
  getTunnelStatus(): Promise<TunnelStatusSnapshot>;
  startTunnel(): Promise<OperationResult<TunnelStatusSnapshot>>;
  stopTunnel(): Promise<OperationResult<TunnelStatusSnapshot>>;
  listInstances(): Promise<OdooInstance[]>;
  saveInstance(input: SaveInstanceInput): Promise<OperationResult>;
  deleteInstance(instanceId: string): Promise<OperationResult>;
  listPermissions(): Promise<PermissionPolicy>;
  savePermissions(input: PermissionPolicy): Promise<OperationResult>;
  listActivity(input?: ActivityQuery): Promise<ActivityPage>;
  getActivityDetail(eventId: string): Promise<ActivityEvent | null>;
  openLogsDirectory(): Promise<OperationResult>;
  validateRuntimeSettings(): Promise<RuntimeValidationResult>;
}
```

Only implement API methods that correspond to real features. Return
serializable, sanitized DTOs. Validate object shapes, IDs, string
lengths, paths, URLs, enum values, and permission names in the main
process. Avoid leaking stack traces to the renderer; log sanitized
diagnostic details locally.

Add types to `src/shared/types.ts` or another shared location. Ensure
preload declarations are available to renderer TypeScript without using
a broad `any`.

## 14. Error handling and recovery

- Use a consistent result shape, such as `{ ok: true, data }` or
  `{ ok: false, error: { code, message, recoverable } }`.
- Keep user-facing messages safe and actionable; keep sanitized
  technical details in logs.
- Handle missing tunnel executable, invalid profile, invalid tunnel
  ID, missing credential, locked keyring, health endpoint unavailable,
  startup timeout, child process exit, malformed persisted settings,
  and IPC failures.
- On startup failure, clean up only the child process Buddy started.
- Avoid swallowed exceptions that make the UI appear successful. Do
  not return `running` merely because a process was spawned; return it
  only according to the documented status semantics.
- If MCP discovery remains unobserved by the tunnel-client, display
  that exact uncertainty and explain how to verify the connector; do
  not fabricate a discovery result.
- Ensure stop errors do not leave the state permanently `stopping`.
- Use bounded polling and abort outstanding health requests when
  stopping.

## 15. Packaging and product metadata

Update product identity and build configuration:

- Change `package.json` `name` to a valid normalized Buddy package
  name, `productName` to `Buddy`, and replace the starter description
  with a concise product description.
- Keep the version consistent and avoid unnecessary version bumps.
- Review Electron Forge makers and retain the Linux maker(s) needed
  for this machine. A Debian package (`.deb`) is the primary Linux
  deliverable; a ZIP is useful as a secondary portable artifact if it
  works with the existing setup.
- Remove Windows-only makers only if they cause actual build issues or
  are intentionally out of scope; don't spend sprint time building
  every OS.
- Ensure the packaged app uses correct app/user-data paths and doesn't
  depend on source checkout paths except where runtime tools are
  intentionally user-configured.
- Make logs/config live under Electron's user-data directory.
- Add or update README with install/run/build instructions,
  requirements for the tunnel-client, MCP bridge, GNOME Keyring/Secret
  Service, SSH config, current Linux support, security model, and
  known limitation that end-to-end ChatGPT connector verification is
  required.
- Do not bundle secrets, SSH config, tunnel runtime keys, private key
  files, or the user's local MCP profile.
- Do not include `node_modules`, `.git`, logs, build output, local
  settings, or key material in new source archives.

## 16. Implementation sequence (batch work; minimal intermediate verification)

Codex should follow this order, but should not run a check after each
phase.

### Phase A --- Inspect and design (one pass)

1.  Inspect `git status --short`, package metadata, all files under
    `src`, Forge/Vite configuration, and README.
2.  Identify user changes and preserve them.
3.  Map existing lifecycle and UI code to the target requirements above.
4.  Write down the planned file changes internally or in a short
    progress note. Do not ask the user to paste files already present in
    the repo.
5.  Do not run test suites or package builds during this phase.

### Phase B --- Implement shared models, settings, and credential handling

1.  Add shared typed DTOs and validation helpers.
2.  Implement versioned settings persistence under
    `app.getPath('userData')`.
3.  Implement profile CRUD, active profile selection, safe defaults,
    atomic writes, and migration.
4.  Implement credential storage through GNOME Keyring using
    `secret-tool` with timeouts and clear errors. Keep secret values out
    of settings and renderer results.
5.  Implement generated runtime profile writing with restrictive
    permissions and validated YAML scalar values.
6.  Make paths and SSH alias configurable; use current machine paths
    only as editable defaults.
7.  Avoid introducing SQLite unless needed; versioned JSON is sufficient
    for the initial complete product if done safely.

### Phase C --- Implement lifecycle and diagnostics

1.  Refactor existing tunnel lifecycle into a testable manager if
    useful, preserving current security and logging behavior.
2.  Use the active profile and generated runtime profile.
3.  Implement robust Start/Stop cancellation, duplicate-start
    protection, unexpected exit handling, and app-quit cleanup.
4.  Normalize health snapshots into separate tunnel/control-plane/MCP
    statuses.
5.  Ensure no auto-start.
6.  Implement runtime validation as an explicit action and before Start.
7.  Add structured audit events for lifecycle and configuration actions.
8.  Do not claim MCP connected from tunnel health alone.

### Phase D --- Implement permissions and instances

1.  Add persistent Odoo instance CRUD and safe validation.
2.  Implement a capability registry containing only actual supported
    operations.
3.  Add per-environment permission defaults and backend enforcement.
4.  Record denied and successful actions.
5.  Keep production read-only by default.
6.  Keep Git push permanently unsupported.
7.  Do not add arbitrary shell or generic remote command execution.

### Phase E --- Implement all UI pages and connect them to IPC

1.  Build Settings form/profile manager and credential replacement UI.
2.  Build Odoo instances page.
3.  Build Permissions page with real backend policy.
4.  Build Activity & Logs page with search/filter/details.
5.  Upgrade Overview to show component-specific health and recent
    activity.
6.  Use DOM-safe rendering for all user-configurable strings.
7.  Connect controls to real IPC operations and persistent data.
8.  Handle loading, empty, validation, error, and success states.
9.  Ensure navigation doesn't reload the app or discard state.
10. Keep the visual design consistent.

### Phase F --- Packaging metadata and documentation

1.  Update package/product metadata.
2.  Ensure Linux `.deb` maker and build paths are appropriate.
3.  Update README for real user setup and security.
4.  Review ignore rules so local secrets and generated artifacts are
    excluded.
5.  Do not include a real API key, `.env`, SSH private key, keyring
    database, or runtime profile in source.

### Phase G --- One final verification batch

Only after all implementation work is complete, run one concise batch of
checks: 1. `npm run typecheck` 2. `npm run lint` 3. One packaging/build
command appropriate for Linux, preferably `npm run make` if
time/resources allow. 4. Inspect the final Git diff and package contents
for accidental secrets or unrelated changes. 5. Fix any failures, then
rerun only the failed check(s) and final packaging if affected. 6. Do
not launch multiple long builds or run checks after each small edit. 7.
Do not claim end-to-end MCP/ChatGPT integration is verified by
typecheck/lint/build. That requires a real connector invocation after
the app is run.

If there is an unusually risky decision (for example, uncertain
tunnel-client profile syntax or keyring behavior), one targeted
inspection or small check is acceptable before committing to the
implementation. Avoid broad diagnostic loops.

## 17. Final end-to-end acceptance checklist

Use this checklist after the one final verification batch and a manual
run:

### App and persistence

- [ ] Buddy opens without starting any tunnel or MCP process.
- [ ] Settings and instances persist after app restart.
- [ ] Invalid/corrupt settings are handled without data loss.
- [ ] Product identity displays as Buddy, not `buddy-starter`.

### Profiles and credentials

- [ ] User can create, edit, select, and delete profiles safely.
- [ ] Tunnel ID is configurable and validated.
- [ ] API key can be entered/replaced locally and stored securely.
- [ ] Raw credentials never appear in UI after save, settings files,
      logs, argv, or exported files.
- [ ] Runtime profile is generated from the selected profile and
      paths.
- [ ] Switching or editing the active profile while running is handled
      safely.

### Runtime

- [ ] Start launches the intended tunnel client only after explicit
      user action.
- [ ] Start does not spawn duplicate processes on repeated clicks.
- [ ] Stop terminates the process Buddy owns and cleans up its MCP
      child.
- [ ] Startup timeout, missing executable, missing credential, and
      unexpected process exit show actionable states.
- [ ] Tunnel/control-plane health is separate from MCP discovery
      state.
- [ ] No automatic start on launch.

### UI

- [ ] All five pages have working features and real data.
- [ ] Navigation does not reload the whole application.
- [ ] Forms validate input and show save/error status.
- [ ] No user-configurable strings are injected unsafely into
      `innerHTML`.
- [ ] Empty/loading/error states are coherent.
- [ ] Overview displays the actual status of components, without
      fabricated success.

### Permissions and audit

- [ ] Backend enforces permission checks for supported actions.
- [ ] Production defaults are read-only.
- [ ] Git push is not implemented or exposed.
- [ ] No generic arbitrary shell execution is exposed.
- [ ] Success, failure, and denied actions are audited with secrets
      redacted.
- [ ] Logs rotate and stay under the configured retention policy.

### Release and connector

- [ ] Linux package builds successfully.
- [ ] Packaged app can be installed/launched and uses user-data paths.
- [ ] No keys, SSH private files, or local runtime configuration are
      packaged.
- [ ] Real ChatGPT connector invocation confirms whether the tools are
      discoverable and executable through the tunnel.
- [ ] If the tunnel client still reports MCP `not_observed`, document
      that honestly and use the supported connector invocation as the
      end-to-end proof rather than misreading health output.

## 18. Scope controls --- what not to do

Do not spend this sprint on:

- A separate Python/Flask server or PythonAnywhere deployment.
- Rewriting the project in React or another framework.
- Replacing the working local Node.js bridge without a concrete
  blocker.
- Creating another tunnel or connector unnecessarily.
- Adding generic shell access to ChatGPT.
- Adding Git push or remote deployment actions.
- Building full multi-OS packaging before the Linux build is stable.
- Adding elaborate onboarding, marketing pages, themes, or
  nonessential animation.
- Repeated test/typecheck/lint runs after every small change.
- Endless polling of health endpoints that do not trigger MCP
  discovery.
- Claiming MCP or ChatGPT connectivity is confirmed without a real
  tool invocation.

## 19. How Codex should work with the user

- Work directly in the existing repository.
- Do not ask the user to paste files that are already available in the
  checkout.
- Do not ask broad questions unless an unresolved decision materially
  blocks safe implementation.
- Prefer safe defaults and document assumptions.
- If a choice is reversible and low-risk, make a sensible decision and
  proceed.
- Make related changes in batches.
- Before any destructive operation, ask for explicit approval.
- Never expose or request the user's API key in chat.
- Keep progress messages short and concrete.
- Prioritize a working product over excessive narration.
- At completion, summarize implemented features, files changed, final
  check results, known limitations, and the single manual action
  needed to verify the ChatGPT connector.

---

## Expected sprint outcome

At the end of this sprint, Buddy should be a cohesive, configurable
Linux desktop application with persistent profiles, secure credential
handling, reliable explicit lifecycle control, functional management
screens, backend-enforced permissions, audit logs, and a buildable
package. The local MCP bridge and tunnel-client should remain the
runtime foundation.

The only item that cannot be honestly guaranteed from code changes alone
is successful end-to-end ChatGPT connector discovery/execution; that
must be confirmed against the actual connector after the app is running.
