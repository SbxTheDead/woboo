// The only bridge between the widget and the body. Context isolation is on and
// node integration is off, so the renderer gets this exact list of verbs and
// nothing else — no require, no filesystem, no child processes.

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('wobo', {
  snapshot: () => ipcRenderer.invoke('wobo:snapshot'),

  onFace: on('wobo:face'),
  onEvent: on('wobo:event'),
  onToast: on('wobo:toast'),
  onHover: on('wobo:hover'),
  onBoot: on('wobo:boot'),

  task: (text) => ipcRenderer.send('wobo:task', text),
  stop: () => ipcRenderer.send('wobo:stop'),
  resume: () => ipcRenderer.send('wobo:resume'),
  approve: (id, decision) => ipcRenderer.send('wobo:approve', { id, decision }),
  look: () => ipcRenderer.send('wobo:look'),
  panel: () => ipcRenderer.send('wobo:panel'),
  mode: (next) => ipcRenderer.send('wobo:mode', next),
  hide: () => ipcRenderer.send('wobo:hide'),
  quit: () => ipcRenderer.send('wobo:quit'),
});
