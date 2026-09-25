const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owl', {
  isDesktop: true,
  /* interactive:true is allowed to show a D2L sign-in window; false stays silent */
  grab: (interactive) => ipcRenderer.invoke('owl:grab', !!interactive),
  signOut: () => ipcRenderer.invoke('owl:signout'),
  forgetSite: (origin) => ipcRenderer.invoke('owl:forgetSite', origin),
  onData: (cb) => ipcRenderer.on('owl:data', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('owl:status', (_e, text) => cb(text)),
  onNeedLogin: (cb) => ipcRenderer.on('owl:needlogin', () => cb()),
  pullAleks: (courseIds) => ipcRenderer.invoke('owl:aleks', courseIds),
  checkAleks: (courseIds) => ipcRenderer.invoke('owl:alekscheck', courseIds),
  pullGradescope: (interactive) => ipcRenderer.invoke('owl:gradescope', interactive),
  pullCalendar: (orgUnits) => ipcRenderer.invoke('owl:calendar', orgUnits),
  /* Updates: check, then download and install only when asked. */
  updateCheck: () => ipcRenderer.invoke('owl:updateCheck'),
  updateDownload: () => ipcRenderer.invoke('owl:updateDownload'),
  updateInstall: () => ipcRenderer.invoke('owl:updateInstall'),
  onUpdate: (cb) => ipcRenderer.on('owl:update', (_e, payload) => cb(payload))
});
