const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createStore } = require('./store');

let store;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

const createWindow = () => {
  win = new BrowserWindow({
    width: 760,
    height: 560,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
};

app.whenReady().then(() => {
  store = createStore(path.join(app.getPath('userData'), 'data.json'));

  ipcMain.handle('data:load', () => store.load());
  ipcMain.handle('data:save', (_e, doc) => store.save(doc));
  ipcMain.handle('data:move', (_e, id, direction) => {
    const doc = store.load();
    store.move(doc, id, direction);
    store.save(doc);
    return doc;
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
