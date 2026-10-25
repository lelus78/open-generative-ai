// Where the app saves what it makes, and a way to open those folders in the file explorer.
const { ipcMain, shell, app } = require('electron');
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

function register() {
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
