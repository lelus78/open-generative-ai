const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAI', {
    isElectron: true,

    // ── sd.cpp engine ──────────────────────────────────────────────────────
    getBinaryStatus: () => ipcRenderer.invoke('local-ai:binary-status'),
    getHardware: () => ipcRenderer.invoke('local-ai:hardware'),
    translate: (text) => ipcRenderer.invoke('local-ai:translate', text),
    enhancePrompt: (text) => ipcRenderer.invoke('local-ai:enhance-prompt', text),
    promptVariants: (text, count) => ipcRenderer.invoke('local-ai:prompt-variants', text, count),
    suggestStories: (request) => ipcRenderer.invoke('local-ai:suggest-stories', request),
    storyboard: (request) => ipcRenderer.invoke('local-ai:storyboard', request),
    pickWriterModel: () => ipcRenderer.invoke('local-ai:pick-writer-model'),
    refocus: () => ipcRenderer.send('app:refocus'),
    getSettings: () => ipcRenderer.invoke('local-ai:get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('local-ai:set-settings', patch),
    pickStorageFolder: () => ipcRenderer.invoke('local-ai:pick-storage'),
    downloadBinary: () => ipcRenderer.invoke('local-ai:download-binary'),

    listModels: () => ipcRenderer.invoke('local-ai:list-models'),
    downloadModel: (modelId) => ipcRenderer.invoke('local-ai:download-model', modelId),
    downloadAuxiliary: (auxKey) => ipcRenderer.invoke('local-ai:download-auxiliary', auxKey),
    deleteModel: (modelId) => ipcRenderer.invoke('local-ai:delete-model', modelId),
    cancelDownload: (modelId) => ipcRenderer.invoke('local-ai:cancel-download', modelId),

    generate: (params) => ipcRenderer.invoke('local-ai:generate', params),
    cancelGeneration: () => ipcRenderer.invoke('local-ai:cancel-generation'),

    // ── Wan2GP engine (local folder or remote MCP server) ──────────────────
    wan2gp: {
        getConfig:  () => ipcRenderer.invoke('wan2gp:get-config'),
        setConfig:  (cfg) => ipcRenderer.invoke('wan2gp:set-config', cfg),
        setUrl:     (url) => ipcRenderer.invoke('wan2gp:set-url', url),
        check:      (cfg) => ipcRenderer.invoke('wan2gp:check', cfg),
        pickFolder: () => ipcRenderer.invoke('wan2gp:pick-folder'),
        install:    () => ipcRenderer.invoke('wan2gp:install'),
        deleteOutput: (filePath) => ipcRenderer.invoke('wan2gp:delete-output', filePath),
        readOutput: (filePath) => ipcRenderer.invoke('wan2gp:read-output', filePath),
        storageUsage: () => ipcRenderer.invoke('wan2gp:storage-usage'),
        clearOutputs: () => ipcRenderer.invoke('wan2gp:clear-outputs'),
        probe:      (url) => ipcRenderer.invoke('wan2gp:probe', url),
        listModels: () => ipcRenderer.invoke('wan2gp:list-models'),
        generate:   (params) => ipcRenderer.invoke('wan2gp:generate', params),
        cancelGeneration: () => ipcRenderer.invoke('wan2gp:cancel-generation'),
        uploadFile: (payload) => ipcRenderer.invoke('wan2gp:upload-file', payload),
    },

    // ── Debug log: what was asked, what each local tool did, why something failed ──
    about: () => ipcRenderer.invoke('app:about'),
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
    debug: {
        get: () => ipcRenderer.invoke('debug:get'),
        text: () => ipcRenderer.invoke('debug:text'),
        clear: () => ipcRenderer.invoke('debug:clear'),
        setVerbose: (value) => ipcRenderer.invoke('debug:set-verbose', value),
        openFolder: () => ipcRenderer.invoke('debug:open-folder'),
        log: (scope, level, message, data) => ipcRenderer.send('debug:log', scope, level, message, data),
        onEntry: (callback) => {
            const listener = (_, entry) => callback(entry);
            ipcRenderer.on('debug:entry', listener);
            return () => ipcRenderer.removeListener('debug:entry', listener);
        },
    },

    // ── MiniMax H3 anime/reference-to-video via the user's ComfyUI ───────────
    h3: {
        getConfig:  () => ipcRenderer.invoke('h3:get-config'),
        setConfig:  (cfg) => ipcRenderer.invoke('h3:set-config', cfg),
        pickFolder: () => ipcRenderer.invoke('h3:pick-folder'),
        status:     () => ipcRenderer.invoke('h3:status'),
        composePrompt: (spec) => ipcRenderer.invoke('h3:compose-prompt', spec),
        generate:   (params) => ipcRenderer.invoke('h3:generate', params),
        cancel:     () => ipcRenderer.invoke('h3:cancel'),
        freeGpu:    () => ipcRenderer.invoke('h3:free-gpu'),
        deleteOutput: (filePath) => ipcRenderer.invoke('h3:delete-output', filePath),
        readOutput: (filePath) => ipcRenderer.invoke('h3:read-output', filePath),
        // { type: 'status' | 'progress' | 'preview', phase, ... }
        onEvent: (callback) => {
            const listener = (_, data) => callback(data);
            ipcRenderer.on('h3:event', listener);
            return () => ipcRenderer.removeListener('h3:event', listener);
        },
    },

    // ── Result folders: open them in the file explorer ('media' | 'anime' | 'movies' | 'all') ──
    outputs: {
        paths: () => ipcRenderer.invoke('outputs:paths'),
        open:  (kind) => ipcRenderer.invoke('outputs:open', kind),
        saveCopy: (file, name) => ipcRenderer.invoke('outputs:save-copy', file, name),
    },

    // ── Movie maker: join clips and pictures into one finished movie (ffmpeg, local) ──
    movie: {
        status:  () => ipcRenderer.invoke('movie:status'),
        installFfmpeg: () => ipcRenderer.invoke('movie:install-ffmpeg'),
        onFfmpegProgress: (callback) => {
            const listener = (_, data) => callback(data);
            ipcRenderer.on('movie:ffmpeg-progress', listener);
            return () => ipcRenderer.removeListener('movie:ffmpeg-progress', listener);
        },
        options: () => ipcRenderer.invoke('movie:options'),
        fontBytes: () => ipcRenderer.invoke('movie:font-bytes'),
        editPicture: (params) => ipcRenderer.invoke('movie:edit-picture', params),
        probe:   (files) => ipcRenderer.invoke('movie:probe', files),
        render:  (project) => ipcRenderer.invoke('movie:render', project),
        cancel:  () => ipcRenderer.invoke('movie:cancel'),
        lastFrame: (file) => ipcRenderer.invoke('movie:last-frame', file),
        exportTitle: (params) => ipcRenderer.invoke('movie:export-title', params),
        upscale: (params) => ipcRenderer.invoke('movie:upscale', params),
        cancelUpscale: () => ipcRenderer.invoke('movie:upscale-cancel'),
        upscaleModels: () => ipcRenderer.invoke('movie:upscale-models'),
        library: () => ipcRenderer.invoke('movie:library'),
        importBytes: (payload) => ipcRenderer.invoke('movie:import-bytes', payload),
        url:     (file) => ipcRenderer.invoke('movie:url', file),
        readImage: (file) => ipcRenderer.invoke('movie:read-image', file),
        pick:    (kind) => ipcRenderer.invoke('movie:pick', kind),
        saveAs:  (file) => ipcRenderer.invoke('movie:save-as', file),
        reveal:  (file) => ipcRenderer.invoke('movie:reveal', file),
        // { type: 'status' | 'progress', progress: 0..1, message? }
        onEvent: (callback) => {
            const listener = (_, data) => callback(data);
            ipcRenderer.on('movie:event', listener);
            return () => ipcRenderer.removeListener('movie:event', listener);
        },
    },

    // Progress events — both engines emit on local-ai:progress
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:progress', listener);
        return () => ipcRenderer.removeListener('local-ai:progress', listener);
    },
    // What an AI assistant connected through MCP is doing: { phase: 'start' | 'result' | 'error', ... }
    onExternal: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:external', listener);
        return () => ipcRenderer.removeListener('local-ai:external', listener);
    },
    mcp: {
        get: () => ipcRenderer.invoke('mcp:get'),
        set: (patch) => ipcRenderer.invoke('mcp:set', patch),
    },
    onDownloadProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:download-progress', listener);
        return () => ipcRenderer.removeListener('local-ai:download-progress', listener);
    },
});
