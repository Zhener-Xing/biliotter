const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { startBridgeServer } = require('./bridge-server');

let mainWindow;
let bridgeServer;
let latestEvent = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 340,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('face.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcastPetEvent(payload) {
  latestEvent = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:event', payload);
  }
}

ipcMain.handle('pet:getLatest', () => latestEvent);

ipcMain.on('pet:moveBy', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + (Number(dx) || 0)), Math.round(y + (Number(dy) || 0)));
});

app.whenReady().then(async () => {
  createWindow();

  try {
    bridgeServer = await startBridgeServer(broadcastPetEvent);
  } catch (err) {
    console.error('[bili-pet] bridge failed to start:', err.message || err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
