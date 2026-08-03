// The only bridge between the widget and the body. Context isolation is on and
// node integration is off, so the renderer gets this exact list of verbs and
// nothing else — no require, no filesystem, no child processes.

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('woboo', {
  snapshot: () => ipcRenderer.invoke('woboo:snapshot'),

  onFace: on('woboo:face'),
  onEvent: on('woboo:event'),
  onToast: on('woboo:toast'),
  onHover: on('woboo:hover'),
  onBoot: on('woboo:boot'),

  task: (text) => ipcRenderer.send('woboo:task', text),
  stop: () => ipcRenderer.send('woboo:stop'),
  resume: () => ipcRenderer.send('woboo:resume'),
  approve: (id, decision) => ipcRenderer.send('woboo:approve', { id, decision }),
  look: () => ipcRenderer.send('woboo:look'),
  panel: () => ipcRenderer.send('woboo:panel'),
  mode: (next) => ipcRenderer.send('woboo:mode', next),
  hide: () => ipcRenderer.send('woboo:hide'),
  quit: () => ipcRenderer.send('woboo:quit'),
});
