const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owl', {
  isDesktop: true,
  /* interactive:true is allowed to show a D2L sign-in window; false stays silent */
  grab: (interactive) => ipcRenderer.invoke('owl:grab', !!interactive),
  signOut: () => ipcRenderer.invoke('owl:signout'),
  onData: (cb) => ipcRenderer.on('owl:data', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('owl:status', (_e, text) => cb(text)),
  onNeedLogin: (cb) => ipcRenderer.on('owl:needlogin', () => cb())
});
