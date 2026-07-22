const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('biliPet', {
  onEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pet:event', handler);
    return () => ipcRenderer.removeListener('pet:event', handler);
  },
  getLatest() {
    return ipcRenderer.invoke('pet:getLatest');
  },
  moveBy(dx, dy) {
    ipcRenderer.send('pet:moveBy', dx, dy);
  },
});
