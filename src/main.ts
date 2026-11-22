import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import started from 'electron-squirrel-startup';
import type {
  ActivityEvent,
  DeploymentNature,
  EnvironmentType,
  InstancePermission,
  InstancePermissions,
  OdooInstance,
  OperationResult,
  PublicSettings,
  RuntimePaths,
  TunnelProfile,
  TunnelStatusSnapshot,
  TunnelRuntimeDiagnostic,
} from './shared/types';

const execFileAsync = promisify(execFile);
const SETTINGS_VERSION = 3,
  LOG_MAX_BYTES = 2 * 1024 * 1024,
  LOG_BACKUP_COUNT = 2,
  STARTUP_TIMEOUT_MS = 60_000,
  keyringApp = 'buddy';
let windowRef: BrowserWindow | null = null,
  child: ChildProcess | null = null,
  startTask: Promise<TunnelStatusSnapshot> | null = null,
  stopTask: Promise<void> | null = null,
  stopRequested = false,
  runtimeKey: string | null = null,
  state: TunnelStatusSnapshot['state'] = 'stopped',
  errorMessage: string | null = null,
  runningProfileId: string | null = null,
  health: TunnelStatusSnapshot = emptyStatus();
let bridgeServer: Server | null = null,
  bridgeToken = randomBytes(32).toString('hex');
type PendingConfirmation = { id: string; fingerprint: string; instanceId: string; summary: string; expiresAt: number; approved: boolean };
const pendingConfirmations = new Map<string, PendingConfirmation>();
type StoredSettings = PublicSettings & {
  instances: OdooInstance[];
  activity: ActivityEvent[];
};
const permissionDefaults = (): InstancePermissions => ({
  connectivity: false, containerFilesystemRead: false, containerFilesystemWrite: false,
  containerTerminal: false, postgresRead: false, postgresWrite: false,
  odooShell: false, runTests: false, containerInspect: false, containerLogs: false,
  containerLifecycle: false, odooDiagnostics: false, odooConfigRead: false,
  workspaceRead: false, workspaceWrite: false, workspaceExecute: false,
});
const defaultPaths = (): RuntimePaths => ({
  profileDirectory: path.join(app.getPath('userData'), 'runtime-profiles'),
  sshConfigPath: path.join(app.getPath('home'), '.ssh/config'),
  stagingSshAlias: 'mcit',
});
const defaults = (): StoredSettings => ({
  schemaVersion: SETTINGS_VERSION,
  activeProfileId: null,
  activeInstanceId: null,
  profiles: [],
  paths: defaultPaths(),
  general: { logRetentionDays: 30 },
  credentialStatus: {},
  instances: [],
  activity: [],
});
let settings: StoredSettings;
function emptyStatus(): TunnelStatusSnapshot {
  return {
    state: 'stopped',
    error: null,
    profileId: null,
    process: 'stopped',
    healthEndpoint: 'unknown',
    controlPlane: 'unknown',
    mcpChild: 'unknown',
    mcpInitialization: 'unknown',
    toolDiscovery: { state: 'unknown', tools: [] },
    connector: 'unverified',
  };
}
function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}
function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}
function logPath(): string {
  return path.join(logDir(), 'tunnel-client.log');
}
function ensurePrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows */
  }
}
function redacted(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|token|secret|authorization)\s*[:=]\s*['"]?)[^'",\s}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
}
function databaseCredentialRef(instanceId: string): string { return `buddy-postgres-${instanceId}`; }
async function keyringLookup(ref: string): Promise<string> {
  if (!existsSync('/usr/bin/secret-tool')) throw new Error('GNOME Keyring support is unavailable.');
  const { stdout } = await execFileAsync('/usr/bin/secret-tool', ['lookup', 'application', keyringApp, 'credential', ref], { timeout: 5000, maxBuffer: 4096 });
  const value = stdout.trim(); if (!value) throw new Error('Database credential is unavailable.'); return value;
}
function rotate(): void {
  const file = logPath();
  ensurePrivate(logDir());
  if (!existsSync(file) || statSync(file).size < LOG_MAX_BYTES) return;
  const oldest = `${file}.${LOG_BACKUP_COUNT}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = LOG_BACKUP_COUNT - 1; i >= 1; i -= 1)
    if (existsSync(`${file}.${i}`))
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  renameSync(file, `${file}.1`);
}
function writeLog(source: string, message: string): void {
  try {
    for (const line of message.split(/\r?\n/).filter(Boolean)) {
      rotate();
      appendFileSync(
        logPath(),
        `${new Date().toISOString()} [${source}] ${redacted(runtimeKey ? line.split(runtimeKey).join('[REDACTED]') : line)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    }
  } catch {
    /* logging must not crash Buddy */
  }
}
function audit(
  category: string,
  action: string,
  result: ActivityEvent['result'],
  summary: string,
  extra: Partial<ActivityEvent> = {},
): void {
  settings.activity.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    category,
    action,
    result,
    summary: redacted(summary),
    ...extra,
  });
  settings.activity = settings.activity.slice(0, 1000);
  saveStore();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}
function cleanText(value: unknown, max = 300): string | null {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= max &&
    !/[\0\r\n]/.test(value)
    ? value.trim()
    : null;
}
function bundledTunnelPath(): string {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  return path.join(base, 'tunnel-client', `${platform}-${arch}`, platform === 'win' ? 'tunnel-client.exe' : 'tunnel-client');
}
function bundledMcpServerPath(): string {
  // Vite emits this Buddy-owned stdio server alongside main.cjs in development.
  // Packaging can copy the same artifact as an external resource without any POC.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'buddy-mcp', 'mcp-server.cjs')
    : path.join(__dirname, 'mcp-server.cjs');
}
function isDockerized(nature: DeploymentNature): boolean {
  return nature === 'on_premise_dockerized' || nature === 'vps_dockerized';
}
function migrateInstance(raw: unknown): OdooInstance | null {
  if (!isRecord(raw) || !validId(raw.id) || !cleanText(raw.name, 80)) return null;
  const legacy = raw as Record<string, unknown>;
  const environment: EnvironmentType = ['development', 'staging', 'production'].includes(String(legacy.environment)) ? legacy.environment as EnvironmentType : 'staging';
  const deploymentNature: DeploymentNature = ['odoo_sh', 'on_premise', 'on_premise_dockerized', 'vps', 'vps_dockerized'].includes(String(legacy.deploymentNature)) ? legacy.deploymentNature as DeploymentNature : 'on_premise';
  const oldPermissions = isRecord(legacy.permissions) ? legacy.permissions : {};
  const permissions = permissionDefaults();
  (Object.keys(permissions) as InstancePermission[]).forEach((key) => { permissions[key] = oldPermissions[key] === true; });
  // The old global connectivity toggle is the only capability with an exact safe mapping.
  if (!isRecord(legacy.permissions) && legacy.enabled !== false) permissions.connectivity = false;
  const sshRaw = isRecord(legacy.ssh) ? legacy.ssh : {};
  return {
    id: legacy.id as string, name: cleanText(legacy.name, 80)!, description: typeof legacy.description === 'string' ? legacy.description.slice(0, 500) : '', notes: typeof legacy.notes === 'string' ? legacy.notes.slice(0, 2000) : '', enabled: legacy.enabled !== false,
    deploymentNature, environment, odooVersion: Number.isInteger(legacy.odooVersion) && Number(legacy.odooVersion) > 0 ? Number(legacy.odooVersion) : 18,
    edition: legacy.edition === 'ee' ? 'ee' : 'ce',
    docker: { odooContainer: isRecord(legacy.docker) && typeof legacy.docker.odooContainer === 'string' ? legacy.docker.odooContainer.slice(0, 120) : '', postgresContainer: isRecord(legacy.docker) && typeof legacy.docker.postgresContainer === 'string' ? legacy.docker.postgresContainer.slice(0, 120) : '' },
    database: { name: isRecord(legacy.database) && typeof legacy.database.name === 'string' ? legacy.database.name.slice(0, 63) : 'postgres', user: isRecord(legacy.database) && typeof legacy.database.user === 'string' ? legacy.database.user.slice(0, 63) : 'postgres', connectionMode: isRecord(legacy.database) && ['docker', 'ssh_local', 'external'].includes(String(legacy.database.connectionMode)) ? legacy.database.connectionMode as 'docker' | 'ssh_local' | 'external' : isDockerized(deploymentNature) ? 'docker' : 'ssh_local', host: isRecord(legacy.database) && typeof legacy.database.host === 'string' ? legacy.database.host.slice(0, 253) : '', port: isRecord(legacy.database) && Number.isInteger(legacy.database.port) ? Number(legacy.database.port) : 5432, sslMode: isRecord(legacy.database) && ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(String(legacy.database.sslMode)) ? legacy.database.sslMode as OdooInstance['database']['sslMode'] : 'prefer', sslRootCertPath: isRecord(legacy.database) && typeof legacy.database.sslRootCertPath === 'string' ? legacy.database.sslRootCertPath.slice(0, 300) : '', connectTimeoutMs: isRecord(legacy.database) && Number.isInteger(legacy.database.connectTimeoutMs) ? Number(legacy.database.connectTimeoutMs) : 8000, authMethod: isRecord(legacy.database) && (legacy.database.authMethod === 'password' || typeof legacy.database.credentialRef === 'string') ? 'password' : 'peer', credentialRef: isRecord(legacy.database) && typeof legacy.database.credentialRef === 'string' && validId(legacy.database.credentialRef) ? legacy.database.credentialRef : null },
    ssh: { enabled: sshRaw.enabled === true || (!isRecord(legacy.ssh) && legacy.connectionMethod === 'ssh'), alias: typeof sshRaw.alias === 'string' ? sshRaw.alias.slice(0, 120) : typeof legacy.target === 'string' && legacy.connectionMethod === 'ssh' ? legacy.target.slice(0, 120) : '' },
    filesystem: { projectRoot: isRecord(legacy.filesystem) && typeof legacy.filesystem.projectRoot === 'string' ? legacy.filesystem.projectRoot.slice(0, 300) : '', addonRoots: isRecord(legacy.filesystem) && Array.isArray(legacy.filesystem.addonRoots) ? legacy.filesystem.addonRoots.filter((v): v is string => typeof v === 'string').slice(0, 12).map((v) => v.slice(0, 300)) : [], additionalRoots: isRecord(legacy.filesystem) && Array.isArray(legacy.filesystem.additionalRoots) ? legacy.filesystem.additionalRoots.filter((v): v is string => typeof v === 'string').slice(0, 12).map((v) => v.slice(0, 300)) : [] },
    developmentWorkspace: { repositoryPath: isRecord(legacy.developmentWorkspace) && typeof legacy.developmentWorkspace.repositoryPath === 'string' ? legacy.developmentWorkspace.repositoryPath.slice(0, 1000) : '', deployment: isRecord(legacy.developmentWorkspace) && isRecord(legacy.developmentWorkspace.deployment) ? { state: ['awaiting_deployment', 'deployment_reported_complete', 'deployment_verified'].includes(String(legacy.developmentWorkspace.deployment.state)) ? legacy.developmentWorkspace.deployment.state as OdooInstance['developmentWorkspace']['deployment']['state'] : 'not_started', files: Array.isArray(legacy.developmentWorkspace.deployment.files) ? legacy.developmentWorkspace.deployment.files.filter(isRecord).slice(0, 100).map((f) => ({ action: ['write', 'mkdir', 'rename', 'delete'].includes(String(f.action)) ? f.action as 'write' | 'mkdir' | 'rename' | 'delete' : 'write', path: typeof f.path === 'string' ? f.path.slice(0, 500) : '', ...(typeof f.destinationPath === 'string' ? { destinationPath: f.destinationPath.slice(0, 500) } : {}) })) : [], summary: typeof legacy.developmentWorkspace.deployment.summary === 'string' ? legacy.developmentWorkspace.deployment.summary.slice(0, 1000) : '', verification: typeof legacy.developmentWorkspace.deployment.verification === 'string' ? legacy.developmentWorkspace.deployment.verification.slice(0, 1000) : '', updatedAt: typeof legacy.developmentWorkspace.deployment.updatedAt === 'string' ? legacy.developmentWorkspace.deployment.updatedAt : null } : { state: 'not_started', files: [], summary: '', verification: '', updatedAt: null } },
    permissions, lastDiagnostic: legacy.lastDiagnostic === 'success' || legacy.lastDiagnostic === 'failed' ? legacy.lastDiagnostic : 'not_checked', lastConnectedAt: typeof legacy.lastConnectedAt === 'string' ? legacy.lastConnectedAt : null,
  };
}
function loadStore(): StoredSettings {
  const file = settingsPath();
  if (!existsSync(file)) return defaults();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || ![1, 2, SETTINGS_VERSION].includes(parsed.schemaVersion as number))
      throw new Error('unsupported settings format');
    const base = defaults();
    return {
      ...base,
      ...parsed,
      paths: { ...base.paths, ...(isRecord(parsed.paths) ? parsed.paths : {}) },
      general: {
        ...base.general,
        ...(isRecord(parsed.general) ? parsed.general : {}),
      },
      credentialStatus: isRecord(parsed.credentialStatus)
        ? Object.fromEntries(
            Object.entries(parsed.credentialStatus).map(([k, v]) => [
              k,
              v === true,
            ]),
          )
        : {},
      profiles: Array.isArray(parsed.profiles)
        ? (parsed.profiles as TunnelProfile[])
        : [],
      schemaVersion: SETTINGS_VERSION,
      instances: Array.isArray(parsed.instances) ? parsed.instances.map(migrateInstance).filter((value): value is OdooInstance => !!value) : [],
      activity: Array.isArray(parsed.activity)
        ? (parsed.activity as ActivityEvent[])
        : [],
    };
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, backup);
    } catch {
      /* best effort */
    }
    dialog.showErrorBox(
      'Buddy settings recovered',
      'Your settings file could not be read. Buddy preserved it as a .corrupt file and started with safe defaults.',
    );
    return defaults();
  }
}
function saveStore(): void {
  ensurePrivate(app.getPath('userData'));
  const file = settingsPath(),
    temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}
function publicSettings(): PublicSettings {
  const { instances: _i, activity: _a, ...value } = settings;
  return value;
}
function ok<T>(data: T): OperationResult<T> {
  return { ok: true, data };
}
function fail<T = undefined>(
  code: string,
  message: string,
): OperationResult<T> {
  return { ok: false, error: { code, message, recoverable: true } };
}
function validateProfile(input: unknown): OperationResult<TunnelProfile> {
  if (!isRecord(input))
    return fail('invalid_profile', 'Profile data is invalid.');
  const id = validId(input.id) ? input.id : crypto.randomUUID(),
    name = cleanText(input.name, 80),
    tunnelId = cleanText(input.tunnelId, 64),
    controlPlaneBaseUrl = cleanText(input.controlPlaneBaseUrl, 240),
    healthBaseUrl = cleanText(input.healthBaseUrl, 240);
  if (
    !name ||
    !tunnelId ||
    !/^tunnel_[a-f0-9]{32}$/.test(tunnelId) ||
    !controlPlaneBaseUrl ||
    !healthBaseUrl
  )
    return fail(
      'invalid_profile',
      'Enter a name, a valid tunnel ID, and valid control-plane and health URLs.',
    );
  try {
    const cp = new URL(controlPlaneBaseUrl),
      hp = new URL(healthBaseUrl);
    if (!/^https?:$/.test(cp.protocol) || !/^https?:$/.test(hp.protocol))
      throw new Error();
  } catch {
    return fail(
      'invalid_url',
      'Use HTTP or HTTPS URLs for control-plane and health addresses.',
    );
  }
  return ok({
    id,
    name,
    tunnelId,
    credentialRef: `buddy-profile-${id}`,
    controlPlaneBaseUrl,
    healthBaseUrl,
    enabled: input.enabled !== false,
  });
}
function yamlScalar(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new Error(
      'A runtime value contains an unsupported control character.',
    );
  return JSON.stringify(value);
}
function activeProfile(): TunnelProfile | null {
  return (
    settings.profiles.find(
      (p) => p.id === settings.activeProfileId && p.enabled,
    ) ?? null
  );
}
function writeRuntimeProfile(profile: TunnelProfile): string {
  const p = settings.paths,
    dir = p.profileDirectory;
  ensurePrivate(dir);
  const file = path.join(dir, `${profile.id}.yaml`);
  const healthUrl = new URL(profile.healthBaseUrl);
  const bridgeCommand = `env BUDDY_BRIDGE_SOCKET=${JSON.stringify(bridgeSocketPath())} BUDDY_BRIDGE_TOKEN=${bridgeToken} node ${JSON.stringify(bundledMcpServerPath())}`;
  const content = `config_version: 1\ncontrol_plane:\n  base_url: ${yamlScalar(profile.controlPlaneBaseUrl)}\n  tunnel_id: ${yamlScalar(profile.tunnelId)}\n  api_key: env:CONTROL_PLANE_API_KEY\nhealth:\n  listen_addr: ${yamlScalar(healthUrl.host)}\nadmin_ui:\n  open_browser: false\nlog:\n  level: info\n  format: json\nmcp:\n  commands:\n    - channel: main\n      command: ${yamlScalar(bridgeCommand)}\n`;
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
  return file;
}
async function credential(profile: TunnelProfile): Promise<string> {
  if (!existsSync('/usr/bin/secret-tool'))
    throw new Error(
      'GNOME Keyring support is unavailable: install libsecret-tools and unlock your keyring.',
    );
  const { stdout } = await execFileAsync(
    '/usr/bin/secret-tool',
    ['lookup', 'application', keyringApp, 'profile', profile.id],
    { timeout: 5000, maxBuffer: 4096 },
  );
  const secret = stdout.trim();
  if (!secret)
    throw new Error(
      'No API key is saved for this profile. Replace the key in Settings before starting.',
    );
  return secret;
}
function attachOutput(
  process: ChildProcess,
  stream: 'stdout' | 'stderr',
): void {
  const output = process[stream];
  if (!output) return;
  output.setEncoding('utf8');
  output.on('data', (data: string) => writeLog(stream, data));
}
function snapshot(): TunnelStatusSnapshot {
  return {
    ...health,
    state,
    error: errorMessage,
    profileId: runningProfileId ?? settings.activeProfileId,
  };
}
function setState(
  next: TunnelStatusSnapshot['state'],
  message: string | null = null,
): void {
  state = next;
  errorMessage = message;
  health.state = next;
  health.error = message;
  health.process =
    next === 'running'
      ? 'running'
      : next === 'starting'
        ? 'starting'
        : next === 'error'
          ? 'failed'
          : 'stopped';
}
async function refreshHealth(profile: TunnelProfile): Promise<boolean> {
  try {
    const response = await fetch(
      `${profile.healthBaseUrl.replace(/\/$/, '')}/health?details=true`,
      { signal: AbortSignal.timeout(1800) },
    );
    health.healthEndpoint = response.ok ? 'reachable' : 'unreachable';
    if (!response.ok) return false;
    const body = (await response.json()) as {
      live?: boolean;
      components?: {
        'control-plane'?: {
          status?: string;
          details?: { last_success?: string | null };
        };
        mcp?: { status?: string; state?: string; tools?: string[] };
      };
    };
    const control = body.components?.['control-plane'];
    let mcp = body.components?.mcp;
    try {
      const mcpResponse = await fetch(
        `${profile.healthBaseUrl.replace(/\/$/, '')}/health/mcp`,
        { signal: AbortSignal.timeout(1800) },
      );
      if (mcpResponse.ok) {
        mcp = (await mcpResponse.json()) as {
          status?: string;
          state?: string;
          tools?: string[];
        };
      }
    } catch {
      // /health/mcp is observational and must not make a healthy tunnel fail.
    }
    health.controlPlane =
      control?.status === 'ok' && !!control.details?.last_success
        ? 'successful'
        : control?.status === 'failed'
          ? 'failed'
          : 'unknown';
    health.mcpChild =
      mcp?.status === 'running'
        ? 'running'
        : mcp?.status === 'exited'
          ? 'exited'
          : 'unknown';
    health.mcpInitialization =
      mcp?.state === 'initialized'
        ? 'confirmed'
        : mcp?.state === 'failed'
          ? 'failed'
          : 'not_observed';
    health.toolDiscovery = {
      state: Array.isArray(mcp?.tools)
        ? 'confirmed'
        : mcp?.state === 'failed'
          ? 'failed'
          : 'not_observed',
      tools: Array.isArray(mcp?.tools) ? mcp.tools.slice(0, 30) : [],
    };
    return body.live === true && health.controlPlane === 'successful';
  } catch {
    health.healthEndpoint = 'unreachable';
    health.controlPlane = 'unknown';
    return false;
  }
}
async function validateRuntime(): Promise<
  OperationResult<{ issues: string[]; diagnostic: TunnelRuntimeDiagnostic }>
> {
  const issues: string[] = [], p = settings.paths, clientPath = bundledTunnelPath();
  let executable = false;
  try { executable = existsSync(clientPath) && statSync(clientPath).isFile() && (process.platform === 'win32' || (statSync(clientPath).mode & 0o111) !== 0); } catch { executable = false; }
  const diagnostic: TunnelRuntimeDiagnostic = { available: existsSync(clientPath), path: clientPath, version: null, platform: process.platform, architecture: process.arch, executable, issue: null };
  if (!diagnostic.available) diagnostic.issue = `Bundled tunnel-client is missing for ${process.platform}/${process.arch}. Install an official verified client in the application resources before running Buddy.`;
  else if (!executable) diagnostic.issue = 'Bundled tunnel-client is not executable.';
  else try {
    const { stdout } = await execFileAsync(clientPath, ['--version'], { timeout: 3000, maxBuffer: 4096 });
    diagnostic.version = stdout.trim().slice(0, 200) || null;
    if (!diagnostic.version) diagnostic.issue = 'Bundled tunnel-client did not report a version.';
  } catch {
    diagnostic.issue = 'Bundled tunnel-client could not be executed. Verify its platform and architecture.';
  }
  if (!activeProfile()) issues.push('Select an enabled tunnel profile.');
  if (diagnostic.issue) issues.push(diagnostic.issue);
  if (!existsSync(bundledMcpServerPath()))
    issues.push('Buddy MCP server was not built. Restart the development application after the MCP entry is compiled.');
  if (!p.profileDirectory)
    issues.push('Runtime profile directory is required.');
  return ok({ issues, diagnostic });
}
async function stopChild(): Promise<void> {
  if (stopTask) return stopTask;
  const owned = child;
  if (!owned) {
    if (state !== 'error') setState('stopped');
    return;
  }
  setState('stopping');
  stopTask = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child === owned) child = null;
      setState('stopped');
      resolve();
    };
    const timer = setTimeout(() => {
      if (child === owned) owned.kill('SIGKILL');
    }, 5000);
    owned.once('close', finish);
    if (owned.exitCode !== null) finish();
    else owned.kill('SIGTERM');
  }).finally(() => {
    stopTask = null;
  });
  return stopTask;
}
async function startTunnel(): Promise<TunnelStatusSnapshot> {
  if (state === 'running' && child) return snapshot();
  if (startTask) return startTask;
  if (stopTask) await stopTask;
  stopRequested = false;
  const operation = (async () => {
    const profile = activeProfile(),
      validated = await validateRuntime();
    if (!profile || !validated.ok || validated.data.issues.length) {
      const message = validated.ok
        ? validated.data.issues.join(' ')
        : validated.error.message;
      setState('error', message);
      audit('lifecycle', 'tunnel.start', 'failure', message);
      return snapshot();
    }
    try {
      setState('starting');
      runningProfileId = profile.id;
      runtimeKey = await credential(profile);
      const profileFile = writeRuntimeProfile(profile);
      if (stopRequested) {
        setState('stopped');
        return snapshot();
      }
      const spawned = spawn(
        bundledTunnelPath(),
        ['run', '--profile-file', profileFile],
        {
          env: {
            ...process.env,
            CONTROL_PLANE_API_KEY: runtimeKey,
            PATH: `${path.dirname(bundledTunnelPath())}${path.delimiter}${process.env.PATH ?? ''}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        },
      );
      child = spawned;
      attachOutput(spawned, 'stdout');
      attachOutput(spawned, 'stderr');
      spawned.once('error', () => {
        writeLog('buddy', 'Tunnel client could not be started.');
        if (child === spawned) {
          child = null;
          setState(
            'error',
            'Tunnel client could not be started. Check the local log.',
          );
        }
      });
      spawned.once('close', (code: number | null) => {
        writeLog('buddy', `Tunnel client exited (code=${String(code)}).`);
        if (child === spawned) {
          child = null;
          if (state !== 'stopping' && !stopRequested)
            setState(
              code === 0 ? 'stopped' : 'error',
              code === 0
                ? null
                : 'Tunnel client exited unexpectedly. Check the local log.',
            );
        }
      });
      await new Promise<void>((resolve, reject) => {
        spawned.once('spawn', resolve);
        spawned.once('error', reject);
      });
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (
        !stopRequested &&
        Date.now() < deadline &&
        spawned.exitCode === null
      ) {
        if (await refreshHealth(profile)) {
          setState('running');
          audit(
            'lifecycle',
            'tunnel.start',
            'success',
            'Tunnel health and control-plane checks passed.',
            { profileId: profile.id },
          );
          return snapshot();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
      }
      if (stopRequested) {
        await stopChild();
        return snapshot();
      }
      throw new Error('Tunnel health or control-plane readiness timed out.');
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Tunnel startup failed.';
      if (child) await stopChild();
      setState('error', message);
      audit('lifecycle', 'tunnel.start', 'failure', message, {
        profileId: profile?.id,
      });
      return snapshot();
    } finally {
      runtimeKey = null;
    }
  })();
  startTask = operation;
  try {
    return await operation;
  } finally {
    if (startTask === operation) startTask = null;
  }
}
async function stopTunnel(): Promise<TunnelStatusSnapshot> {
  stopRequested = true;
  await stopChild();
  if (startTask) await startTask;
  audit('lifecycle', 'tunnel.stop', 'success', 'Tunnel client stopped.', {
    profileId: runningProfileId ?? undefined,
  });
  runningProfileId = null;
  return snapshot();
}
function assertInstancePermission(instanceId: unknown, permission: InstancePermission): OperationResult<OdooInstance> {
  if (!validId(instanceId)) return fail('invalid_id', 'Instance ID is invalid.');
  const instance = settings.instances.find((item) => item.id === instanceId);
  if (!instance) return fail('not_found', 'Instance was not found.');
  if (!instance.enabled) return fail('instance_inactive', 'This instance is inactive. Activate it before running an operation.');
  if (!instance.permissions[permission]) return fail('permission_denied', `This instance does not permit ${permission}. Update its Permissions section.`);
  return ok(instance);
}
function bridgeSocketPath(): string {
  return path.join(app.getPath('userData'), 'buddy-bridge.sock');
}
function validContainerName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}
function dockerContainer(instance: OdooInstance, role: unknown): OperationResult<string> {
  if (!isDockerized(instance.deploymentNature)) return fail('unsupported_deployment', 'This operation requires an On-premise Dockerized or VPS Dockerized instance.');
  const name = role === 'postgres' ? instance.docker.postgresContainer : role === 'odoo' ? instance.docker.odooContainer : '';
  if (!name || !validContainerName(name)) return fail('invalid_container', 'The configured container name is missing or invalid. Update this instance configuration.');
  return ok(name);
}
async function runRemote(instance: OdooInstance, args: string[], timeout = 15_000): Promise<OperationResult<{ stdout: string; stderr: string; code: number }>> {
  const remote = await runRemoteTerminal(instance, args, timeout);
  if (!remote.ok) return remote;
  if (remote.data.timedOut) return fail('remote_operation_timed_out', 'The remote operation timed out.');
  if (remote.data.exitCode !== 0) return fail('remote_operation_failed', (remote.data.stderr || remote.data.stdout || 'The remote operation failed.').slice(0, 1000));
  return ok({ stdout: remote.data.stdout, stderr: remote.data.stderr, code: 0 });
}
function safeContainerPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > 300 || !value.startsWith('/') || !/^[A-Za-z0-9_./-]+$/.test(value) || value.split('/').includes('..')) return null;
  const allowedRoots = ['/opt/odoo', '/mnt/extra-addons', '/etc/odoo', '/var/log/odoo'];
  return allowedRoots.some((root) => value === root || value.startsWith(`${root}/`)) ? value : null;
}
function configuredFilesystemRoots(instance: OdooInstance): OperationResult<string[]> {
  const roots = [instance.filesystem.projectRoot, ...instance.filesystem.addonRoots, ...instance.filesystem.additionalRoots].filter(Boolean);
  if (!roots.length) return fail('filesystem_roots_unconfigured', 'Configure a project root before using SSH filesystem operations.');
  if (instance.deploymentNature === 'odoo_sh' && (instance.filesystem.additionalRoots.length > 0 || !instance.filesystem.projectRoot)) return fail('filesystem_roots_unconfigured', 'Odoo.sh filesystem access is limited to its configured project root and addon roots.');
  if (roots.some((root) => !/^\/[A-Za-z0-9_./-]{1,299}$/.test(root) || root.split('/').includes('..') || root === '/')) return fail('invalid_filesystem_root', 'Filesystem roots must be configured absolute project paths without traversal.');
  return ok([...new Set(roots)]);
}
function safeRemoteFilesystemPath(value: unknown): string | null {
  return typeof value === 'string' && value.length > 1 && value.length <= 300 && /^\/[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').includes('..') ? value : null;
}
async function remoteFilesystemRoots(instance: OdooInstance): Promise<OperationResult<string[]>> {
  const configured = configuredFilesystemRoots(instance); if (!configured.ok) return configured;
  const canonical: string[] = [];
  for (const root of configured.data) { const found = await runRemote(instance, ['realpath', '--', root]); if (!found.ok) return fail('filesystem_root_unavailable', `Configured filesystem root is unavailable: ${root}`); const resolved = found.data.stdout.trim(); if (!safeRemoteFilesystemPath(resolved)) return fail('filesystem_root_invalid', 'A configured filesystem root resolved to an unsafe path.'); canonical.push(resolved); }
  const unique = [...new Set(canonical)];
  // Odoo.sh accounts expose a project workspace, not a general-purpose host.
  // Addon roots there must be inside the saved project root after *remote*
  // canonicalization, which also rejects a symlink into another project.
  if (instance.deploymentNature === 'odoo_sh' && unique.some((root) => root !== unique[0] && !root.startsWith(`${unique[0]}/`))) return fail('filesystem_root_invalid', 'Odoo.sh addon roots must resolve inside the configured project workspace.');
  return ok(unique);
}
async function executeRemoteFilesystem(instance: OdooInstance, operation: string, input: Record<string, unknown>): Promise<OperationResult<unknown>> {
  if (input.role !== 'odoo') return fail('invalid_role', 'SSH filesystem operations are limited to the configured Odoo project.');
  const requested = safeRemoteFilesystemPath(input.path); if (!requested) return fail('invalid_path', 'Use an absolute path without traversal segments.');
  const roots = await remoteFilesystemRoots(instance); if (!roots.ok) return roots;
  const action = operation === 'container_write_file' ? String(input.action) : operation;
  const destination = action === 'rename' ? safeRemoteFilesystemPath(input.destinationPath) ?? '' : '';
  if (action === 'rename' && !destination) return fail('invalid_path', 'A valid destination path is required.');
  const content = typeof input.content === 'string' ? input.content : '';
  if (action === 'write' && (typeof input.content !== 'string' || Buffer.byteLength(content, 'utf8') > 256 * 1024)) return fail('invalid_content', 'Write content must be UTF-8 text no larger than 256 KiB.');
  if (operation === 'container_write_file') { const approval = approvedConfirmation(operation, input, instance, 'ssh-filesystem', `${action} ${requested}${destination ? ` → ${destination}` : ''} in configured project roots`); if (!approval.ok) return approval; }
  // All caller paths are positional parameters. The remote script canonicalizes
  // roots and parents before every mutation, including rename/delete.
  const script = 'set -eu; action="$1"; target="$2"; dest="$3"; payload="$4"; shift 4; inside(){ v="$1"; shift; for r in "$@"; do [ "$v" = "$r" ] || case "$v" in "$r"/*) return 0;; esac; done; return 1; }; not_root(){ v="$1"; shift; for r in "$@"; do [ "$v" != "$r" ] || return 1; done; return 0; }; existing(){ realpath -- "$1"; }; parent(){ realpath -- "$(dirname -- "$1")"; }; case "$action" in container_list_directory) target=$(existing "$target") || exit 65; inside "$target" "$@" || exit 65; find "$target" -maxdepth 1 -mindepth 1 -printf "%f\\t%y\\t%s\\n" ;; container_file_info) target=$(existing "$target") || exit 65; inside "$target" "$@" || exit 65; stat -c "%F\\t%s" -- "$target" ;; container_read_file) target=$(existing "$target") || exit 65; inside "$target" "$@" || exit 65; test -f "$target"; test $(wc -c < "$target") -le 262144; cat -- "$target" ;; mkdir) p=$(parent "$target") || exit 65; inside "$p" "$@" || exit 65; target="$p/$(basename -- "$target")"; mkdir -- "$target" ;; delete) target=$(existing "$target") || exit 65; inside "$target" "$@" && not_root "$target" "$@" || exit 65; rm -r -- "$target" ;; rename) target=$(existing "$target") || exit 65; inside "$target" "$@" && not_root "$target" "$@" || exit 65; p=$(parent "$dest") || exit 65; inside "$p" "$@" || exit 65; dest="$p/$(basename -- "$dest")"; test ! -e "$dest"; mv -- "$target" "$dest" ;; write) p=$(parent "$target") || exit 65; inside "$p" "$@" || exit 65; target="$p/$(basename -- "$target")"; if [ -e "$target" ]; then resolved=$(existing "$target") || exit 65; inside "$resolved" "$@" && not_root "$resolved" "$@" || exit 65; fi; tmp=$(mktemp "$p/.buddy-tmp-XXXXXX"); trap "rm -f -- $tmp" EXIT; printf %s "$payload" | base64 -d > "$tmp"; mv -f -- "$tmp" "$target"; trap - EXIT ;; *) exit 64;; esac';
  const payload = action === 'write' ? Buffer.from(content, 'utf8').toString('base64') : '';
  const run = await runRemote(instance, ['sh', '-c', script, 'buddy-fs', action, requested, destination, payload, ...roots.data], 20_000);
  if (!run.ok) return run;
  if (operation === 'container_list_directory') return ok({ path: requested, entries: run.data.stdout.split('\n').filter(Boolean).slice(0, 500) });
  if (operation === 'container_file_info') { const [kind, size] = run.data.stdout.trim().split('\t'); return ok({ path: requested, kind, bytes: /^\d+$/.test(size) ? Number(size) : null }); }
  if (operation === 'container_read_file') return ok({ path: requested, content: redacted(run.data.stdout), bytes: Buffer.byteLength(run.data.stdout, 'utf8') });
  return ok(action === 'write' ? { action, path: requested, bytes: Buffer.byteLength(content, 'utf8'), written: true } : action === 'rename' ? { action, path: requested, destinationPath: destination, renamed: true } : action === 'delete' ? { action, path: requested, deleted: true } : { action, path: requested, created: true });
}
function documentsWorkspaceRoot(): OperationResult<string> {
  try {
    const documents = realpathSync(path.join(app.getPath('home'), 'Documents'));
    if (!statSync(documents).isDirectory()) return fail('workspace_documents_unavailable', 'The local Documents directory is unavailable.');
    return ok(documents);
  } catch { return fail('workspace_documents_unavailable', 'Create or restore your local Documents directory before configuring a Development Workspace.'); }
}
function isWithinLocalDocuments(root: string): boolean {
  const documents = documentsWorkspaceRoot();
  return documents.ok && root !== documents.data && root.startsWith(`${documents.data}${path.sep}`);
}
function workspaceRoot(instance: OdooInstance): OperationResult<string> {
  const configured = instance.developmentWorkspace.repositoryPath;
  if (!configured) return fail('workspace_unconfigured', 'Custom source changes require a configured local Git repository inside Documents for this instance.');
  try {
    const root = realpathSync(configured);
    if (!isWithinLocalDocuments(root)) return fail('workspace_outside_documents', 'The configured Development Workspace must remain inside your local Documents directory.');
    if (!statSync(root).isDirectory() || !existsSync(path.join(root, '.git'))) return fail('workspace_invalid', 'The Development Workspace must be an accessible local Git repository.');
    return ok(root);
  } catch { return fail('workspace_unavailable', 'The configured Development Workspace is unavailable. Update the instance configuration.'); }
}
function canonicalWorkspaceConfiguration(value: unknown): OperationResult<string> {
  if (typeof value !== 'string' || !value.trim()) return ok('');
  const entered = value.trim(); const expanded = entered === '~' ? app.getPath('home') : entered.startsWith('~/') ? path.join(app.getPath('home'), entered.slice(2)) : entered;
  try {
    const root = realpathSync(expanded);
    if (!isWithinLocalDocuments(root)) return fail('workspace_outside_documents', 'Choose a Git repository located inside ~/Documents.');
    if (!statSync(root).isDirectory() || !existsSync(path.join(root, '.git'))) return fail('workspace_invalid', 'Development Workspace must be an accessible local Git repository.');
    return ok(root);
  } catch { return fail('workspace_invalid', 'Development Workspace must be an accessible local Git repository inside ~/Documents.'); }
}
function workspacePath(root: string, value: unknown, allowRoot = false): OperationResult<{ path: string; relative: string }> {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\0]/.test(value) || path.isAbsolute(value)) return fail('invalid_workspace_path', 'Workspace paths must be non-empty relative paths.');
  const relative = path.normalize(value);
  if (relative === '.' && allowRoot) return ok({ path: root, relative: '.' });
  if (relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`)) return fail('workspace_path_escape', 'Workspace paths cannot escape the configured repository.');
  if (relative.split(path.sep).some((part) => part.toLowerCase() === '.git')) return fail('workspace_git_metadata_denied', 'Buddy cannot read or modify Git metadata inside .git.');
  const target = path.resolve(root, relative);
  if ((target !== root && !target.startsWith(`${root}${path.sep}`)) || (!allowRoot && target === root)) return fail('workspace_path_escape', 'Workspace paths cannot escape the configured repository.');
  return ok({ path: target, relative });
}
function canonicalWorkspaceExisting(root: string, target: string): OperationResult<string> {
  try {
    const resolved = realpathSync(target);
    if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) return fail('workspace_path_escape', 'The path resolves outside the configured repository.');
    if (path.relative(root, resolved).split(path.sep).some((part) => part.toLowerCase() === '.git')) return fail('workspace_git_metadata_denied', 'Buddy cannot access Git metadata through symlinks.');
    return ok(resolved);
  } catch { return fail('workspace_path_unavailable', 'The requested workspace path does not exist.'); }
}
function canonicalWorkspaceParent(root: string, target: string): OperationResult<string> {
  return canonicalWorkspaceExisting(root, path.dirname(target));
}
function workspaceSensitivePath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, '/').toLowerCase();
  const name = path.posix.basename(normalized);
  return name === '.env' || name.startsWith('.env.') && !name.endsWith('.example') || name === '.npmrc' || name === '.pypirc' || name === 'credentials' || name === 'id_rsa' || name === 'id_ed25519' || /\.(pem|key|p12|pfx|keystore|kdbx)$/.test(name) || /(^|\/)(secrets?|private_keys?)(\/|$)/.test(normalized);
}
function recordWorkspaceChange(instance: OdooInstance, action: 'write' | 'mkdir' | 'rename' | 'delete', relative: string, destinationPath?: string, summary = ''): void {
  const deployment = instance.developmentWorkspace.deployment;
  deployment.state = 'awaiting_deployment'; deployment.verification = ''; deployment.updatedAt = new Date().toISOString();
  if (summary) deployment.summary = redacted(summary).slice(0, 1000);
  deployment.files.push({ action, path: relative, ...(destinationPath ? { destinationPath } : {}) });
  deployment.files = deployment.files.slice(-100);
  saveStore();
}
function sourceLikeRemoteChange(pathValue: unknown, content: unknown): boolean {
  const value = typeof pathValue === 'string' ? pathValue.toLowerCase().replace(/\\/g, '/') : '';
  const sourceExtensions = /\.(py|pyi|xml|js|mjs|cjs|ts|tsx|jsx|vue|scss|sass|less|css|csv|po|pot|qweb|html|sql|sh|bash)$/;
  const sourceDirectories = /\/(models|views|controllers|security|static|report|reports|data|wizard|tests|demo|i18n|addons|custom_addons|custom-addons|extra_addons|extra-addons)\//;
  if (sourceExtensions.test(value) || /(^|\/)__manifest__\.py$/.test(value) || /(^|\/)(manifest|makefile|dockerfile|requirements\.txt|pyproject\.toml|setup\.cfg)$/.test(value) || sourceDirectories.test(`${value.replace(/\/$/, '')}/`)) return true;
  return typeof content === 'string' && /^\s*(from\s+\w+|import\s+\w+|class\s+\w+|def\s+\w+|<odoo[ >]|<template[ >]|\/\*\*\s*@odoo-module)/m.test(content);
}
function remoteSourceWriteDenied(instance: OdooInstance, pathValue: unknown, content: unknown): boolean {
  if (sourceLikeRemoteChange(pathValue, content)) return true;
  if (typeof pathValue !== 'string' || !pathValue.startsWith('/')) return false;
  const candidate = path.posix.normalize(pathValue);
  const configuredRoots = instance.filesystem.addonRoots.filter(Boolean);
  if (!isDockerized(instance.deploymentNature) && instance.filesystem.projectRoot) {
    const project = path.posix.normalize(instance.filesystem.projectRoot);
    configuredRoots.push(...['addons', 'custom_addons', 'custom-addons', 'extra_addons', 'extra-addons', 'odoo/addons'].map((part) => path.posix.join(project, part)));
  }
  if (isDockerized(instance.deploymentNature)) configuredRoots.push('/mnt/extra-addons', '/opt/odoo', '/opt/odoo/addons', '/opt/odoo/custom_addons', '/opt/odoo/custom-addons');
  return configuredRoots.some((root) => {
    const normalized = path.posix.normalize(root);
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}
function remoteDeploymentCommandDenied(commandLine: string): boolean {
  const command = commandLine.toLowerCase();
  return /\bgit\s+(?:add|commit|tag|branch|push|pull|fetch|clone|checkout|switch|merge|rebase|reset|cherry-pick|apply|stash|clean|worktree)\b/.test(command)
    || /\b(?:odoo|odoo-bin)\b[^;&|]*(?:\s-u\s|--update(?:=|\s)|--stop-after-init)/.test(command)
    || /\b(?:systemctl|service)\s+(?:start|stop|restart|reload)\b/.test(command)
    || /\bsupervisorctl\s+(?:start|stop|restart|reread|update)\b/.test(command)
    || /\bdocker\s+(?:start|stop|restart|rm|compose\s+(?:up|restart|down))\b/.test(command)
    || /\bdocker-compose\s+(?:up|restart|down)\b/.test(command)
    || /\bkubectl\s+(?:apply|delete|rollout|set\s+image)\b/.test(command)
    || /\bhelm\s+upgrade\b/.test(command)
    || /\b(?:make|npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|release|publish)\b/.test(command)
    || /\b(?:scp|rsync|ansible-playbook|fab)\b/.test(command)
    || /\bcurl\b[^;&|]*(?:\s-o\s|--output(?:=|\s))/.test(command)
    || /\bwget\b[^;&|]*(?:\s-O\s|--output-document(?:=|\s))/.test(command)
    || /(?:^|[\s/])(?:deploy|release|publish)(?:[-_.][a-z0-9_-]+)?\.sh(?:$|[\s;&|])/.test(command);
}
function remoteTerminalSourceWriteDenied(instance: OdooInstance, commandLine: string, workingDirectory: string): boolean {
  const command = commandLine.toLowerCase();
  const mutation = /(?:\b(?:tee|sed\s+-i|perl\s+-i|cp|mv|rm|touch|truncate|install|dd|vim|vi|nano|emacs)\b|(?:>|>>|1>|2>|\|\s*tee)\s*|\b(?:python|python3|node|ruby|perl|php)\s+-(?:c|e)\b|\b(?:tar\s+[^;&|]*--?x|unzip\s|7z\s+x\b))/i.test(command);
  if (!mutation) return false;
  if (remoteSourceWriteDenied(instance, workingDirectory, undefined)) return true;
  const absolutePaths = commandLine.match(/\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+/g) ?? [];
  return absolutePaths.some((candidate) => remoteSourceWriteDenied(instance, candidate, undefined));
}
async function runLocalWorkspaceCommand(root: string, command: string, args: string[], timeoutMs: number): Promise<OperationResult<TerminalExecution>> {
  return new Promise((resolve) => {
    const startedAt = Date.now(); let stdout = ''; let stderr = ''; let timedOut = false; let truncated = false;
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: app.getPath('temp'), LANG: process.env.LANG ?? 'C.UTF-8', LC_ALL: process.env.LC_ALL ?? 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' } });
    const append = (current: string, chunk: Buffer, max: number): string => { const value = chunk.toString(); if (current.length >= max) { truncated = true; return current; } if (current.length + value.length > max) { truncated = true; return current + value.slice(0, max - current.length); } return current + value; };
    const timer = setTimeout(() => { timedOut = true; if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk, 64 * 1024); }); child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk, 16 * 1024); });
    child.once('error', () => { clearTimeout(timer); resolve(fail('workspace_command_failed', 'Could not start the approved local development command.')); });
    child.once('close', (code) => { clearTimeout(timer); resolve(ok({ stdout: redacted(stdout), stderr: redacted(stderr), exitCode: code, timedOut, truncated, durationMs: Date.now() - startedAt })); });
  });
}
async function executeWorkspace(instance: OdooInstance, operation: string, input: Record<string, unknown>): Promise<OperationResult<unknown>> {
  const rootResult = workspaceRoot(instance); if (!rootResult.ok) return rootResult; const root = rootResult.data;
  if (operation === 'workspace_deployment_status') return ok({ instanceId: instance.id, instance: instance.name, workspace: root, ...instance.developmentWorkspace.deployment });
  if (operation === 'workspace_report_deployed') {
    if (instance.developmentWorkspace.deployment.state !== 'awaiting_deployment') return fail('deployment_not_awaiting', 'There are no local workspace changes awaiting deployment confirmation.');
    instance.developmentWorkspace.deployment.state = 'deployment_reported_complete'; instance.developmentWorkspace.deployment.updatedAt = new Date().toISOString(); saveStore(); audit('workspace', operation, 'success', 'User reported local workspace changes deployed.', { instanceId: instance.id }); return ok({ state: 'deployment_reported_complete' });
  }
  if (operation === 'workspace_verify_deployment') {
    if (instance.developmentWorkspace.deployment.state !== 'deployment_reported_complete') return fail('deployment_confirmation_required', 'The user must report deployment complete before Buddy can verify it remotely.');
    const module = typeof input.module === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.module) ? input.module : ''; if (!module) return fail('invalid_module', 'Provide the deployed module technical name for verification.');
    const permitted = assertInstancePermission(instance.id, 'odooShell'); if (!permitted.ok) return permitted;
    const odoo = isDockerized(instance.deploymentNature) ? dockerContainer(instance, 'odoo') : ok('ssh-host'); if (!odoo.ok) return odoo;
    const code = `m=env['ir.module.module'].search([('name','=','${module}')],limit=1); print(m.state if m else 'missing')`;
    const executable = 'odoo_exec=$(command -v odoo || command -v odoo-bin || true); test -n "$odoo_exec" || { echo "Odoo executable not found" >&2; exit 127; }; ';
    const run = await runOdoo(instance, odoo.data, `${executable} code=$(printf %s "$1" | base64 -d); printf '%s\\n' "$code" | "$odoo_exec" shell -d "$2" --no-http`, [Buffer.from(code).toString('base64'), instance.database.name], 60_000);
    if (!run.ok || run.data.exitCode !== 0 || !/^installed\s*$/m.test(run.data.stdout)) { const verification = run.ok ? `Module ${module} did not verify as installed: ${redacted(run.data.stdout || run.data.stderr).slice(0, 500)}` : 'Remote verification could not run.'; instance.developmentWorkspace.deployment.verification = verification; instance.developmentWorkspace.deployment.updatedAt = new Date().toISOString(); saveStore(); audit('workspace', operation, 'failure', verification, { instanceId: instance.id }); return fail('deployment_verification_failed', verification); }
    instance.developmentWorkspace.deployment.state = 'deployment_verified'; instance.developmentWorkspace.deployment.verification = `Module ${module} is installed in the configured database after user-reported deployment. This is a deployment sanity check, not an exact comparison against the local Git revision.`; instance.developmentWorkspace.deployment.updatedAt = new Date().toISOString(); saveStore(); audit('workspace', operation, 'success', instance.developmentWorkspace.deployment.verification, { instanceId: instance.id }); return ok({ state: 'deployment_verified', module, verificationScope: 'module_installed_in_configured_database', output: run.data.stdout });
  }
  if (operation === 'workspace_execute') {
    const command = typeof input.command === 'string' ? input.command : ''; const args = Array.isArray(input.args) && input.args.length <= 40 && input.args.every((v) => typeof v === 'string' && v.length <= 500 && !/[\0\r\n]/.test(v)) ? input.args as string[] : null;
    const gitReadOnly = !!args && command === 'git' && ['diff', 'status', 'show', 'log'].includes(args[0] ?? '') && !args.some((arg) => /^(?:--output(?:=|$)|--ext-diff(?:=|$)|--textconv(?:=|$)|-c(?:=|$)|--config-env(?:=|$))/.test(arg));
    const packageCheck = !!args && ['npm', 'pnpm', 'yarn'].includes(command) && ((args.length === 2 && args[0] === 'run' && ['typecheck', 'lint', 'test'].includes(args[1])) || (args.length === 1 && args[0] === 'test'));
    const pytestCheck = !!args && command === 'pytest' && args.length <= 20 && args.every((arg) => !/^(?:-p|--plugin|--import-mode|--override-ini)/.test(arg));
    if (!args || !(gitReadOnly || packageCheck || pytestCheck)) return fail('workspace_command_denied', 'Only read-only Git inspection, the repository typecheck/lint/test scripts, and bounded pytest runs are allowed. Git commits, network operations, deployment commands, and arbitrary interpreters are blocked.');
    const approval = approvedConfirmation(operation, input, instance, root, `Local development command in ${instance.name}: ${command}`); if (!approval.ok) return approval;
    const timeoutMs = input.timeoutMs === undefined ? 30_000 : Number(input.timeoutMs); if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) return fail('invalid_timeout', 'Use a timeout from 1000 to 120000 ms.');
    const run = await runLocalWorkspaceCommand(root, command, command === 'git' ? ['-c', 'core.fsmonitor=false', ...args] : args, timeoutMs); if (!run.ok) return run; audit('workspace', operation, run.data.exitCode === 0 ? 'success' : 'failure', `Ran approved local command ${command}.`, { instanceId: instance.id, durationMs: run.data.durationMs }); return ok({ instanceId: instance.id, workspace: root, ...run.data });
  }
  if (operation === 'workspace_search') {
    const query = typeof input.query === 'string' && input.query.length > 0 && input.query.length <= 200 ? input.query : ''; if (!query) return fail('invalid_query', 'Provide a source search query up to 200 characters.');
    const matches: Array<{ path: string; line: number; text: string }> = []; let visited = 0; const skipped = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'out', 'dist', 'coverage', '.pytest_cache', '.mypy_cache', '.tox', 'vendor']); const walk = (dir: string, prefix: string, depth: number): void => { if (depth > 12 || matches.length >= 200 || visited >= 10_000) return; for (const entry of readdirSync(dir, { withFileTypes: true })) { if (matches.length >= 200 || visited >= 10_000) break; if (skipped.has(entry.name.toLowerCase())) continue; visited++; const full = path.join(dir, entry.name), rel = path.join(prefix, entry.name); try { if (entry.isDirectory()) walk(full, rel, depth + 1); else if (entry.isFile() && !workspaceSensitivePath(rel) && statSync(full).size <= 512 * 1024) readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, index) => { if (matches.length < 200 && line.includes(query)) matches.push({ path: rel, line: index + 1, text: redacted(line.slice(0, 500)) }); }); } catch { /* inaccessible entries are skipped */ } } }; walk(root, '', 0); return ok({ query, matches, filesVisited: visited, truncated: visited >= 10_000 || matches.length >= 200 });
  }
  if (operation === 'workspace_diff') { const target = input.path === undefined ? null : workspacePath(root, input.path); if (target && !target.ok) return target; const run = await runLocalWorkspaceCommand(root, 'git', ['-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--', ...(target ? [target.data.relative] : [])], 30_000); return run.ok ? ok({ workspace: root, diff: run.data.stdout, error: run.data.stderr, truncated: run.data.truncated }) : run; }
  const target = workspacePath(root, input.path, operation === 'workspace_list_directory'); if (!target.ok) return target;
  const action = operation === 'workspace_write_file' ? String(input.action) : operation;
  if (['workspace_list_directory', 'workspace_file_info', 'workspace_read_file'].includes(operation)) { if (operation === 'workspace_read_file' && workspaceSensitivePath(target.data.relative)) return fail('sensitive_workspace_file_denied', 'Buddy cannot read local credential or private-key files.'); const existing = canonicalWorkspaceExisting(root, target.data.path); if (!existing.ok) return existing; if (operation === 'workspace_list_directory') { try { return ok({ path: target.data.relative, entries: readdirSync(existing.data, { withFileTypes: true }).filter((entry) => entry.name.toLowerCase() !== '.git').slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })) }); } catch { return fail('workspace_read_failed', 'Could not list the workspace directory.'); } } const info = statSync(existing.data); if (operation === 'workspace_file_info') return ok({ path: target.data.relative, kind: info.isFile() ? 'regular file' : info.isDirectory() ? 'directory' : 'other', bytes: info.size }); if (!info.isFile() || info.size > 256 * 1024) return fail('unsafe_file', 'Only regular text files up to 256 KiB can be read.'); return ok({ path: target.data.relative, content: redacted(readFileSync(existing.data, 'utf8')), bytes: info.size }); }
  if (!['write', 'mkdir', 'rename', 'delete'].includes(action)) return fail('invalid_operation', 'Use write, mkdir, rename, or delete.');
  const destination = action === 'rename' ? workspacePath(root, input.destinationPath) : null; if (action === 'rename' && (!destination || !destination.ok)) return destination && !destination.ok ? destination : fail('invalid_workspace_path', 'A destination path is required.'); const destinationData = destination?.ok ? destination.data : null;
  if (workspaceSensitivePath(target.data.relative) || (destinationData && workspaceSensitivePath(destinationData.relative))) return fail('sensitive_workspace_file_denied', 'Buddy cannot modify local credential or private-key files.');
  const content = typeof input.content === 'string' ? input.content : ''; if (action === 'write' && (typeof input.content !== 'string' || Buffer.byteLength(content, 'utf8') > 256 * 1024)) return fail('invalid_content', 'Write content must be UTF-8 text no larger than 256 KiB.');
  const approval = approvedConfirmation(operation, input, instance, root, `${action} ${target.data.relative} in local Development Workspace`); if (!approval.ok) return approval;
  try { if (action === 'mkdir') { const parent = canonicalWorkspaceParent(root, target.data.path); if (!parent.ok) return parent; mkdirSync(target.data.path); } else if (action === 'delete') { const existing = canonicalWorkspaceExisting(root, target.data.path); if (!existing.ok || existing.data === root) return existing.ok ? fail('workspace_root_protected', 'The workspace root cannot be deleted.') : existing; statSync(existing.data).isDirectory() ? rmSync(existing.data, { recursive: true }) : unlinkSync(existing.data); } else if (action === 'rename') { if (!destinationData) return fail('invalid_workspace_path', 'A destination path is required.'); const source = canonicalWorkspaceExisting(root, target.data.path); const parent = canonicalWorkspaceParent(root, destinationData.path); if (!source.ok) return source; if (!parent.ok) return parent; if (existsSync(destinationData.path)) return fail('destination_exists', 'The destination workspace path already exists.'); renameSync(source.data, destinationData.path); } else { const parent = canonicalWorkspaceParent(root, target.data.path); if (!parent.ok) return parent; if (existsSync(target.data.path)) { const existing = canonicalWorkspaceExisting(root, target.data.path); if (!existing.ok) return existing; } const temp = path.join(parent.data, `.buddy-tmp-${crypto.randomUUID()}`); writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 }); renameSync(temp, target.data.path); }
  } catch { return fail('workspace_write_failed', 'The local workspace operation could not be completed.'); }
  recordWorkspaceChange(instance, action as 'write' | 'mkdir' | 'rename' | 'delete', target.data.relative, destination?.ok ? destination.data.relative : undefined, typeof input.summary === 'string' ? input.summary : ''); audit('workspace', operation, 'success', `Changed local workspace ${target.data.relative}; awaiting user deployment.`, { instanceId: instance.id }); return ok({ instanceId: instance.id, workspace: root, action, path: target.data.relative, ...(destination?.ok ? { destinationPath: destination.data.relative } : {}), deploymentState: 'awaiting_deployment' });
}
function confirmationFingerprint(operation: string, input: Record<string, unknown>, container: string): string {
  // Keep approvals operation-bound.  In particular, a PostgreSQL approval must
  // never be reusable for a different statement or parameter set.
  const relevant = { operation, instanceId: input.instanceId, container, action: input.action, path: input.path, destinationPath: input.destinationPath, content: input.content, command: input.command, args: input.args, workingDirectory: input.workingDirectory, environment: input.environment, query: input.query, parameters: input.parameters };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}
function requestConfirmation(operation: string, input: Record<string, unknown>, instance: OdooInstance, container: string, summary: string): OperationResult<{ confirmationId: string; expiresAt: string }> {
  const fingerprint = confirmationFingerprint(operation, input, container);
  const supplied = typeof input.confirmationId === 'string' ? input.confirmationId : '';
  const existing = pendingConfirmations.get(supplied);
  if (existing?.approved && existing.expiresAt > Date.now() && existing.fingerprint === fingerprint && existing.instanceId === instance.id) {
    pendingConfirmations.delete(existing.id);
    return ok({ confirmationId: existing.id, expiresAt: new Date(existing.expiresAt).toISOString() });
  }
  const id = crypto.randomUUID(); const expiresAt = Date.now() + 5 * 60_000;
  pendingConfirmations.set(id, { id, fingerprint, instanceId: instance.id, summary, expiresAt, approved: false });
  return fail('confirmation_required', `Approval is required in Buddy before this operation can run. Confirmation ID: ${id}`);
}
function approvedConfirmation(operation: string, input: Record<string, unknown>, instance: OdooInstance, container: string, summary: string): OperationResult<undefined> {
  const requested = requestConfirmation(operation, input, instance, container, summary);
  return requested.ok ? ok(undefined) : requested;
}
function pendingConfirmationList(): Array<Pick<PendingConfirmation, 'id' | 'instanceId' | 'summary' | 'expiresAt'>> {
  const now = Date.now();
  for (const item of pendingConfirmations.values()) if (item.expiresAt <= now) pendingConfirmations.delete(item.id);
  return [...pendingConfirmations.values()].filter((item) => !item.approved).map(({ id, instanceId, summary, expiresAt }) => ({ id, instanceId, summary, expiresAt }));
}
type TerminalExecution = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean; durationMs: number };
async function runRemoteTerminal(instance: OdooInstance, args: string[], timeoutMs: number, stdin?: string): Promise<OperationResult<TerminalExecution>> {
  if (!instance.ssh.enabled || !cleanText(instance.ssh.alias, 120)) return fail('ssh_required', 'This operation requires SSH enabled with a configured local alias.');
  // ssh concatenates remote argv into a shell command on many servers. Send a
  // constant `sh -s` argv and decode every value inside that script so neither
  // caller input nor configured paths/credentials become shell syntax.
  const encodedArgs = args.map((value) => Buffer.from(value, 'utf8').toString('base64'));
  const encodedStdin = stdin === undefined ? '' : Buffer.from(stdin, 'utf8').toString('base64');
  const script = ['set -eu', 'set --', ...encodedArgs.map((value) => `set -- "$@" "$(printf %s '${value}' | base64 -d)"`), stdin === undefined ? 'exec "$@"' : `printf %s '${encodedStdin}' | base64 -d | "$@"`].join('\n');
  return new Promise((resolve) => {
    const startedAt = Date.now(); let stdout = ''; let stderr = ''; let timedOut = false; let truncated = false;
    const child = spawn('/usr/bin/ssh', ['-F', settings.paths.sshConfigPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', instance.ssh.alias, 'sh', '-s'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stdin?.end(script);
    const append = (current: string, chunk: Buffer, max: number): string => { const value = chunk.toString(); if (current.length >= max) { truncated = true; return current; } if (current.length + value.length > max) { truncated = true; return current + value.slice(0, max - current.length); } return current + value; };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs + 1_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk, 64 * 1024); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk, 16 * 1024); });
    child.once('error', () => { clearTimeout(timer); resolve(fail('execution_start_failed', 'Could not start the SSH-backed container execution.')); });
    child.once('close', (code) => { clearTimeout(timer); resolve(ok({ stdout: redacted(stdout), stderr: redacted(stderr), exitCode: code, timedOut, truncated, durationMs: Date.now() - startedAt })); });
  });
}
function terminalEnvironment(value: unknown): OperationResult<string[]> {
  if (value === undefined) return ok([]);
  if (!isRecord(value)) return fail('invalid_environment', 'Environment overrides must be a small key/value object.');
  const forbidden = /^(PATH|HOME|SHELL|BUDDY_|CONTROL_PLANE_|LD_|NODE_)/;
  const entries = Object.entries(value);
  if (entries.length > 10) return fail('invalid_environment', 'Provide at most 10 environment overrides.');
  const output: string[] = [];
  for (const [key, raw] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || forbidden.test(key) || typeof raw !== 'string' || raw.length > 200 || !/^[A-Za-z0-9_./:=+,-]*$/.test(raw)) return fail('invalid_environment', 'An environment override is unsafe or attempts to replace an execution-critical variable.');
    output.push(`${key}=${raw}`);
  }
  return ok(output);
}
function terminalNeedsConfirmation(instance: OdooInstance, command: string): boolean {
  const highImpact = /(^|[\s;&|])(rm\s+-[A-Za-z]*r|docker\s|shutdown|reboot|kill\s+-9|pkill|systemctl|service\s|dropdb|psql|odoo\b.*(?:-u|--update|--stop-after-init)|(?:>|>>)\s*\/etc\/|chmod\s+-R|chown\s+-R)/i;
  return highImpact.test(command) || (instance.environment === 'production' && /(^|[\s;&|])(rm|mv|cp|pip\s+install|odoo|python|bash|sh)\b/i.test(command));
}
function databaseTarget(instance: OdooInstance): OperationResult<{ name: string; user: string; container: string }> {
  const mode = instance.database.connectionMode;
  if (mode === 'docker' && !isDockerized(instance.deploymentNature)) return fail('invalid_database_configuration', 'Docker PostgreSQL mode requires a Dockerized instance.');
  if (mode === 'external' && (!/^[A-Za-z0-9.-]{1,253}$/.test(instance.database.host) || !Number.isInteger(instance.database.port) || instance.database.port < 1 || instance.database.port > 65535)) return fail('invalid_database_configuration', 'Configure a valid external PostgreSQL host and port.');
  if (mode === 'external' && instance.database.authMethod === 'password' && !instance.database.credentialRef) return fail('invalid_database_configuration', 'Password authentication requires a saved GNOME Keyring credential.');
  if (mode === 'external' && ['verify-ca', 'verify-full'].includes(instance.database.sslMode) && !safeRemoteFilesystemPath(instance.database.sslRootCertPath)) return fail('invalid_database_configuration', 'Verified SSL requires an absolute CA certificate path on the configured SSH target.');
  const container = mode === 'docker' ? dockerContainer(instance, 'postgres') : ok(mode === 'external' ? 'external-postgres' : 'ssh-host');
  if (!container.ok) return container;
  const name = instance.database.name, user = instance.database.user;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(user)) return fail('invalid_database_configuration', 'Configure a valid database name and PostgreSQL user for this instance.');
  return ok({ name, user, container: container.data });
}
async function runOdoo(instance: OdooInstance, container: string, script: string, args: string[], timeoutMs: number): Promise<OperationResult<TerminalExecution>> {
  return isDockerized(instance.deploymentNature)
    ? runRemoteTerminal(instance, ['docker', 'exec', '--', container, 'sh', '-c', script, 'buddy-odoo', ...args], timeoutMs)
    : runRemoteTerminal(instance, ['sh', '-c', script, 'buddy-odoo', ...args], timeoutMs);
}
function postgresParameters(value: unknown): OperationResult<string[]> {
  if (value === undefined) return ok([]);
  if (!isRecord(value) || Object.keys(value).length > 50) return fail('invalid_parameters', 'Parameters must be an object with at most 50 named scalar values.');
  const args: string[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) || !['string', 'number', 'boolean'].includes(typeof raw) || String(raw).length > 2000) return fail('invalid_parameters', 'Parameter names or values are invalid.');
    // psql only treats values as SQL literals when the query uses :'name'.
    args.push('-v', `${name}=${String(raw)}`);
  }
  return ok(args);
}
async function runPostgres(instance: OdooInstance, target: { name: string; user: string; container: string }, sql: string, readOnly: boolean, timeoutMs: number, parameterArgs: string[]): Promise<OperationResult<TerminalExecution>> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const prefix = readOnly ? `BEGIN READ ONLY; SET LOCAL statement_timeout = '${timeoutMs}ms'; ` : `BEGIN; SET LOCAL statement_timeout = '${timeoutMs}ms'; `;
  const suffix = '; COMMIT;';
  const script = 'set -eu; q=$(printf %s "$1" | base64 -d); password=$(cat); if [ -n "$password" ]; then export PGPASSWORD="$password"; fi; export PGSSLMODE="$4" PGCONNECT_TIMEOUT="$5"; if [ -n "$6" ]; then export PGSSLROOTCERT="$6"; fi; shift 6; psql -X -v ON_ERROR_STOP=1 -P pager=off -A -F "\\t" "$@" -c "$2$q$3"';
  const base = ['sh', '-c', script, 'buddy-postgres', encoded, prefix, suffix, instance.database.sslMode, String(Math.max(1, Math.ceil(instance.database.connectTimeoutMs / 1000))), instance.database.sslRootCertPath, '-U', target.user, '-d', target.name, ...parameterArgs];
  if (instance.database.connectionMode === 'docker') return runRemoteTerminal(instance, ['docker', 'exec', '-i', '--', target.container, ...base], timeoutMs);
  const external = instance.database.connectionMode === 'external';
  let password = '';
  if (external && instance.database.authMethod === 'password') { try { password = await keyringLookup(instance.database.credentialRef!); } catch { return fail('credential_unavailable', 'The configured PostgreSQL credential is unavailable in GNOME Keyring.'); } }
  const args = external ? [...base, '-h', instance.database.host, '-p', String(instance.database.port)] : base;
  return runRemoteTerminal(instance, args, timeoutMs, password);
}
async function assertTerminalContainerSafe(instance: OdooInstance, container: string): Promise<OperationResult<undefined>> {
  const inspected = await runRemote(instance, ['docker', 'inspect', '--format', '{{json .Mounts}}', '--', container]);
  if (!inspected.ok) return inspected;
  try {
    const mounts = JSON.parse(inspected.data.stdout) as Array<{ Type?: string; Destination?: string }>;
    if (!Array.isArray(mounts)) throw new Error();
    // Bind-mounted source/addon directories are normal Odoo development setup.
    // Do not reject them wholesale; reject mounts which expose Docker or host
    // control surfaces instead.
    if (mounts.some((mount) => ['/var/run/docker.sock', '/run/docker.sock', '/host', '/proc', '/sys'].includes(mount.Destination || ''))) return fail('unsafe_container_mount', 'General terminal execution is unavailable because this container exposes a Docker or host control mount.');
    return ok(undefined);
  } catch { return fail('invalid_docker_response', 'Docker returned an unexpected mount response.'); }
}
async function operationalCall(operation: unknown, input: unknown): Promise<OperationResult<unknown>> {
  if (operation === 'odoo_list_instances') {
    return ok(settings.instances.map((instance) => ({
      id: instance.id,
      name: instance.name,
      enabled: instance.enabled,
      environment: instance.environment,
      odooVersion: instance.odooVersion,
      edition: instance.edition,
      deploymentNature: instance.deploymentNature,
    })));
  }
  if (!isRecord(input) || !validId(input.instanceId)) return fail('invalid_request', 'A valid instanceId is required.');
  const spec: Record<string, InstancePermission> = { container_inspect: 'containerInspect', container_logs: 'containerLogs', container_list_directory: 'containerFilesystemRead', container_file_info: 'containerFilesystemRead', container_read_file: 'containerFilesystemRead', container_write_file: 'containerFilesystemWrite', container_execute: 'containerTerminal', postgres_inspect: 'postgresRead', postgres_query_readonly: 'postgresRead', postgres_execute_write: 'postgresWrite', odoo_shell_execute: 'odooShell', odoo_list_modules: 'odooShell', odoo_inspect_module: 'odooShell', odoo_run_tests: 'runTests', odoo_service_diagnostics: 'odooDiagnostics', workspace_list_directory: 'workspaceRead', workspace_file_info: 'workspaceRead', workspace_read_file: 'workspaceRead', workspace_search: 'workspaceRead', workspace_diff: 'workspaceRead', workspace_deployment_status: 'workspaceRead', workspace_verify_deployment: 'workspaceRead', workspace_write_file: 'workspaceWrite', workspace_report_deployed: 'workspaceWrite', workspace_execute: 'workspaceExecute' };
  const permission = typeof operation === 'string' ? spec[operation] : undefined;
  if (!permission) return fail('unsupported_operation', 'This operation is not available through the trusted bridge.');
  const access = assertInstancePermission(input.instanceId, permission);
  if (!access.ok) { audit('permissions', String(operation), 'denied', access.error.message, { instanceId: input.instanceId }); return access; }
  const instance = access.data;
  if (String(operation).startsWith('workspace_')) return executeWorkspace(instance, String(operation), input);
  if (String(operation).startsWith('odoo_')) {
    const odoo = isDockerized(instance.deploymentNature) ? dockerContainer(instance, 'odoo') : ok('ssh-host'); if (!odoo.ok) return odoo;
    const timeoutMs = input.timeoutMs === undefined ? 30_000 : Number(input.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) return fail('invalid_timeout', 'Use a timeout from 1000 to 120000 ms.');
    const database = { name: instance.database.name, user: instance.database.user };
    const executable = 'odoo_exec=$(command -v odoo || command -v odoo-bin || true); test -n "$odoo_exec" || { echo "Odoo executable not found" >&2; exit 127; }; ';
    let run: OperationResult<TerminalExecution>;
    if (operation === 'odoo_shell_execute') { const code = typeof input.code === 'string' ? input.code : ''; if (!code || code.length > 64_000) return fail('invalid_code', 'Provide Odoo Python code up to 64000 characters.'); const approval = approvedConfirmation(String(operation), input, instance, odoo.data, `Odoo shell (${instance.environment}) ${createHash('sha256').update(code).digest('hex').slice(0, 12)}`); if (!approval.ok) return approval; const encoded = Buffer.from(code).toString('base64'); run = await runOdoo(instance, odoo.data, `${executable} code=$(printf %s "$1" | base64 -d); printf '%s\n' "$code" | "$odoo_exec" shell -d "$2" --no-http`, [encoded, database.name], timeoutMs); }
    else if (operation === 'odoo_list_modules' || operation === 'odoo_inspect_module') { const module = operation === 'odoo_inspect_module' ? (typeof input.module === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.module) ? input.module : '') : ''; if (operation === 'odoo_inspect_module' && !module) return fail('invalid_module', 'Provide a valid technical module name.'); const code = module ? `m=env['ir.module.module'].search([('name','=','${module}')],limit=1); print({'name':m.name,'state':m.state,'version':m.installed_version,'summary':m.summary,'description':m.description})` : "print(env['ir.module.module'].search_read([],['name','shortdesc','state','installed_version'],limit=200,order='name'))"; run = await runOdoo(instance, odoo.data, `${executable} code=$(printf %s "$1" | base64 -d); printf '%s\n' "$code" | "$odoo_exec" shell -d "$2" --no-http`, [Buffer.from(code).toString('base64'), database.name], timeoutMs); }
    else if (operation === 'odoo_run_tests') { const modules = Array.isArray(input.modules) && input.modules.length && input.modules.every((m) => typeof m === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(m)) ? input.modules as string[] : []; if (!modules.length) return fail('invalid_modules', 'Provide one or more valid module names.'); if (instance.environment === 'production') { const approval = approvedConfirmation(String(operation), input, instance, odoo.data, `Odoo tests (${instance.environment}) ${modules.join(',')}`); if (!approval.ok) return approval; } const tags = typeof input.testTags === 'string' && /^[A-Za-z0-9_.,:+-]{0,500}$/.test(input.testTags) ? input.testTags : ''; run = await runOdoo(instance, odoo.data, `${executable} exec "$odoo_exec" -d "$1" -u "$2" --test-enable --stop-after-init ${tags ? '--test-tags "$3"' : ''}`, [database.name, modules.join(','), tags], timeoutMs); }
    else if (operation === 'odoo_service_diagnostics') { run = await runOdoo(instance, odoo.data, `${executable} "$odoo_exec" --version; printf '\nPROCESSES\n'; ps aux | grep '[o]doo' || true; printf '\nDISK\n'; df -h .`, [], timeoutMs); }
    else return fail('unsupported_operation', 'Unsupported Odoo operation.');
    const value = run.ok ? ok({ instanceId: instance.id, database: database.name, exitCode: run.data.exitCode, stdout: run.data.stdout, stderr: run.data.stderr, durationMs: run.data.durationMs, timedOut: run.data.timedOut, truncated: run.data.truncated, status: run.data.exitCode === 0 ? 'success' : 'failed' }) : run;
    audit('operations', String(operation), value.ok && value.data.status === 'success' ? 'success' : 'failure', value.ok ? `Completed ${String(operation)}.` : value.error.message, { instanceId: instance.id }); return value;
  }
  if (String(operation).startsWith('postgres_')) {
    const target = databaseTarget(instance); if (!target.ok) return target;
    const timeoutMs = input.timeoutMs === undefined ? 15_000 : Number(input.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) return fail('invalid_timeout', 'Use a timeout from 1000 to 30000 ms.');
    let sql = '';
    if (operation === 'postgres_inspect') { const action = input.action; const schema = typeof input.schema === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.schema) ? input.schema : 'public'; const table = typeof input.table === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.table) ? input.table : ''; if (action === 'database') sql = 'SELECT version(), current_database(), current_user, current_schema(), pg_database_size(current_database())'; else if (action === 'schemas') sql = "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name LIMIT 200"; else if (action === 'tables') sql = `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name LIMIT 500`; else if (action === 'columns' && table) sql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`; else if (action === 'indexes' && table) sql = `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = '${table}'`; else return fail('invalid_inspection', 'Use database, schemas, tables, columns, or indexes; columns and indexes require a table.'); }
    else { sql = typeof input.query === 'string' ? input.query.trim() : ''; if (!sql || sql.length > 64_000 || /\0/.test(sql)) return fail('invalid_query', 'Provide SQL up to 64000 characters.'); if (/;\s*\S/.test(sql)) return fail('multiple_statements', 'Only one SQL statement is allowed per request.'); }
    if (operation === 'postgres_execute_write') { const approval = approvedConfirmation(String(operation), input, instance, target.data.container, `PostgreSQL write to ${target.data.name}: ${createHash('sha256').update(sql).digest('hex').slice(0, 12)}`); if (!approval.ok) return approval; }
    const parameterArgs = postgresParameters(input.parameters); if (!parameterArgs.ok) return parameterArgs;
    const run = await runPostgres(instance, target.data, sql.replace(/;\s*$/, ''), operation !== 'postgres_execute_write', timeoutMs, parameterArgs.data);
    const pgResult = run.ok ? ok({ instanceId: instance.id, database: target.data.name, status: run.data.timedOut ? 'timed_out' : run.data.exitCode === 0 ? 'success' : 'failed', exitCode: run.data.exitCode, output: run.data.stdout, error: run.data.stderr, durationMs: run.data.durationMs, truncated: run.data.truncated }) : run;
    audit('operations', String(operation), pgResult.ok && pgResult.data.status === 'success' ? 'success' : 'failure', pgResult.ok ? `Completed ${String(operation)} for database ${target.data.name}.` : pgResult.error.message, { instanceId: instance.id });
    return pgResult;
  }
  if (!isDockerized(instance.deploymentNature) && ['container_list_directory', 'container_file_info', 'container_read_file', 'container_write_file'].includes(String(operation))) {
    if (operation === 'container_write_file' && (remoteSourceWriteDenied(instance, input.path, input.content) || remoteSourceWriteDenied(instance, input.destinationPath, undefined))) return fail('remote_source_change_denied', 'Remote custom source-code changes are blocked. Use this instance’s configured local Development Workspace and deploy it manually.');
    const startedAt = Date.now();
    const result = await executeRemoteFilesystem(instance, String(operation), input);
    audit('operations', String(operation), result.ok ? 'success' : 'failure', result.ok ? `Completed ${String(operation)} in configured SSH filesystem roots.` : result.error.message, { instanceId: instance.id, durationMs: Date.now() - startedAt });
    return result;
  }
  const container = operation === 'container_execute' && !isDockerized(instance.deploymentNature) ? ok('ssh-host') : dockerContainer(instance, operation === 'container_write_file' || operation === 'container_execute' ? 'odoo' : input.role);
  if (!container.ok) return container;
  const startedAt = Date.now();
  let result: OperationResult<unknown>;
  if (operation === 'container_inspect') {
    const remote = await runRemote(instance, ['docker', 'inspect', '--format', '{{json .}}', '--', container.data]);
    if (!remote.ok) result = remote;
    else {
      try {
        const raw = JSON.parse(remote.data.stdout) as Record<string, unknown>;
        const state = isRecord(raw.State) ? raw.State : {};
        const config = isRecord(raw.Config) ? raw.Config : {};
        result = ok({ role: input.role, name: raw.Name, id: raw.Id, image: config.Image, state: { running: state.Running, status: state.Status, health: isRecord(state.Health) ? state.Health.Status : null, restartCount: raw.RestartCount, startedAt: state.StartedAt } });
      } catch { result = fail('invalid_docker_response', 'Docker returned an unexpected inspection response.'); }
    }
  } else if (operation === 'container_logs') {
    const lines = Number(input.lines);
    if (!Number.isInteger(lines) || lines < 1 || lines > 500) return fail('invalid_lines', 'Request between 1 and 500 log lines.');
    const remote = await runRemote(instance, ['docker', 'logs', '--tail', String(lines), '--timestamps', '--', container.data]);
    result = remote.ok ? ok({ role: input.role, lines, output: redacted(`${remote.data.stdout}\n${remote.data.stderr}`).slice(0, 64 * 1024), truncated: remote.data.stdout.length + remote.data.stderr.length >= 64 * 1024 }) : remote;
  } else if (operation === 'container_write_file') {
    if (input.role !== 'odoo') return fail('invalid_role', 'Filesystem modifications are limited to the configured Odoo container.');
    const action = input.action;
    if (!['write', 'mkdir', 'rename', 'delete'].includes(String(action))) return fail('invalid_operation', 'Use write, mkdir, rename, or delete.');
    const target = safeContainerPath(input.path);
    const destination = action === 'rename' ? safeContainerPath(input.destinationPath) : null;
    if (!target || (action === 'rename' && !destination)) return fail('invalid_path', 'Use authorized absolute paths without traversal segments.');
    if (remoteSourceWriteDenied(instance, target, input.content) || remoteSourceWriteDenied(instance, destination, undefined)) return fail('remote_source_change_denied', 'Remote custom source-code changes are blocked. Use this instance’s configured local Development Workspace and deploy it manually.');
    const content = typeof input.content === 'string' ? input.content : '';
    if (action === 'write' && (typeof input.content !== 'string' || Buffer.byteLength(content, 'utf8') > 256 * 1024)) return fail('invalid_content', 'Write content must be UTF-8 text no larger than 256 KiB.');
    const summary = `${String(action)} ${target}${destination ? ` → ${destination}` : ''} in configured Odoo container`;
    const approved = approvedConfirmation(String(operation), input, instance, container.data, summary);
    if (!approved.ok) return approved;
    const parent = path.posix.dirname(target);
    const parentCanonical = await runRemote(instance, ['docker', 'exec', '--', container.data, 'realpath', '--', parent]);
    if (!parentCanonical.ok || !safeContainerPath(parentCanonical.ok ? parentCanonical.data.stdout.trim() : '')) result = fail('path_escape', 'The target parent resolves outside Buddy’s authorized container paths.');
    else if (action === 'mkdir') {
      const remote = await runRemote(instance, ['docker', 'exec', '--', container.data, 'mkdir', '--', target]); result = remote.ok ? ok({ action, path: target, created: true }) : remote;
    } else if (action === 'rename') {
      const destinationParent = path.posix.dirname(destination!); const check = await runRemote(instance, ['docker', 'exec', '--', container.data, 'realpath', '--', destinationParent]);
      if (!check.ok || !safeContainerPath(check.ok ? check.data.stdout.trim() : '')) result = fail('path_escape', 'The destination parent resolves outside Buddy’s authorized container paths.');
      else { const remote = await runRemote(instance, ['docker', 'exec', '--', container.data, 'mv', '--', target, destination!]); result = remote.ok ? ok({ action, path: target, destinationPath: destination, renamed: true }) : remote; }
    } else if (action === 'delete') {
      const remote = await runRemote(instance, ['docker', 'exec', '--', container.data, 'rm', '--', target]); result = remote.ok ? ok({ action, path: target, deleted: true }) : remote;
    } else {
      const payload = Buffer.from(content, 'utf8').toString('base64');
      const script = 'set -eu; tmp="$1.buddy-tmp-$$"; printf %s "$2" | base64 -d > "$tmp"; mv -f -- "$tmp" "$1"';
      const remote = await runRemote(instance, ['docker', 'exec', '--', container.data, 'sh', '-c', script, 'buddy-write', target, payload], 20_000);
      result = remote.ok ? ok({ action, path: target, bytes: Buffer.byteLength(content, 'utf8'), written: true }) : remote;
    }
  } else if (operation === 'container_execute') {
    if (input.role !== undefined && input.role !== 'odoo') return fail('invalid_role', 'Terminal operations are limited to the configured Odoo container.');
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command || command.length > 16_000 || /[\0\r\n]/.test(command)) return fail('invalid_command', 'Provide a non-empty single-line command up to 16000 characters.');
    const rawArgs = input.args === undefined ? [] : input.args;
    if (!Array.isArray(rawArgs) || rawArgs.length > 80 || rawArgs.some((item) => typeof item !== 'string' || item.length > 1000 || /[\0\r\n]/.test(item))) return fail('invalid_arguments', 'Arguments must be up to 80 single-line strings of at most 1000 characters.');
    const commandLine = [command, ...(rawArgs as string[]).map((item) => JSON.stringify(item))].join(' ');
    const workingDirectory = input.workingDirectory === undefined ? '' : input.workingDirectory;
    if (typeof workingDirectory !== 'string' || workingDirectory.length > 500 || /[\0\r\n]/.test(workingDirectory) || workingDirectory === '/var/run/docker.sock' || workingDirectory.startsWith('/var/run/docker.sock/')) return fail('invalid_working_directory', 'Working directory is invalid or targets the Docker socket.');
    if (remoteDeploymentCommandDenied(commandLine)) return fail('manual_deployment_only', 'Buddy cannot deploy, pull source, upgrade modules, or restart remote services. Perform deployment manually, then tell Buddy when it is complete.');
    if (remoteTerminalSourceWriteDenied(instance, commandLine, workingDirectory)) return fail('remote_source_change_denied', 'Remote terminal commands that appear to modify custom source code are blocked. Make source changes in this instance’s local Development Workspace and deploy manually.');
    const environment = terminalEnvironment(input.environment);
    if (!environment.ok) return environment;
    if (isDockerized(instance.deploymentNature)) {
      const safeContainer = await assertTerminalContainerSafe(instance, container.data);
      if (!safeContainer.ok) return safeContainer;
    }
    const timeoutMs = input.timeoutMs === undefined ? 15_000 : Number(input.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) return fail('invalid_timeout', 'Use a timeout from 1000 to 30000 ms.');
    const summary = `general container command: ${redacted(command).slice(0, 180)} (${createHash('sha256').update(commandLine).digest('hex').slice(0, 12)})`;
    if (terminalNeedsConfirmation(instance, commandLine)) { const approved = approvedConfirmation(String(operation), input, instance, container.data, summary); if (!approved.ok) return approved; }
    // The caller's command and directory are base64 parameters, never part of the SSH/Docker command syntax.
    const encodedCommand = Buffer.from(commandLine, 'utf8').toString('base64');
    const encodedDirectory = Buffer.from(workingDirectory, 'utf8').toString('base64');
    const script = 'set -eu; test ! -S /var/run/docker.sock || { echo "Docker socket access is disabled" >&2; exit 126; }; cmd=$(printf %s "$1" | base64 -d); dir=$(printf %s "$2" | base64 -d); if [ -n "$dir" ]; then cd "$dir"; fi; if command -v timeout >/dev/null 2>&1; then exec timeout --kill-after=2s "$3" sh -c "$cmd"; fi; exec sh -c "$cmd"';
    const terminalInvocation = ['sh', '-c', script, 'buddy-terminal', encodedCommand, encodedDirectory, `${Math.ceil(timeoutMs / 1000)}s`];
    const args = isDockerized(instance.deploymentNature) ? ['docker', 'exec', ...environment.data.flatMap((entry) => ['--env', entry]), '--', container.data, ...terminalInvocation] : terminalInvocation;
    const remote = await runRemoteTerminal(instance, args, timeoutMs);
    result = remote.ok ? ok({ instanceId: instance.id, command: redacted(command).slice(0, 500), workingDirectory: workingDirectory || null, exitCode: remote.data.exitCode, stdout: remote.data.stdout, stderr: remote.data.stderr, durationMs: remote.data.durationMs, timedOut: remote.data.timedOut, truncated: remote.data.truncated, status: remote.data.timedOut ? 'timed_out' : remote.data.exitCode === 0 ? 'success' : 'failed' }) : remote;
  } else {
    const requestedPath = safeContainerPath(input.path);
    if (!requestedPath) return fail('invalid_path', 'Use an authorized absolute path without traversal segments.');
    const canonical = await runRemote(instance, ['docker', 'exec', '--', container.data, 'realpath', '--', requestedPath]);
    if (!canonical.ok) result = canonical;
    else {
      const resolved = canonical.data.stdout.trim();
      if (!safeContainerPath(resolved)) result = fail('path_escape', 'The requested path resolves outside Buddy’s authorized container paths.');
      else if (operation === 'container_list_directory') {
        const remote = await runRemote(instance, ['docker', 'exec', '--', container.data, 'find', resolved, '-maxdepth', '1', '-mindepth', '1', '-printf', '%f\t%y\t%s\n']);
        result = remote.ok ? ok({ path: resolved, entries: remote.data.stdout.split('\n').filter(Boolean).slice(0, 500) }) : remote;
      } else {
        const info = await runRemote(instance, ['docker', 'exec', '--', container.data, 'stat', '-c', '%F\t%s', '--', resolved]);
        const [kind, size] = info.ok ? info.data.stdout.trim().split('\t') : [];
        if (!info.ok) result = info;
        else if (operation === 'container_file_info') result = ok({ path: resolved, kind, bytes: /^\d+$/.test(size) ? Number(size) : null });
        else if (kind !== 'regular file' || !/^\d+$/.test(size) || Number(size) > 256 * 1024) result = fail('unsafe_file', 'Only regular text files up to 256 KiB can be read.');
        else { const remote = await runRemote(instance, ['docker', 'exec', '--', container.data, 'cat', '--', resolved]); result = remote.ok ? ok({ path: resolved, content: redacted(remote.data.stdout), bytes: Number(size) }) : remote; }
      }
    }
  }
  const targetSummary = typeof input.path === 'string' ? ` at ${input.path}` : '';
  audit('operations', String(operation), result.ok ? 'success' : 'failure', result.ok ? `Completed ${String(operation)} for configured container ${container.data}${targetSummary}.` : result.error.message, { instanceId: instance.id, durationMs: Date.now() - startedAt });
  return result;
}
function startBridgeServer(): void {
  const socketPath = bridgeSocketPath();
  try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* stale socket */ }
  bridgeServer = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { buffer += chunk; let end: number; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); void (async () => { try { const request: unknown = JSON.parse(line); if (!isRecord(request) || request.token !== bridgeToken) throw new Error('Unauthorized bridge request.'); const response = await operationalCall(request.operation, request.input); socket.write(`${JSON.stringify(response)}\n`); } catch (cause) { socket.write(`${JSON.stringify(fail('bridge_request_failed', cause instanceof Error ? cause.message : 'Bridge request failed.'))}\n`); } })(); } });
  });
  bridgeServer.listen(socketPath);
}

if (started) app.quit();
app.whenReady().then(() => {
  settings = loadStore();
  startBridgeServer();
  audit('application', 'app.start', 'success', 'Buddy opened.');
  ipcMain.handle('buddy:get-overview', async () => {
    const profile = runningProfileId
      ? settings.profiles.find((item) => item.id === runningProfileId)
      : activeProfile();
    if (state === 'running' && profile) await refreshHealth(profile);
    return {
      settings: publicSettings(),
      status: snapshot(),
      instances: settings.instances,
      activity: settings.activity.slice(0, 8),
      version: app.getVersion(),
    };
  });
  ipcMain.handle('buddy:get-settings', () => publicSettings());
  ipcMain.handle(
    'buddy:save-settings',
    (_e, input: unknown): OperationResult<PublicSettings> => {
      if (!isRecord(input) || state === 'running')
        return fail(
          'settings_locked',
          state === 'running'
            ? 'Stop the tunnel before changing runtime settings.'
            : 'Settings are invalid.',
        );
      const paths = isRecord(input.paths) ? input.paths : null,
        retention = Number(input.logRetentionDays);
      if (
        !paths ||
        !Number.isInteger(retention) ||
        retention < 1 ||
        retention > 3650
      )
        return fail(
          'invalid_settings',
          'Enter a retention period between 1 and 3650 days.',
        );
      const next: RuntimePaths = { ...settings.paths };
      for (const key of Object.keys(next) as (keyof RuntimePaths)[]) {
        const value = cleanText(paths[key], 500);
        if (!value)
          return fail('invalid_path', `Enter a valid value for ${key}.`);
        next[key] = value;
      }
      settings.paths = next;
      settings.general.logRetentionDays = retention;
      saveStore();
      audit(
        'settings',
        'settings.save',
        'success',
        'Runtime settings updated.',
      );
      return ok(publicSettings());
    },
  );
  ipcMain.handle(
    'buddy:save-profile',
    (_e, input: unknown): OperationResult<TunnelProfile> => {
      const checked = validateProfile(input);
      if (!checked.ok) return checked;
      if (state === 'running' && checked.data.id === runningProfileId)
        return fail(
          'profile_running',
          'Stop the tunnel before editing its running profile.',
        );
      const index = settings.profiles.findIndex(
        (p) => p.id === checked.data.id,
      );
      if (index >= 0) settings.profiles[index] = checked.data;
      else settings.profiles.push(checked.data);
      if (!settings.activeProfileId) settings.activeProfileId = checked.data.id;
      saveStore();
      audit(
        'settings',
        'profile.save',
        'success',
        `Profile ${checked.data.name} saved.`,
        { profileId: checked.data.id },
      );
      return checked;
    },
  );
  ipcMain.handle(
    'buddy:delete-profile',
    (_e, id: unknown): OperationResult<undefined> => {
      if (!validId(id)) return fail('invalid_id', 'Profile ID is invalid.');
      if (runningProfileId === id)
        return fail(
          'profile_running',
          'Stop the running profile before deleting it.',
        );
      const profile = settings.profiles.find((p) => p.id === id);
      if (!profile) return fail('not_found', 'Profile was not found.');
      settings.profiles = settings.profiles.filter((p) => p.id !== id);
      if (settings.activeProfileId === id)
        settings.activeProfileId = settings.profiles[0]?.id ?? null;
      saveStore();
      audit(
        'settings',
        'profile.delete',
        'success',
        `Profile ${profile.name} deleted.`,
        { profileId: id },
      );
      return ok(undefined);
    },
  );
  ipcMain.handle(
    'buddy:set-active-profile',
    (_e, id: unknown): OperationResult<undefined> => {
      if (
        !validId(id) ||
        !settings.profiles.some((p) => p.id === id && p.enabled)
      )
        return fail('invalid_profile', 'Choose an enabled profile.');
      if (state === 'running')
        return fail(
          'profile_running',
          'Stop the tunnel before changing the active profile.',
        );
      settings.activeProfileId = id;
      saveStore();
      audit(
        'settings',
        'profile.activate',
        'success',
        'Active profile changed.',
        { profileId: id },
      );
      return ok(undefined);
    },
  );
  ipcMain.handle(
    'buddy:set-credential',
    async (
      _e,
      profileId: unknown,
      secret: unknown,
    ): Promise<OperationResult<undefined>> => {
      if (
        !validId(profileId) ||
        typeof secret !== 'string' ||
        secret.length < 8 ||
        secret.length > 4096
      )
        return fail('invalid_credential', 'Enter a valid API key.');
      if (!settings.profiles.some((p) => p.id === profileId))
        return fail('not_found', 'Profile was not found.');
      if (!existsSync('/usr/bin/secret-tool'))
        return fail(
          'keyring_unavailable',
          'Install libsecret-tools and unlock GNOME Keyring before saving a key.',
        );
      try {
        await new Promise<void>((resolve, reject) => {
          const store = spawn(
            '/usr/bin/secret-tool',
            [
              'store',
              '--label=Buddy tunnel runtime key',
              'application',
              keyringApp,
              'profile',
              profileId,
            ],
            { stdio: ['pipe', 'ignore', 'ignore'], shell: false },
          );
          const timer = setTimeout(() => {
            store.kill('SIGTERM');
            reject(new Error('Keyring timeout'));
          }, 8000);
          store.once('error', reject);
          store.once('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error('Keyring store failed'));
          });
          store.stdin?.end(secret);
        });
        settings.credentialStatus[profileId] = true;
        saveStore();
        audit(
          'settings',
          'credential.replace',
          'success',
          'Credential replaced.',
          { profileId },
        );
        return ok(undefined);
      } catch {
        return fail(
          'keyring_failed',
          'Buddy could not save the key. Unlock GNOME Keyring and try again.',
        );
      }
    },
  );
  ipcMain.handle('buddy:set-database-credential', async (_e, instanceId: unknown, secret: unknown): Promise<OperationResult<undefined>> => {
    if (!validId(instanceId) || typeof secret !== 'string' || !secret.length || secret.length > 4096) return fail('invalid_credential', 'Enter a valid database password.');
    const instance = settings.instances.find((item) => item.id === instanceId);
    if (!instance || instance.database.connectionMode !== 'external' || !instance.database.credentialRef) return fail('invalid_database_configuration', 'This instance is not configured for password-authenticated external PostgreSQL.');
    if (!existsSync('/usr/bin/secret-tool')) return fail('keyring_unavailable', 'Install libsecret-tools and unlock GNOME Keyring before saving a password.');
    try {
      await new Promise<void>((resolve, reject) => { const store = spawn('/usr/bin/secret-tool', ['store', '--label=Buddy PostgreSQL credential', 'application', keyringApp, 'credential', instance.database.credentialRef!], { stdio: ['pipe', 'ignore', 'ignore'], shell: false }); const timer = setTimeout(() => { store.kill('SIGTERM'); reject(new Error('timeout')); }, 8000); store.once('error', reject); store.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('failed')); }); store.stdin?.end(secret); });
      settings.credentialStatus[instance.database.credentialRef] = true; saveStore(); audit('settings', 'database_credential.replace', 'success', 'Database credential replaced.', { instanceId: instance.id }); return ok(undefined);
    } catch { return fail('keyring_failed', 'Buddy could not save the database password. Unlock GNOME Keyring and try again.'); }
  });
  ipcMain.handle('buddy:validate-runtime', () => validateRuntime());
  ipcMain.handle('buddy:tunnel-status', () => snapshot());
  ipcMain.handle('buddy:tunnel-start', () => startTunnel());
  ipcMain.handle('buddy:tunnel-stop', () => stopTunnel());
  ipcMain.handle('buddy:list-instances', () => settings.instances);
  ipcMain.handle('buddy:list-pending-confirmations', () => pendingConfirmationList());
  ipcMain.handle('buddy:approve-confirmation', (_e, id: unknown): OperationResult<undefined> => {
    if (!validId(id)) return fail('invalid_confirmation', 'Confirmation ID is invalid.');
    const pending = pendingConfirmations.get(id);
    if (!pending || pending.expiresAt <= Date.now()) return fail('confirmation_expired', 'This confirmation is no longer available. Request the operation again.');
    pending.approved = true;
    audit('operations', 'confirmation.approve', 'success', `Approved ${pending.summary}.`, { instanceId: pending.instanceId });
    return ok(undefined);
  });
  ipcMain.handle(
    'buddy:save-instance',
    (_e, input: unknown): OperationResult<OdooInstance> => {
      if (!isRecord(input))
        return fail('invalid_instance', 'Instance data is invalid.');
      const name = cleanText(input.name, 80), environment = input.environment,
        deploymentNature = input.deploymentNature, ssh = isRecord(input.ssh) ? input.ssh : {}, docker = isRecord(input.docker) ? input.docker : {};
      const databaseInput = isRecord(input.database) ? input.database : {}, filesystemInput = isRecord(input.filesystem) ? input.filesystem : {}, workspaceInput = isRecord(input.developmentWorkspace) ? input.developmentWorkspace : {};
      const instanceId = validId(input.id) ? input.id : crypto.randomUUID();
      const connectionMode = ['docker', 'ssh_local', 'external'].includes(String(databaseInput.connectionMode)) ? databaseInput.connectionMode as OdooInstance['database']['connectionMode'] : isDockerized(deploymentNature as DeploymentNature) ? 'docker' : 'ssh_local';
      const roots = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => /^\/[A-Za-z0-9_./-]{1,299}$/.test(v) && !v.split('/').includes('..') && v !== '/').slice(0, 12) : [];
      const workspace = canonicalWorkspaceConfiguration(workspaceInput.repositoryPath); if (!workspace.ok) return workspace;
      if (
        !name ||
        !['development', 'staging', 'production'].includes(
          String(environment),
        ) || !['odoo_sh', 'on_premise', 'on_premise_dockerized', 'vps', 'vps_dockerized'].includes(String(deploymentNature)) ||
        !Number.isInteger(Number(input.odooVersion)) || Number(input.odooVersion) < 1 ||
        !['ce', 'ee'].includes(String(input.edition)) ||
        (ssh.enabled === true && !cleanText(ssh.alias, 120)) ||
        (isDockerized(deploymentNature as DeploymentNature) && (!cleanText(docker.odooContainer, 120) || !cleanText(docker.postgresContainer, 120))) ||
        (connectionMode === 'external' && (!/^[A-Za-z0-9.-]{1,253}$/.test(String(databaseInput.host ?? '')) || !Number.isInteger(Number(databaseInput.port)) || Number(databaseInput.port) < 1 || Number(databaseInput.port) > 65535))
      )
        return fail(
          'invalid_instance',
          'Complete the required Details and Configuration fields. SSH aliases and Docker container names are required only when enabled or applicable.',
        );
      const suppliedPermissions = isRecord(input.permissions) ? input.permissions : {};
      const permissions = permissionDefaults();
      (Object.keys(permissions) as InstancePermission[]).forEach((key) => { permissions[key] = suppliedPermissions[key] === true; });
      const instance: OdooInstance = {
        id: instanceId,
        name, description: typeof input.description === 'string' ? input.description.slice(0, 500) : '',
        notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : '', enabled: input.enabled !== false,
        deploymentNature: deploymentNature as DeploymentNature,
        environment: environment as EnvironmentType,
        odooVersion: Number(input.odooVersion), edition: input.edition as 'ce' | 'ee',
        docker: { odooContainer: typeof docker.odooContainer === 'string' ? docker.odooContainer.trim().slice(0, 120) : '', postgresContainer: typeof docker.postgresContainer === 'string' ? docker.postgresContainer.trim().slice(0, 120) : '' },
        database: { name: cleanText(databaseInput.name, 63) ?? 'postgres', user: cleanText(databaseInput.user, 63) ?? 'postgres', connectionMode, host: typeof databaseInput.host === 'string' ? databaseInput.host.trim().slice(0, 253) : '', port: Number.isInteger(Number(databaseInput.port)) ? Number(databaseInput.port) : 5432, sslMode: ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(String(databaseInput.sslMode)) ? databaseInput.sslMode as OdooInstance['database']['sslMode'] : 'prefer', sslRootCertPath: typeof databaseInput.sslRootCertPath === 'string' ? databaseInput.sslRootCertPath.trim().slice(0, 300) : '', connectTimeoutMs: Number.isInteger(Number(databaseInput.connectTimeoutMs)) && Number(databaseInput.connectTimeoutMs) >= 1000 && Number(databaseInput.connectTimeoutMs) <= 30000 ? Number(databaseInput.connectTimeoutMs) : 8000, authMethod: connectionMode === 'external' && databaseInput.authMethod === 'password' ? 'password' : 'peer', credentialRef: connectionMode === 'external' && databaseInput.authMethod === 'password' ? databaseCredentialRef(instanceId) : null },
        ssh: { enabled: ssh.enabled === true, alias: typeof ssh.alias === 'string' ? ssh.alias.trim().slice(0, 120) : '' }, permissions,
        filesystem: { projectRoot: typeof filesystemInput.projectRoot === 'string' ? filesystemInput.projectRoot.trim().slice(0, 300) : '', addonRoots: roots(filesystemInput.addonRoots), additionalRoots: roots(filesystemInput.additionalRoots) },
        developmentWorkspace: { repositoryPath: workspace.data, deployment: { state: 'not_started', files: [], summary: '', verification: '', updatedAt: null } },
        lastDiagnostic: 'not_checked',
        lastConnectedAt: null,
      };
      const i = settings.instances.findIndex((x) => x.id === instance.id);
      if (i >= 0) {
        instance.lastDiagnostic = settings.instances[i].lastDiagnostic;
        instance.lastConnectedAt = settings.instances[i].lastConnectedAt;
        if (settings.instances[i].developmentWorkspace.repositoryPath === workspace.data) instance.developmentWorkspace.deployment = settings.instances[i].developmentWorkspace.deployment;
        settings.instances[i] = instance;
      } else settings.instances.push(instance);
      if (!settings.activeInstanceId) settings.activeInstanceId = instance.id;
      saveStore();
      audit(
        'instances',
        'instance.save',
        'success',
        `Instance ${name} saved.`,
        { instanceId: instance.id },
      );
      return ok(instance);
    },
  );
  ipcMain.handle(
    'buddy:delete-instance',
    (_e, id: unknown): OperationResult<undefined> => {
      if (!validId(id)) return fail('invalid_id', 'Instance ID is invalid.');
      const instance = settings.instances.find((x) => x.id === id);
      if (!instance) return fail('not_found', 'Instance was not found.');
      settings.instances = settings.instances.filter((x) => x.id !== id);
      if (settings.activeInstanceId === id)
        settings.activeInstanceId = settings.instances[0]?.id ?? null;
      saveStore();
      audit(
        'instances',
        'instance.delete',
        'success',
        `Instance ${instance.name} deleted.`,
        { instanceId: id },
      );
      return ok(undefined);
    },
  );
  ipcMain.handle(
    'buddy:test-instance',
    async (_e, id: unknown): Promise<OperationResult<OdooInstance>> => {
      const access = assertInstancePermission(id, 'connectivity');
      if (!access.ok) {
        audit(
          'permissions',
          'connectivity',
          'denied',
          access.error.message,
          { instanceId: validId(id) ? id : undefined },
        );
        return access;
      }
      const instance = access.data;
      if (!instance.ssh.enabled || !instance.ssh.alias)
        return fail(
          'not_supported',
          'Enable SSH and provide a local SSH alias before testing this instance.',
        );
      const startedAt = Date.now();
      try {
        await execFileAsync(
          '/usr/bin/ssh',
          [
            '-F',
            settings.paths.sshConfigPath,
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=8',
            instance.ssh.alias,
            'true',
          ],
          { timeout: 12_000, maxBuffer: 4096 },
        );
        instance.lastDiagnostic = 'success';
        instance.lastConnectedAt = new Date().toISOString();
        saveStore();
        audit(
          'instances',
          'connection.test',
          'success',
          'SSH connectivity check succeeded.',
          { instanceId: instance.id, durationMs: Date.now() - startedAt },
        );
        return ok(instance);
      } catch {
        instance.lastDiagnostic = 'failed';
        saveStore();
        audit(
          'instances',
          'connection.test',
          'failure',
          'SSH connectivity check failed.',
          { instanceId: instance.id, durationMs: Date.now() - startedAt },
        );
        return fail(
          'connection_failed',
          'SSH connectivity check failed. Check the SSH alias and local log.',
        );
      }
    },
  );
  ipcMain.handle('buddy:list-activity', (_e, query: unknown) => {
    const q = isRecord(query) ? query : {},
      search =
        typeof q.search === 'string'
          ? q.search.toLowerCase().slice(0, 100)
          : '',
      result = typeof q.result === 'string' ? q.result : '';
    return settings.activity
      .filter(
        (event) =>
          (!search ||
            `${event.category} ${event.action} ${event.summary}`
              .toLowerCase()
              .includes(search)) &&
          (!result || event.result === result),
      )
      .slice(0, 300);
  });
  ipcMain.handle(
    'buddy:open-logs',
    async (): Promise<OperationResult<undefined>> => {
      ensurePrivate(logDir());
      const message = await shell.openPath(logDir());
      return message
        ? fail('open_failed', 'Could not open the logs folder.')
        : ok(undefined);
    },
  );
  windowRef = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
    void windowRef.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else
    void windowRef.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void windowRef?.show();
  });
});
app.on('before-quit', () => {
  stopRequested = true;
  if (child) void stopChild();
  bridgeServer?.close();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
