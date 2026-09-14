const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owl', {
  isDesktop: true,
  /* interactive:true is allowed to show a D2L sign-in window; false stays silent */
  grab: (interactive) => ipcRenderer.invoke('owl:grab', !!interactive),
  signOut: () => ipcRenderer.invoke('owl:signout'),
  onData: (cb) => ipcRenderer.on('owl:data', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('owl:status', (_e, text) => cb(text)),
  onNeedLogin: (cb) => ipcRenderer.on('owl:needlogin', () => cb()),
  pullAleks: (courseIds) => ipcRenderer.invoke('owl:aleks', courseIds),
  checkAleks: (courseIds) => ipcRenderer.invoke('owl:alekscheck', courseIds),
  pullGradescope: (interactive) => ipcRenderer.invoke('owl:gradescope', interactive),
  /* Degree planning. The audit needs the Kennesaw sign-in; the maps are public. */
  pullDegree: (interactive) => ipcRenderer.invoke('owl:degree', interactive),
  listPrograms: () => ipcRenderer.invoke('owl:programs'),
  readProgram: (id) => ipcRenderer.invoke('owl:program', id),
  prereqs: (codes, index) => ipcRenderer.invoke('owl:prereqs', { codes, index }),
  forecast: () => ipcRenderer.invoke('owl:forecast')
});
