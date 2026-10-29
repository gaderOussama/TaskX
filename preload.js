const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskx', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (doc) => ipcRenderer.invoke('data:save', doc),
  move: (id, direction) => ipcRenderer.invoke('data:move', id, direction),
});
