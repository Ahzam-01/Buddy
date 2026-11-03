import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('buddy', {
  getOverview: () => ipcRenderer.invoke('buddy:get-overview'),
  getSettings: () => ipcRenderer.invoke('buddy:get-settings'),
  saveSettings: (value: unknown) =>
    ipcRenderer.invoke('buddy:save-settings', value),
  saveProfile: (value: unknown) =>
    ipcRenderer.invoke('buddy:save-profile', value),
  deleteProfile: (id: string) => ipcRenderer.invoke('buddy:delete-profile', id),
  setActiveProfile: (id: string) =>
    ipcRenderer.invoke('buddy:set-active-profile', id),
  setCredential: (profileId: string, secret: string) =>
    ipcRenderer.invoke('buddy:set-credential', profileId, secret),
    setDatabaseCredential: (instanceId: string, secret: string) => ipcRenderer.invoke('buddy:set-database-credential', instanceId, secret),
  validateRuntime: () => ipcRenderer.invoke('buddy:validate-runtime'),
  getTunnelStatus: () => ipcRenderer.invoke('buddy:tunnel-status'),
  startTunnel: () => ipcRenderer.invoke('buddy:tunnel-start'),
  stopTunnel: () => ipcRenderer.invoke('buddy:tunnel-stop'),
  listInstances: () => ipcRenderer.invoke('buddy:list-instances'),
  listPendingConfirmations: () => ipcRenderer.invoke('buddy:list-pending-confirmations'),
  approveConfirmation: (id: string) => ipcRenderer.invoke('buddy:approve-confirmation', id),
  saveInstance: (value: unknown) =>
    ipcRenderer.invoke('buddy:save-instance', value),
  deleteInstance: (id: string) =>
    ipcRenderer.invoke('buddy:delete-instance', id),
  testInstance: (id: string) => ipcRenderer.invoke('buddy:test-instance', id),
  listActivity: (query?: unknown) =>
    ipcRenderer.invoke('buddy:list-activity', query),
  openLogs: () => ipcRenderer.invoke('buddy:open-logs'),
});
