import { t } from '../lib/i18n.js';

const MCP_URL = 'https://api.muapi.ai/mcp';
const DEEPSEEK_ENV = 'export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nexport ANTHROPIC_AUTH_TOKEN=<your DeepSeek API key>\nclaude --model sonnet   # the endpoint maps the name to a DeepSeek model';

const jsonBlock = (value) => JSON.stringify(value, null, 2);
// Clients that only start local programs reach a remote server through the mcp-remote bridge.
const bridged = (url, key) => ({ command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization:Bearer ${key}`] });

const MCP_CLIENTS = [
    {
        id: 'claude-code', label: 'Claude Code',
        where: 'Run in a terminal',
        build: (url, key) => `claude mcp add --transport http muapi ${url} \\\n  --header "Authorization: Bearer ${key}"`,
        note: 'Works the same when Claude Code runs on a DeepSeek model (see below).',
    },
    {
        id: 'claude-desktop', label: 'Claude Desktop',
        where: 'claude_desktop_config.json, then restart Claude Desktop',
        build: (url, key) => jsonBlock({ mcpServers: { muapi: bridged(url, key) } }),
        note: 'Needs Node.js (for npx). Settings → Developer → Edit Config opens the file.',
    },
    {
        id: 'cursor', label: 'Cursor',
        where: '~/.cursor/mcp.json',
        build: (url, key) => jsonBlock({ mcpServers: { muapi: { url, headers: { Authorization: `Bearer ${key}` } } } }),
        note: 'If your Cursor version does not take url/headers, use the "Any MCP client" snippet.',
    },
    {
        id: 'windsurf', label: 'Windsurf',
        where: '~/.codeium/windsurf/mcp_config.json',
        build: (url, key) => jsonBlock({ mcpServers: { muapi: bridged(url, key) } }),
        note: 'Uses the mcp-remote bridge, which works in every Windsurf version.',
    },
    {
        id: 'gemini', label: 'Gemini CLI',
        where: '~/.gemini/settings.json',
        build: (url, key) => jsonBlock({ mcpServers: { muapi: { httpUrl: url, headers: { Authorization: `Bearer ${key}` } } } }),
    },
    {
        id: 'cline', label: 'Cline / Roo Code (any model, e.g. DeepSeek)',
        where: 'MCP Servers → Configure MCP Servers (cline_mcp_settings.json)',
        build: (url, key) => jsonBlock({ mcpServers: { muapi: bridged(url, key) } }),
        note: 'Pick DeepSeek (or any other model) as the provider in the extension settings; the MCP server is independent of the model.',
    },
    {
        id: 'generic', label: 'Any MCP client',
        where: 'Add as a command-based (stdio) server',
        build: (url, key) => `npx -y mcp-remote ${url} --header "Authorization:Bearer ${key}"`,
        note: 'mcp-remote turns the hosted endpoint into a local stdio server, which every MCP client understands. No spaces after the colon in the header: some clients mangle them.',
    },
];

export function McpCliStudio() {
    const container = document.createElement('div');
    container.className = 'w-full h-full overflow-y-auto bg-app-bg text-white';

    const inner = document.createElement('div');
    inner.className = 'max-w-5xl mx-auto px-6 py-12 flex flex-col gap-12';
    container.appendChild(inner);

    // Hero
    const hero = document.createElement('section');
    hero.className = 'flex flex-col items-center text-center gap-4';
    hero.innerHTML = `
        <div class="px-3 py-1 rounded-full border border-white/10 bg-white/5 text-[11px] font-bold uppercase tracking-widest text-secondary">
            ${t('mcp.tagline')}
        </div>
        <h1 class="text-4xl md:text-5xl font-bold tracking-tight">${t('mcp.title')}</h1>
        <p class="text-secondary text-base md:text-lg max-w-2xl">
            ${t('mcp.subtitle')}
        </p>
    `;
    inner.appendChild(hero);

    inner.appendChild(localMcpSection());

    // Hosted muapi services are paid: collapsed and dimmed below the local server
    const paid = document.createElement('details');
    paid.className = 'rounded-2xl border border-white/5 opacity-70 hover:opacity-100 transition-opacity';
    paid.innerHTML = `
        <summary class="cursor-pointer select-none px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-secondary">
            Paid cloud services (muapi) — optional
        </summary>
    `;
    const paidBody = document.createElement('div');
    paidBody.className = 'flex flex-col gap-12 px-6 pb-8 pt-2';
    paid.appendChild(paidBody);
    inner.appendChild(paid);

    // Quick start
    const quick = document.createElement('section');
    quick.className = 'glass-panel rounded-2xl p-6 md:p-8 flex flex-col gap-4';
    quick.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="text-[11px] font-bold uppercase tracking-widest text-secondary">${t('mcp.quickStart')}</span>
            <div class="flex-1 h-px bg-white/5"></div>
        </div>
        <div class="grid md:grid-cols-3 gap-4">
            ${quickStep('1', 'Install the CLI', 'npm install -g muapi-cli')}
            ${quickStep('2', 'Sign in', 'muapi auth login')}
            ${quickStep('3', 'Generate from chat', 'npx skills add SamurAIGPT/muapi-skills')}
        </div>
    `;
    paidBody.appendChild(quick);

    // Feature cards
    const cards = document.createElement('section');
    cards.className = 'grid md:grid-cols-3 gap-4';

    cards.appendChild(featureCard({
        tag: 'CLI',
        title: 'muapi-cli',
        body: 'Generate images, videos, and audio from the terminal across 14+ AI models. Dual interface — colored human output plus JSON for agents (--output-json, --jq filtering). Async workflows, file uploads, credit tracking.',
        code: 'npm install -g muapi-cli\nmuapi image generate "a cyberpunk city" \\\n  --model flux-dev',
        link: 'https://github.com/SamurAIGPT/muapi-cli',
        linkLabel: 'View muapi-cli on GitHub',
        icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    }));

    cards.appendChild(featureCard({
        tag: 'MCP',
        title: 'muapi-mcp-server',
        body: 'Connect Claude, Cursor, Windsurf, and any MCP-compatible assistant to 100+ generative models. Hosted endpoint — no install. 19 structured tools with input/output schemas, async polling, and account management.',
        code: 'claude mcp add --transport http muapi \\\n  https://api.muapi.ai/mcp \\\n  --header "Authorization: Bearer YOUR_KEY"',
        link: 'https://github.com/SamurAIGPT/muapi-mcp-server',
        linkLabel: 'View muapi-mcp-server on GitHub',
        icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>`,
    }));

    cards.appendChild(featureCard({
        tag: 'Skills',
        title: 'Generative Media Skills',
        body: 'Multimodal toolkit for Claude Code, Cursor, and Gemini CLI. Cinema Director, Nano-Banana, UI Designer, Logo Creator, Seedance 2, AI Clipping, and YouTube Shorts presets. Agent-native with JSON outputs and semantic exit codes.',
        code: 'npx skills add SamurAIGPT/muapi-skills --all',
        link: 'https://github.com/SamurAIGPT/muapi-skills',
        linkLabel: 'View muapi-skills on GitHub',
        icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.39 4.84L20 8l-4 3.9.94 5.5L12 14.77 7.06 17.4 8 11.9 4 8l5.61-1.16L12 2z"/></svg>`,
    }));

    paidBody.appendChild(cards);

    // Usage examples
    const examples = document.createElement('section');
    examples.className = 'flex flex-col gap-4';
    examples.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="text-[11px] font-bold uppercase tracking-widest text-secondary">Examples</span>
            <div class="flex-1 h-px bg-white/5"></div>
        </div>
        <div class="grid md:grid-cols-2 gap-4">
            ${exampleBlock('Image generation', 'muapi image generate "a serene mountain lake at sunrise" \\\n  --model flux-dev --download ./outputs')}
            ${exampleBlock('Text-to-video', 'muapi video generate "a dog running on a beach" \\\n  --model kling-master')}
            ${exampleBlock('Audio creation', 'muapi audio create "upbeat lo-fi hip hop for studying"')}
            ${exampleBlock('Run a skill', 'bash library/visual/nano-banana/scripts/\\\n  generate-nano-art.sh --file image.jpg --view')}
        </div>
    `;
    paidBody.appendChild(examples);

    // Connect any AI client: one MCP endpoint, a ready-made config for each client
    const connect = document.createElement('section');
    connect.className = 'glass-panel rounded-2xl p-6 md:p-8 flex flex-col gap-6';
    connect.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="text-[11px] font-bold uppercase tracking-widest text-secondary">Connect your AI client</span>
            <div class="flex-1 h-px bg-white/5"></div>
        </div>
        <p class="text-[13px] text-secondary leading-relaxed">
            The MCP server is a standard remote (Streamable HTTP) endpoint, so it works with every MCP-capable client, whichever model runs behind it
            (Claude, DeepSeek, GPT, Gemini, Qwen, local models...). Pick your client and paste the snippet.
        </p>
        <div class="flex flex-col md:flex-row gap-4 items-end">
            <div class="flex flex-col gap-1.5 flex-1 w-full">
                <label class="text-[11px] font-bold tracking-wider uppercase text-secondary">Client</label>
                <select id="clientSelector" class="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30">
                    ${MCP_CLIENTS.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}
                </select>
            </div>
            <div class="flex flex-col gap-1.5 flex-1 w-full">
                <label class="text-[11px] font-bold tracking-wider uppercase text-secondary">API key (stays in this window, not saved)</label>
                <input id="mcpKeyInput" type="text" autocomplete="off" spellcheck="false" placeholder="YOUR_KEY" class="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-white/30">
            </div>
        </div>
        <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
                <span id="clientWhere" class="text-[12px] font-bold text-white/80"></span>
                <button id="copyClientBtn" type="button" class="px-3 py-1 rounded-md text-[11px] font-bold bg-white/5 text-secondary hover:bg-white/10 hover:text-white transition-colors">Copy</button>
            </div>
            <pre id="clientSnippet" class="text-[12px] font-mono text-primary bg-black/60 border border-white/5 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre"></pre>
            <p id="clientNote" class="text-[11px] text-secondary leading-relaxed"></p>
        </div>
        <div class="rounded-xl border border-white/5 bg-white/[0.02] p-5 flex flex-col gap-3">
            <span class="text-sm font-bold">Using DeepSeek (or another non-Claude model)</span>
            <p class="text-[12px] text-secondary leading-relaxed">
                DeepSeek models do not speak MCP on their own: the MCP support lives in the client you run. Three ways, from easiest:
            </p>
            <ol class="text-[12px] text-secondary leading-relaxed list-decimal pl-5 flex flex-col gap-2">
                <li><b class="text-white/80">Claude Code with the DeepSeek API.</b> DeepSeek offers an Anthropic-compatible endpoint; set it before starting Claude Code, then add the MCP server as above:
                    <pre class="mt-1.5 text-[11px] font-mono text-primary bg-black/40 rounded-md px-3 py-2 overflow-x-auto whitespace-pre">${escapeHtml(DEEPSEEK_ENV)}</pre></li>
                <li><b class="text-white/80">An MCP client that takes any model</b> (Cline, Roo Code, Continue, Cherry Studio, LibreChat): choose DeepSeek as the model with your DeepSeek API key, and add the MCP server from the snippet above.</li>
                <li><b class="text-white/80">No MCP at all:</b> any agent that can run shell commands can call the CLI. Add <code class="text-primary">--output-json</code> and it returns clean JSON.</li>
            </ol>
        </div>
    `;
    paidBody.appendChild(connect);

    const clientSel = connect.querySelector('#clientSelector');
    const keyInput = connect.querySelector('#mcpKeyInput');
    const whereEl = connect.querySelector('#clientWhere');
    const snippetEl = connect.querySelector('#clientSnippet');
    const noteEl = connect.querySelector('#clientNote');
    const copyBtn = connect.querySelector('#copyClientBtn');
    const renderClient = () => {
        const client = MCP_CLIENTS.find(c => c.id === clientSel.value) || MCP_CLIENTS[0];
        const out = client.build(MCP_URL, keyInput.value.trim() || 'YOUR_KEY');
        whereEl.textContent = client.where;
        snippetEl.textContent = out;
        noteEl.textContent = client.note || '';
    };
    clientSel.addEventListener('change', renderClient);
    keyInput.addEventListener('input', renderClient);
    copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(snippetEl.textContent); copyBtn.textContent = 'Copied'; } catch { copyBtn.textContent = 'Select and copy manually'; }
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    };
    renderClient();

    // NEW FEATURE: Interactive Command Generator Playground
    const playground = document.createElement('section');
    playground.className = 'glass-panel rounded-2xl p-6 md:p-8 flex flex-col gap-6';
    playground.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="text-[11px] font-bold uppercase tracking-widest text-secondary">Interactive Builder</span>
            <div class="flex-1 h-px bg-white/5"></div>
        </div>
        <div class="flex flex-col md:flex-row gap-4 items-end">
            <div class="flex flex-col gap-1.5 flex-1 w-full">
                <label class="text-[11px] font-bold tracking-wider uppercase text-secondary">Select Target Model</label>
                <select id="modelSelector" class="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30">
                    <option value="image generate 'a retro-futuristic synthwave car' --model flux-dev">FLUX.1 Dev (Image)</option>
                    <option value="image generate 'oil painting of an astronaut' --model midjourney">Midjourney (Image)</option>
                    <option value="video generate 'cinematic drone shot of an ancient castle' --model kling-master">Kling Master (Video)</option>
                    <option value="video generate 'cyberpunk neon alleyway rain' --model luma-ray">Luma Ray (Video)</option>
                    <option value="audio create 'ambient electronic space synth for gaming'">Lyria 3 (Audio)</option>
                </select>
            </div>
            <div class="flex flex-col gap-1.5 flex-1 w-full">
                <label class="text-[11px] font-bold tracking-wider uppercase text-secondary">Output Format</label>
                <select id="flagSelector" class="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30">
                    <option value="">Default (Human-Readable)</option>
                    <option value=" --output-json">JSON Object (AI Agent Native)</option>
                    <option value=" --output-json | jq '.data.url'">Filtered URL Stream (JQ)</option>
                </select>
            </div>
        </div>
        <div class="flex flex-col gap-2">
            <span class="text-[12px] font-bold text-white/80">Generated Terminal Command</span>
            <pre id="interactiveTerminal" class="text-[12px] font-mono text-primary bg-black/60 border border-white/5 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre"></pre>
        </div>
    `;
    paidBody.appendChild(playground);

    // Event listener block to power the dynamic playground execution
    const modelSel = playground.querySelector('#modelSelector');
    const flagSel = playground.querySelector('#flagSelector');
    const termDisp = playground.querySelector('#interactiveTerminal');

    const updateCommandDisplay = () => {
        termDisp.textContent = `muapi ${modelSel.value}${flagSel.value}`;
    };

    modelSel.addEventListener('change', updateCommandDisplay);
    flagSel.addEventListener('change', updateCommandDisplay);
    updateCommandDisplay(); // Run once immediately on build mount

    // Footer note
    const footer = document.createElement('p');
    footer.className = 'text-center text-xs text-secondary opacity-60 pb-4';
    footer.textContent = 'Open-source · MIT licensed · Works with Claude, DeepSeek, Cursor, Windsurf, Gemini CLI, Cline and any MCP client';
    inner.appendChild(footer);

    return container;
}

const LOCAL_NAME = 'open-generative-ai';
const LOCAL_TOOLS = [
    ['generate_image', 'Generate an image from a prompt (model, aspect ratio, seed, steps, negative prompt).'],
    ['edit_image', 'Change an existing image with a prompt.'],
    ['enhance_prompt', 'Rewrite a short prompt into a detailed one.'],
    ['list_models', 'List local models (image, edit, video, lipsync) and whether each is downloaded and runnable.'],
    ['recent_results', 'Show the latest generations.'],
    ['cancel_generation', 'Stop the generation in progress.'],
];
const LOCAL_CLIENTS = [
    { id: 'claude-code', label: 'Claude Code', where: 'Run in a terminal',
        build: (url, key) => `claude mcp add --transport http ${LOCAL_NAME} ${url} \\\n  --header "Authorization: Bearer ${key}"` },
    { id: 'cursor', label: 'Cursor', where: '~/.cursor/mcp.json',
        build: (url, key) => jsonBlock({ mcpServers: { [LOCAL_NAME]: { url, headers: { Authorization: `Bearer ${key}` } } } }) },
    { id: 'gemini', label: 'Gemini CLI', where: '~/.gemini/settings.json',
        build: (url, key) => jsonBlock({ mcpServers: { [LOCAL_NAME]: { httpUrl: url, headers: { Authorization: `Bearer ${key}` } } } }) },
    { id: 'claude-desktop', label: 'Claude Desktop / Windsurf / Cline (stdio only)', where: 'Their MCP JSON config file',
        build: (url, key) => jsonBlock({ mcpServers: { [LOCAL_NAME]: bridged(url, key) } }) },
    { id: 'generic', label: 'Any MCP client', where: 'Command-based (stdio) server',
        build: (url, key) => `npx -y mcp-remote ${url} --header "Authorization:Bearer ${key}"` },
];

// The server that runs inside this app, on this PC only. URL and token come live from the app.
function localMcpSection() {
    const section = document.createElement('section');
    section.className = 'glass-panel rounded-2xl p-6 md:p-8 flex flex-col gap-6';
    section.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="text-[11px] font-bold uppercase tracking-widest text-secondary">Local MCP server (this PC)</span>
            <div class="flex-1 h-px bg-white/5"></div>
            <span id="localMcpStatus" class="text-[11px] font-bold text-secondary"></span>
        </div>
        <p class="text-[13px] text-secondary leading-relaxed">
            This app runs its own MCP server over HTTP (Streamable HTTP, not stdio). It listens on <b class="text-white/80">127.0.0.1</b> only, so only programs on this PC can reach it,
            and every request needs the token below. Turn it on in Settings → Local Models.
        </p>
        <div class="grid md:grid-cols-2 gap-4">
            <div class="flex flex-col gap-1.5">
                <span class="text-[11px] font-bold tracking-wider uppercase text-secondary">URL</span>
                <pre id="localMcpUrl" class="text-[12px] font-mono text-primary bg-black/60 border border-white/5 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre"></pre>
            </div>
            <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                    <span class="text-[11px] font-bold tracking-wider uppercase text-secondary">Token (header Authorization: Bearer)</span>
                    <span class="flex gap-1">
                        <button id="localMcpReveal" type="button" class="px-2 py-0.5 rounded-md text-[11px] font-bold bg-white/5 text-secondary hover:bg-white/10 hover:text-white transition-colors">Show</button>
                        <button id="localMcpCopyToken" type="button" class="px-2 py-0.5 rounded-md text-[11px] font-bold bg-white/5 text-secondary hover:bg-white/10 hover:text-white transition-colors">Copy</button>
                    </span>
                </div>
                <pre id="localMcpToken" class="text-[12px] font-mono text-primary bg-black/60 border border-white/5 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre"></pre>
            </div>
        </div>
        <div class="flex flex-col gap-2">
            <span class="text-[11px] font-bold tracking-wider uppercase text-secondary">Tools</span>
            <ul class="grid md:grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] text-secondary leading-relaxed">
                ${LOCAL_TOOLS.map(([name, desc]) => `<li><code class="text-primary">${name}</code> — ${desc}</li>`).join('')}
            </ul>
        </div>
        <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1.5 w-full md:w-1/2">
                <label class="text-[11px] font-bold tracking-wider uppercase text-secondary">Connect a client</label>
                <select id="localMcpClient" class="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30">
                    ${LOCAL_CLIENTS.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}
                </select>
            </div>
            <div class="flex items-center justify-between gap-3">
                <span id="localMcpWhere" class="text-[12px] font-bold text-white/80"></span>
                <button id="localMcpCopy" type="button" class="px-3 py-1 rounded-md text-[11px] font-bold bg-white/5 text-secondary hover:bg-white/10 hover:text-white transition-colors">Copy</button>
            </div>
            <pre id="localMcpSnippet" class="text-[12px] font-mono text-primary bg-black/60 border border-white/5 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre"></pre>
            <p class="text-[11px] text-secondary leading-relaxed">
                The snippet contains the real token: treat it like a password. Another PC or phone cannot use the 127.0.0.1 address; that needs a tunnel, which exposes the server to the internet.
            </p>
        </div>
    `;

    const q = (id) => section.querySelector(id);
    const state = { url: 'http://127.0.0.1:47821/mcp', token: 'YOUR_TOKEN', shown: false, live: false };
    const mask = (s) => (s.length > 8 ? `${s.slice(0, 4)}${'•'.repeat(24)}${s.slice(-4)}` : s);
    const flash = (btn, label) => { const old = btn.textContent; btn.textContent = label; setTimeout(() => { btn.textContent = old; }, 1500); };
    const copy = async (btn, text) => {
        try { await navigator.clipboard.writeText(text); flash(btn, 'Copied'); } catch { flash(btn, 'Copy manually'); }
    };
    const snippet = () => {
        const client = LOCAL_CLIENTS.find(c => c.id === q('#localMcpClient').value) || LOCAL_CLIENTS[0];
        return { client, text: client.build(state.url, state.token) };
    };
    const render = () => {
        const { client, text } = snippet();
        q('#localMcpUrl').textContent = state.url;
        q('#localMcpToken').textContent = state.shown ? state.token : mask(state.token);
        q('#localMcpReveal').textContent = state.shown ? 'Hide' : 'Show';
        q('#localMcpWhere').textContent = client.where;
        q('#localMcpSnippet').textContent = state.shown ? text : text.split(state.token).join(mask(state.token));
    };

    q('#localMcpClient').addEventListener('change', render);
    q('#localMcpReveal').onclick = () => { state.shown = !state.shown; render(); };
    q('#localMcpCopyToken').onclick = (e) => copy(e.currentTarget, state.token);
    q('#localMcpCopy').onclick = (e) => copy(e.currentTarget, snippet().text);

    const showStatus = (s) => {
        const el = q('#localMcpStatus');
        el.textContent = !state.live ? 'Not available in the browser build'
            : s.running ? 'Running' : s.error ? `Error: ${s.error}` : 'Off';
        el.className = `text-[11px] font-bold ${s?.running ? 'text-green-400' : 'text-secondary'}`;
    };
    showStatus({});
    render();

    if (window.localAI?.mcp) {
        window.localAI.mcp.get().then((s) => {
            Object.assign(state, { url: s.url, token: s.token, live: true });
            showStatus(s);
            render();
        }).catch(() => {});
    }
    return section;
}

function quickStep(num, title, code) {
    return `
        <div class="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex flex-col gap-2">
            <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-full bg-white text-black text-xs font-bold flex items-center justify-center">${num}</span>
                <span class="text-sm font-bold">${title}</span>
            </div>
            <code class="text-[12px] font-mono text-primary bg-black/40 rounded-md px-2 py-1.5 break-all">${escapeHtml(code)}</code>
        </div>
    `;
}

function featureCard({ tag, title, body, code, link, linkLabel, icon }) {
    const card = document.createElement('a');
    card.href = link;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', linkLabel);
    card.className = 'glass-panel rounded-2xl p-6 flex flex-col gap-3 hover:bg-white/[0.04] transition-colors group';
    card.innerHTML = `
        <div class="flex items-center justify-between">
            <div class="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white">${icon}</div>
            <span class="text-[10px] font-bold uppercase tracking-widest text-secondary">${tag}</span>
        </div>
        <h3 class="text-lg font-bold">${title}</h3>
        <p class="text-[13px] text-secondary leading-relaxed">${body}</p>
        <pre class="text-[11px] font-mono text-primary bg-black/40 rounded-md px-3 py-2 overflow-x-auto whitespace-pre">${escapeHtml(code)}</pre>
        <div class="flex items-center gap-1 text-[12px] font-bold text-secondary group-hover:text-white transition-colors mt-auto">
            <span>View on GitHub</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
        </div>
    `;
    return card;
}

function exampleBlock(title, code) {
    return `
        <div class="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex flex-col gap-2">
            <span class="text-[12px] font-bold text-white/80">${title}</span>
            <pre class="text-[11px] font-mono text-primary bg-black/40 rounded-md px-3 py-2 overflow-x-auto whitespace-pre">${escapeHtml(code)}</pre>
        </div>
    `;
}

function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
