// Connects the shared debug log (debugLog.js) to the window: the Debug panel reads it, clears it, and the
// renderer can add its own lines. The log file lives next to the other local-ai settings.
const { ipcMain, app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { shared, formatEntries, gpuSnapshot } = require('./debugLog');

const LEVELS = new Set(['info', 'warn', 'error']);

function register() {
    const dir = path.join(app.getPath('userData'), 'local-ai');
    const settingsFile = path.join(dir, 'debug.json');
    shared.setFile(path.join(dir, 'debug.log'));
    try { shared.setVerbose(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).verbose === true); } catch { /* default: not verbose */ }

    shared.onEntry((entry) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('debug:entry', entry);
        }
    });

    ipcMain.handle('debug:get', () => ({ entries: shared.entries(), verbose: shared.isVerbose(), file: shared.getFile() }));
    ipcMain.handle('debug:text', () => formatEntries(shared.entries()));
    ipcMain.handle('debug:clear', () => { shared.clear(); return { ok: true }; });
    ipcMain.handle('debug:set-verbose', (_, value) => {
        shared.setVerbose(!!value);
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(settingsFile, JSON.stringify({ verbose: !!value }));
        } catch { /* the choice just does not survive a restart */ }
        shared.info('app', `verbose logging ${value ? 'on' : 'off'}`);
        return { ok: true };
    });
    // Lines written by the window itself (what the Image studio sent, errors on screen...).
    ipcMain.on('debug:log', (_, scope, level, message, data) => {
        shared[LEVELS.has(level) ? level : 'info'](`ui:${String(scope || 'app').slice(0, 24)}`, String(message || '').slice(0, 500), data);
    });
    ipcMain.handle('debug:open-folder', () => {
        const file = shared.getFile();
        if (file && fs.existsSync(file)) shell.showItemInFolder(file);
        else if (file) shell.openPath(path.dirname(file));
        return { ok: true };
    });

    // One line that says what this run looks like, so a pasted log explains itself.
    gpuSnapshot().then((gpu) => {
        let settings = {};
        try { settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'local-ai-settings.json'), 'utf-8')); } catch { /* no settings yet */ }
        shared.info('app', 'started', {
            version: app.getVersion(), electron: process.versions.electron, platform: `${process.platform} ${process.arch}`,
            translatePrompts: settings.translatePrompts !== false, writerModel: settings.writerModel || '(default Qwen3-4B)', gpu,
        });
    });
}

module.exports = { register };
