const path = require('node:path');
const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut,
} = require('electron');
const { createStore } = require('./store');

let store;
let win = null;
let tray = null;
let quitting = false;
// A tray click blurs the panel before the click arrives. Remember when the blur
// happened so that same click is not read as "open it again".
let lastBlurAt = 0;

const PANEL_WIDTH = 460;
const PANEL_MAX_HEIGHT = 720;
const HOTKEY = 'Alt+X';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--hidden')) return;
  showWindow();
});

const showWindow = () => {
  if (!win) createWindow();
  win.show();
  win.focus();
};

const toggleWindow = () => {
  if (win && win.isVisible()) {
    win.hide();
    return;
  }
  if (Date.now() - lastBlurAt < 400) return;
  showWindow();
};

const createTray = () => {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip(`TaskX — ${HOTKEY} to open`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open TaskX', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', toggleWindow);
};

const createWindow = () => {
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.min(PANEL_MAX_HEIGHT, workArea.height - 96);
  win = new BrowserWindow({
    width: PANEL_WIDTH,
    height,
    // Flush to the left screen edge, vertically centred: a flyout, not an app window.
    x: workArea.x,
    y: workArea.y + Math.round((workArea.height - height) / 2),
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    // No taskbar entry and no Alt+Tab entry: it is summoned, not alt-tabbed to.
    skipTaskbar: true,
    backgroundColor: '#07111f',
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

  // Chromium marks an occluded window as hidden, so the renderer cannot tell
  // "just summoned" from page visibility: say so explicitly.
  win.on('show', () => win.webContents.send('panel:shown'));

  // Clicking anywhere else dismisses the popup.
  win.on('blur', () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    lastBlurAt = Date.now();
    win.hide();
  });
  // Closing hides to the tray; only Quit really exits.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
};

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

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
  ipcMain.on('panel:hide', () => {
    if (win && win.isVisible()) win.hide();
  });

  createTray();
  // Registration can fail if another app already owns the shortcut; the tray still works.
  if (!globalShortcut.register(HOTKEY, toggleWindow)) {
    console.warn(`${HOTKEY} is already taken by another app; use the tray icon.`);
  }

  // A login start goes straight to the tray instead of stealing focus.
  if (!process.argv.includes('--hidden')) createWindow();
});

app.on('window-all-closed', () => app.quit());
