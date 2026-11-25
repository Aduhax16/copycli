const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('deck', {
  call: async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r.error) throw new Error(r.error); return r.ok; },
  on: (fn) => ipcRenderer.on('event', (_e, m) => fn(m.ch, m.data)),
});
