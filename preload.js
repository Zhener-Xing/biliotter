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
  openNotesPage() {
    return ipcRenderer.invoke('pet:openNotesPage');
  },
  openChatPage() {
    return ipcRenderer.invoke('pet:openChatPage');
  },
  goHome(opts) {
    return ipcRenderer.invoke('pet:goHome', opts || {});
  },
  /** 主进程通知知识库打开指定笔记 */
  onOpenHomeNote(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pet:openHomeNote', handler);
    return () => ipcRenderer.removeListener('pet:openHomeNote', handler);
  },
  chat(messages) {
    return ipcRenderer.invoke('pet:chat', { messages });
  },
  closeWindow() {
    return ipcRenderer.invoke('pet:closeWindow');
  },
  /** 主进程通知：即将关闭，先播退场音效 */
  onClosing(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = () => callback();
    ipcRenderer.on('pet:closing', handler);
    return () => ipcRenderer.removeListener('pet:closing', handler);
  },
  closingFinished() {
    ipcRenderer.send('pet:closing-finished');
  },
  notesLoad(bvid) {
    return ipcRenderer.invoke('pet:notesLoad', { bvid });
  },
  notesSave(payload) {
    return ipcRenderer.invoke('pet:notesSave', payload || {});
  },
  notesSaveSync(payload) {
    return ipcRenderer.sendSync('pet:notesSaveSync', payload || {});
  },
  notesOrganize(payload) {
    return ipcRenderer.invoke('pet:notesOrganize', payload || {});
  },
  notesSaveAsset(payload) {
    return ipcRenderer.invoke('pet:notesSaveAsset', payload || {});
  },
  notesAssetDataUrl(src) {
    return ipcRenderer.invoke('pet:notesAssetDataUrl', { src });
  },
});
