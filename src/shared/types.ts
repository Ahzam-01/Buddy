export type TunnelState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error';
export type HealthState =
  | 'reachable'
  | 'unreachable'
  | 'successful'
  | 'stale'
  | 'failed'
  | 'unknown'
  | 'running'
  | 'exited'
  | 'confirmed'
  | 'not_observed'
  | 'unverified';
export type EnvironmentType = 'development' | 'staging' | 'production';
export type DeploymentNature =
  | 'odoo_sh'
  | 'on_premise'
  | 'on_premise_dockerized'
  | 'vps'
  | 'vps_dockerized';
export type OdooEdition = 'ce' | 'ee';
export type InstancePermission =
  | 'connectivity'
  | 'containerFilesystemRead'
  | 'containerFilesystemWrite'
  | 'containerTerminal'
  | 'postgresRead'
  | 'postgresWrite'
  | 'odooShell'
  | 'runTests'
  | 'containerInspect'
  | 'containerLogs'
  | 'containerLifecycle'
  | 'odooDiagnostics'
  | 'odooConfigRead'
  | 'workspaceRead'
  | 'workspaceWrite'
  | 'workspaceExecute';
export type InstancePermissions = Record<InstancePermission, boolean>;

export type OperationResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; recoverable: boolean };
    };

export type TunnelProfile = {
  id: string;
  name: string;
  tunnelId: string;
  credentialRef: string;
  controlPlaneBaseUrl: string;
  healthBaseUrl: string;
  enabled: boolean;
};

export type RuntimePaths = {
  profileDirectory: string;
  sshConfigPath: string;
  stagingSshAlias: string;
};

export type OdooInstance = {
  id: string;
  name: string;
  description: string;
  notes: string;
  enabled: boolean;
  deploymentNature: DeploymentNature;
  environment: EnvironmentType;
  odooVersion: number;
  edition: OdooEdition;
  docker: { odooContainer: string; postgresContainer: string };
  database: {
    name: string; user: string;
    /** docker uses the configured postgres container; ssh uses remote psql; external is reached from the configured SSH host. */
    connectionMode: 'docker' | 'ssh_local' | 'external';
    host: string; port: number; sslMode: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
    /** A remote path on the configured SSH target; used only for verify-* SSL modes. */
    sslRootCertPath: string;
    connectTimeoutMs: number;
    authMethod: 'peer' | 'password';
    /** Opaque GNOME Keyring item reference, never a password. */
    credentialRef: string | null;
  };
  ssh: { enabled: boolean; alias: string };
  filesystem: { projectRoot: string; addonRoots: string[]; additionalRoots: string[] };
  developmentWorkspace: {
    /** Canonical local Git repository root; never supplied by MCP callers. */
    repositoryPath: string;
    deployment: {
      state: 'not_started' | 'awaiting_deployment' | 'deployment_reported_complete' | 'deployment_verified';
      files: Array<{ action: 'write' | 'mkdir' | 'rename' | 'delete'; path: string; destinationPath?: string }>;
      summary: string;
      verification: string;
      updatedAt: string | null;
    };
  };
  permissions: InstancePermissions;
  lastDiagnostic: 'not_checked' | 'success' | 'failed';
  lastConnectedAt: string | null;
};

export type Capability =
  | 'diagnostics.connectivity'
  | 'diagnostics.docker_status';
export type PermissionPolicy = Record<
  EnvironmentType,
  Record<Capability, boolean>
>;

export type ActivityEvent = {
  id: string;
  timestamp: string;
  category: string;
  action: string;
  result: 'success' | 'failure' | 'denied';
  profileId?: string;
  instanceId?: string;
  durationMs?: number;
  summary: string;
};

export type PublicSettings = {
  schemaVersion: number;
  activeProfileId: string | null;
  activeInstanceId: string | null;
  profiles: TunnelProfile[];
  paths: RuntimePaths;
  general: { logRetentionDays: number };
  credentialStatus: Record<string, boolean>;
};

export type TunnelStatusSnapshot = {
  state: TunnelState;
  error: string | null;
  profileId: string | null;
  process: 'stopped' | 'starting' | 'running' | 'failed';
  healthEndpoint: 'reachable' | 'unreachable' | 'unknown';
  controlPlane: 'successful' | 'stale' | 'failed' | 'unknown';
  mcpChild: 'running' | 'exited' | 'unknown';
  mcpInitialization: 'confirmed' | 'not_observed' | 'failed' | 'unknown';
  toolDiscovery: {
    state: 'confirmed' | 'not_observed' | 'failed' | 'unknown';
    tools: string[];
  };
  connector: 'unverified' | 'verified' | 'failed';
};

export type TunnelRuntimeDiagnostic = {
  available: boolean;
  path: string;
  version: string | null;
  platform: string;
  architecture: string;
  executable: boolean;
  issue: string | null;
};

export type OverviewSnapshot = {
  settings: PublicSettings;
  status: TunnelStatusSnapshot;
  instances: OdooInstance[];
  activity: ActivityEvent[];
  version: string;
};
