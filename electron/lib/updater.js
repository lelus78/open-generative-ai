const { app, dialog, BrowserWindow, ipcMain } = require('electron');
const debug = require('./debugLog').shared;

// Asks GitHub Releases for a newer installer and, with the user's OK, downloads it and installs it when the app closes.
// Only in the installed app: a development run has nothing to update.
let updater = null;

function setup() {
    if (updater) return updater;
    if (!app.isPackaged || process.env.OGAI_NO_UPDATE) return null;
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch (err) { debug.info('update', 'updater not available', { error: err.message }); return null; }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    const win = () => BrowserWindow.getAllWindows()[0];

    autoUpdater.on('update-available', async (info) => {
        debug.info('update', 'new version', { version: info.version });
        const { response } = await dialog.showMessageBox(win(), {
            type: 'info', buttons: ['Download and install', 'Later'], defaultId: 0, cancelId: 1,
            title: 'Update available', message: `Open Generative AI ${info.version} is available (you have ${app.getVersion()}).`,
            detail: 'It downloads in the background and is installed when you close the app. Your models and results are not touched.',
        });
        if (response === 0) autoUpdater.downloadUpdate().catch((err) => debug.info('update', 'download failed', { error: err.message }));
    });
    autoUpdater.on('update-downloaded', async () => {
        const { response } = await dialog.showMessageBox(win(), {
            type: 'info', buttons: ['Restart now', 'On next close'], defaultId: 0, cancelId: 1,
            title: 'Update ready', message: 'The update is downloaded.',
        });
        if (response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', (err) => debug.info('update', 'check failed', { error: err.message }));
    updater = autoUpdater;
    return updater;
}

function checkForUpdates() {
    setup()?.checkForUpdates().catch((err) => debug.info('update', 'check failed', { error: err.message }));
}

/** The About section of Settings: the version, and a manual "Check for updates". */
function register() {
    ipcMain.handle('app:about', () => ({ version: app.getVersion(), packaged: app.isPackaged, platform: `${process.platform} ${process.arch}`, electron: process.versions.electron }));
    ipcMain.handle('app:check-update', async () => {
        const autoUpdater = setup();
        if (!autoUpdater) return { state: 'dev' };
        try {
            const result = await autoUpdater.checkForUpdates();
            const latest = result?.updateInfo?.version;
            return latest && latest !== app.getVersion() ? { state: 'available', version: latest } : { state: 'latest', version: app.getVersion() };
        } catch (err) {
            return { state: 'error', message: err.message };
        }
    });
}

module.exports = { checkForUpdates, register };
