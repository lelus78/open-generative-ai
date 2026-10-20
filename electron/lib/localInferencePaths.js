const fs = require('fs');
const path = require('path');

const LOCAL_AI_DIR_ENV = 'OPEN_GENERATIVE_AI_LOCAL_AI_DIR';

function normalizeDirOverride(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Folder chosen from the settings UI. The env var, when set, still wins.
function configFilePath(userDataPath) {
    return path.join(userDataPath, 'local-ai-location.json');
}

function readStoredLocalAiDir(userDataPath) {
    if (!userDataPath) return '';
    try {
        return normalizeDirOverride(JSON.parse(fs.readFileSync(configFilePath(userDataPath), 'utf-8')).dir);
    } catch {
        return '';
    }
}

function writeStoredLocalAiDir(userDataPath, dir) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(configFilePath(userDataPath), JSON.stringify({ dir }, null, 2));
}

function resolveLocalAiPaths({ userDataPath, env = process.env } = {}) {
    const customDir = normalizeDirOverride(env[LOCAL_AI_DIR_ENV]) || readStoredLocalAiDir(userDataPath);

    if (!customDir && !userDataPath) {
        throw new Error(`userDataPath is required when ${LOCAL_AI_DIR_ENV} is not set`);
    }

    const dataDir = path.resolve(customDir || path.join(userDataPath, 'local-ai'));

    return {
        dataDir,
        binDir: path.join(dataDir, 'bin'),
        modelsDir: path.join(dataDir, 'models'),
        tmpDir: path.join(dataDir, 'tmp'),
    };
}

module.exports = {
    LOCAL_AI_DIR_ENV,
    resolveLocalAiPaths,
    writeStoredLocalAiDir,
};
