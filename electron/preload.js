const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer (index.html)
contextBridge.exposeInMainWorld('electronAPI', {
  // Opens the native macOS/Windows folder picker and returns the chosen path
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // True when running inside Electron (vs plain browser)
  isElectron: true,
});
