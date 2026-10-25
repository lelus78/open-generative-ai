// Where the app saves what it makes, and a way to open those folders in the file explorer.
const { ipcMain, shell, app, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { resolveLocalAiPaths } = require('./localInferencePaths');

/** The folders of the results: pictures and clips of the Image / Video / Cinema studios, H3 clips, finished movies. */
function folders() {
    const data = resolveLocalAiPaths({ userDataPath: app.getPath('userData') }).dataDir;
    return {
        media: path.join(data, 'wan2gp', 'runs'),
        anime: path.join(data, 'comfy-h3', 'runs'),
        movies: path.join(data, 'movies'),
        all: data,
    };
}

// Copies a result somewhere chosen by the user. Only files inside the app's own data folder can be copied this way.
async function saveCopy(file, suggestedName) {
    const root = path.resolve(folders().all);
    const source = path.resolve(String(file || ''));
    const relative = path.relative(root, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(source)) throw new Error('That file is not one of the app\'s results.');
    const ext = path.extname(source);
    const pick = await dialog.showSaveDialog(BrowserWindow.getAllWindows()[0] || null, {
        title: 'Save a copy',
        defaultPath: path.join(app.getPath('music'), `${String(suggestedName || path.basename(source, ext)).slice(0, 80)}${ext}`),
        filters: [{ name: ext.slice(1).toUpperCase() || 'File', extensions: [ext.slice(1) || '*'] }],
    });
    if (pick.canceled || !pick.filePath) return null;
    fs.copyFileSync(source, pick.filePath);
    return pick.filePath;
}

function register() {
    ipcMain.handle('outputs:save-copy', (_, file, name) => saveCopy(file, name));
    ipcMain.handle('outputs:paths', () => folders());
    ipcMain.handle('outputs:open', async (_, kind) => {
        const dir = folders()[kind];
        if (!dir) throw new Error(`Unknown folder: ${kind}`);
        fs.mkdirSync(dir, { recursive: true }); // nothing made yet: open the (empty) folder anyway
        const problem = await shell.openPath(dir);
        if (problem) throw new Error(`Could not open ${dir}: ${problem}`);
        return dir;
    });
}

module.exports = { register, folders };
