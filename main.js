const path = require('node:path');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { createStore } = require('./store');

let store;
let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--hidden')) return;
  if (win && win.isMinimized()) win.restore();
  showWindow();
});

const showWindow = () => {
  if (!win) createWindow();
  win.show();
  win.focus();
};

const createTray = () => {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('TaskX');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open TaskX', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
};

const createWindow = () => {
  win = new BrowserWindow({
    width: 760,
    height: 560,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'tray.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // No navigation away from the local file.
  win.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Closing hides to the tray; only Quit really exits.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
};

app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  store = createStore(path.join(app.getPath('userData'), 'data.json'));

  // Autostart. Electron's own execPath needs the app directory when unpackaged.
  // The unpackaged name defaults to electron.app.Electron, which would leave a stale second entry.
  if (!app.isPackaged) app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  app.setLoginItemSettings({
    openAtLogin: true,
    name: 'TaskX',
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [path.resolve(__dirname), '--hidden'],
  });

  ipcMain.handle('data:load', () => store.load());
  ipcMain.handle('data:save', (_e, doc) => store.save(doc));
  ipcMain.handle('data:move', (_e, id, direction) => {
    const doc = store.load();
    store.move(doc, id, direction);
    store.save(doc);
    return doc;
  });

  createTray();
  // A login start goes straight to the tray instead of stealing focus.
  if (!process.argv.includes('--hidden')) createWindow();
});

app.on('window-all-closed', () => app.quit());

