const { app, dialog, BrowserWindow } = require('electron');
const debug = require('./debugLog').shared;

// Asks GitHub Releases for a newer installer and, with the user's OK, downloads it and installs it when the app closes.
// Only in the installed app: a development run has nothing to update.
function checkForUpdates() {
    if (!app.isPackaged || process.env.OGAI_NO_UPDATE) return;
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch (err) { debug.info('update', 'updater not available', { error: err.message }); return; }
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
    autoUpdater.checkForUpdates().catch((err) => debug.info('update', 'check failed', { error: err.message }));
}

module.exports = { checkForUpdates };
