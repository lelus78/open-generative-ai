const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const { register: registerLocalInference } = require('./lib/localInference');
const { register: registerWan2gp } = require('./lib/wan2gpProvider');
const { register: registerComfyH3 } = require('./lib/comfyH3');
const { register: registerMovie } = require('./lib/movieMaker');
const { register: registerOutputFolders } = require('./lib/outputFolders');
const { register: registerDebug } = require('./lib/debugIpc');
const { shared: debugLog } = require('./lib/debugLog');
const { setupContextMenu } = require('./lib/contextMenu');
const { register: registerMcpControl } = require('./lib/mcpControl');

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    debugLog.error('app', 'uncaught exception in the main process', { error: err && err.stack ? err.stack : String(err) });
    try {
        dialog.showErrorBox('Open Generative AI — Unexpected Error', err && err.stack ? err.stack : String(err));
    } catch (_) {
        // dialog unavailable this early; the console log above is the fallback
    }
});

// Ubuntu 24.04+ sets kernel.apparmor_restrict_unprivileged_userns=1 which
// blocks Chromium's user namespace sandbox. The .deb package ships an AppArmor
// profile that grants the permission cleanly. When running the AppImage on an
// affected system, run once: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
// or pass --no-sandbox on the command line.
if (process.platform === 'linux') {
    app.commandLine.appendSwitch('disable-dev-shm-usage');
}

let mainWindow;

// Windows + Electron: after a native alert()/confirm() the page keeps the mouse but loses the keyboard
// (text fields stop taking input) until the window is minimised and restored. Blur + focus does the same.
ipcMain.on('app:refocus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.blur();
    win.focus();
    win.webContents.focus();
});

function createWindow() {
    const isMac = process.platform === 'darwin';

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        webPreferences: {
            webSecurity: true,
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
        backgroundColor: '#0d0d0d',
        show: false,
        title: 'Open Generative AI',
    });

    const indexPath = path.join(__dirname, '../dist/index.html');
    mainWindow.loadFile(indexPath).catch((err) => {
        console.error('Failed to load index.html:', err);
        mainWindow.show();
    });

    mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
        console.error('did-fail-load:', code, desc);
    });

    setupContextMenu(mainWindow);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    try {
        registerDebug();
        registerLocalInference();
        registerWan2gp();
        registerComfyH3();
        registerMovie();
        registerOutputFolders();
        registerMcpControl();
    } catch (err) {
        console.error('Failed to register local-ai/wan2gp handlers:', err);
        dialog.showErrorBox(
            'Local AI features unavailable',
            `Open Generative AI started, but local model support failed to initialize:\n\n${err.message}`
        );
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('before-quit', () => { try { require('./lib/wan2gpServer').stop(); } catch { /* not started */ } });

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
