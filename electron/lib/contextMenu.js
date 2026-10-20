// Native right-click menu: text editing (with spelling suggestions), images, videos and links.
// Studio-specific actions on results and history cards are HTML menus in the renderer; those call
// preventDefault() on the contextmenu event, so this one never shows over them.
const fs = require('fs');
const { fileURLToPath } = require('url');
const { app, Menu, MenuItem, dialog, shell, clipboard, net } = require('electron');
const { labelsFor, decodeDataUrl, defaultFileName } = require('./mediaFiles');

async function readMedia(srcURL) {
    const data = decodeDataUrl(srcURL);
    if (data) return data.buffer;
    if (String(srcURL).startsWith('file:')) return fs.readFileSync(fileURLToPath(srcURL));
    const response = await net.fetch(srcURL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function saveMediaAs(window, srcURL, mediaType) {
    const result = await dialog.showSaveDialog(window, { defaultPath: defaultFileName(srcURL, mediaType) });
    if (result.canceled || !result.filePath) return;
    try {
        fs.writeFileSync(result.filePath, await readMedia(srcURL));
    } catch (err) {
        dialog.showErrorBox('Save failed', err.message);
    }
}

function buildMenu(webContents, params, window, labels) {
    const menu = new Menu();
    const add = (item) => menu.append(new MenuItem(item));
    const separator = () => { if (menu.items.length && menu.items[menu.items.length - 1].type !== 'separator') add({ type: 'separator' }); };

    if (params.isEditable && params.misspelledWord) {
        if (params.dictionarySuggestions?.length) {
            for (const suggestion of params.dictionarySuggestions) {
                add({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) });
            }
        } else {
            add({ label: labels.noSuggestions, enabled: false });
        }
        add({ label: labels.addToDictionary, click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
        separator();
    }

    if (params.isEditable) {
        const flags = params.editFlags;
        add({ label: labels.undo, role: 'undo', enabled: flags.canUndo });
        add({ label: labels.redo, role: 'redo', enabled: flags.canRedo });
        separator();
        add({ label: labels.cut, role: 'cut', enabled: flags.canCut });
        add({ label: labels.copy, role: 'copy', enabled: flags.canCopy });
        add({ label: labels.paste, role: 'paste', enabled: flags.canPaste });
        add({ label: labels.selectAll, role: 'selectAll', enabled: flags.canSelectAll });
    } else if (params.selectionText) {
        add({ label: labels.copy, role: 'copy' });
        add({ label: labels.selectAll, role: 'selectAll' });
    }

    if (params.linkURL) {
        separator();
        if (/^https?:/i.test(params.linkURL)) add({ label: labels.openLink, click: () => shell.openExternal(params.linkURL) });
        add({ label: labels.copyLink, click: () => clipboard.writeText(params.linkURL) });
    }

    if (params.srcURL && ['image', 'video', 'audio'].includes(params.mediaType)) {
        separator();
        if (params.mediaType === 'image') {
            add({ label: labels.copyImage, click: () => webContents.copyImageAt(params.x, params.y) });
            add({ label: labels.saveImage, click: () => saveMediaAs(window, params.srcURL, 'image') });
        } else {
            add({ label: params.mediaType === 'video' ? labels.saveVideo : labels.saveAudio, click: () => saveMediaAs(window, params.srcURL, params.mediaType) });
        }
        if (!params.srcURL.startsWith('data:')) add({ label: labels.copyAddress, click: () => clipboard.writeText(params.srcURL) });
    }

    if (!app.isPackaged) {
        separator();
        add({ label: labels.inspect, click: () => webContents.inspectElement(params.x, params.y) });
    }

    return menu.items.length ? menu : null;
}

function setupContextMenu(window) {
    window.webContents.on('context-menu', (_event, params) => {
        const menu = buildMenu(window.webContents, params, window, labelsFor(app.getLocale()));
        menu?.popup({ window });
    });
}

module.exports = { setupContextMenu, buildMenu };
