// Sonic VPN for Windows — preload: мост UI <-> main (contextIsolation).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sonic', {
  connect: (link) => ipcRenderer.invoke('app:connect', link),
  disconnect: () => ipcRenderer.invoke('app:disconnect'),
  diagnose: () => ipcRenderer.invoke('app:diagnose'),
  getProfile: () => ipcRenderer.invoke('app:get-profile'),
  setAutoconnect: (v) => ipcRenderer.invoke('app:set-autoconnect', v),
  copyReport: (text) => ipcRenderer.invoke('app:copy-report', text),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onStatus: (cb) => ipcRenderer.on('status', (_e, p) => cb(p)),
  onCoreProgress: (cb) => ipcRenderer.on('core-progress', (_e, p) => cb(p)),
});
