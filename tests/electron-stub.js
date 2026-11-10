/* Lets modules that require('electron') at the top load under plain node.
   Only the pure functions are tested; nothing here opens a window. */
const Module = require('module');
const stub = {
  BrowserWindow: function () { throw new Error('no windows in tests'); },
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
  app: { getPath: () => require('os').tmpdir(), on() {} },
  ipcMain: { handle() {}, on() {} },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return stub;
  return load.call(this, request, ...rest);
};
module.exports = stub;
