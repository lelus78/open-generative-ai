import { LocalModelManager } from './LocalModelManager.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { t } from '../lib/i18n.js';

export function SettingsModal(onClose) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:100;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card,#111);border-radius:1rem;border:1px solid rgba(255,255,255,0.08);width:min(90vw,36rem);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;';

    // ── Header ────────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;';
    header.innerHTML = `
        <h2 style="font-size:1rem;font-weight:800;color:#fff;margin:0;">${t('settings.title')}</h2>
        <button id="settings-close-btn" style="color:rgba(255,255,255,0.4);background:none;border:none;cursor:pointer;padding:4px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
    `;
    modal.appendChild(header);

    // ── Tabs ──────────────────────────────────────────────────────────────────
    // The desktop app is local-first: Local Models comes first and opens by default, the cloud API key is an optional extra.
    const localFirst = isLocalAIAvailable();
    const TABS = localFirst
        ? [{ id: 'local', label: t('settings.localModels') }, { id: 'api', label: `${t('settings.apiKey')} (optional)` }, { id: 'about', label: 'About' }]
        : [{ id: 'api', label: t('settings.apiKey') }];

    let activeTab = localFirst ? 'local' : 'api';

    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:0.25rem;padding:0.75rem 1.5rem 0;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;';

    const tabBtns = {};
    TABS.forEach(({ id, label }) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'padding:0.4rem 0.75rem;border-radius:0.5rem 0.5rem 0 0;font-size:0.75rem;font-weight:700;border:none;cursor:pointer;transition:all 0.15s;';
        btn.onclick = () => switchTab(id);
        tabBtns[id] = btn;
        tabBar.appendChild(btn);
    });
    modal.appendChild(tabBar);

    // ── Body ──────────────────────────────────────────────────────────────────
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:1.5rem;';
    modal.appendChild(body);

    // ── Tab: API Key ──────────────────────────────────────────────────────────
    const apiPanel = document.createElement('div');
    apiPanel.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:0.75rem;">
            <div>
                <label style="display:block;font-size:0.75rem;color:rgba(255,255,255,0.5);margin-bottom:0.4rem;font-weight:600;">${t('settings.muapiKeyLabel')}</label>
                <input id="settings-api-key" type="password"
                    style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.6rem 0.9rem;color:#fff;font-size:0.875rem;outline:none;"
                    placeholder="${t('settings.keyPlaceholder')}"
                    value="${localStorage.getItem('muapi_key') || ''}">
            </div>
            <p style="font-size:0.7rem;color:rgba(255,255,255,0.3);margin:0;">
                ${t('settings.keyNote')}
            </p>
            <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.5rem;">
                <button id="settings-cancel-btn" style="padding:0.5rem 1rem;border-radius:0.5rem;background:none;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-size:0.75rem;font-weight:700;cursor:pointer;">${t('common.cancel')}</button>
                <button id="settings-save-btn" style="padding:0.5rem 1rem;border-radius:0.5rem;background:var(--color-primary,#22d3ee);color:#000;font-size:0.75rem;font-weight:700;cursor:pointer;border:none;">${t('common.save')}</button>
            </div>
        </div>
    `;

    // ── Tab: Local Models ─────────────────────────────────────────────────────
    const localPanel = LocalModelManager();

    // ── Tab: About ────────────────────────────────────────────────────────────
    const aboutPanel = document.createElement('div');
    aboutPanel.style.cssText = 'display:flex;flex-direction:column;gap:0.9rem;font-size:0.8rem;color:rgba(255,255,255,0.7);';
    aboutPanel.innerHTML = `
        <div><div style="font-size:1.05rem;font-weight:800;color:#fff;">Open Generative AI — Local Edition</div>
        <div id="about-version" style="margin-top:0.2rem;color:rgba(255,255,255,0.5);">Version …</div></div>
        <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
            <button id="about-check" style="padding:0.45rem 0.9rem;border-radius:0.5rem;background:var(--color-primary,#22d3ee);color:#000;font-size:0.75rem;font-weight:700;border:none;cursor:pointer;">Check for updates</button>
            <span id="about-update" style="font-size:0.75rem;color:rgba(255,255,255,0.5);"></span>
        </div>
        <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
            <button id="about-report" style="padding:0.45rem 0.9rem;border-radius:0.5rem;background:rgba(255,255,255,0.08);color:#fff;font-size:0.75rem;font-weight:700;border:1px solid rgba(255,255,255,0.15);cursor:pointer;">🐞 Report a problem</button>
            <span id="about-report-note" style="font-size:0.72rem;color:rgba(255,255,255,0.45);">Opens a GitHub issue filled in with the version and the end of the debug log (home folder and user name removed). Nothing is sent until you submit it.</span>
        </div>
        <div style="line-height:1.6;">
            <a href="https://github.com/lelus78/open-generative-ai" target="_blank" style="color:var(--color-primary,#22d3ee);">github.com/lelus78/open-generative-ai</a> — source, releases, issues<br>
            <a href="https://github.com/lelus78/open-generative-ai/releases" target="_blank" style="color:var(--color-primary,#22d3ee);">Releases</a> ·
            <a href="https://github.com/lelus78/open-generative-ai/issues" target="_blank" style="color:var(--color-primary,#22d3ee);">Issues</a>
        </div>
        <div style="font-size:0.72rem;color:rgba(255,255,255,0.4);line-height:1.5;">MIT licence. A fork of Anil-matcha/Open-Generative-AI.</div>
    `;
    const aboutVersion = aboutPanel.querySelector('#about-version');
    const aboutUpdate = aboutPanel.querySelector('#about-update');
    const aboutApi = window.localAI;
    aboutApi?.about?.().then((a) => { aboutVersion.textContent = `Version ${a.version} · ${a.platform} · Electron ${a.electron}`; }).catch(() => {});
    const reportBtn = aboutPanel.querySelector('#about-report');
    if (!aboutApi?.debug?.report) reportBtn.parentElement.style.display = 'none';
    reportBtn.onclick = async () => {
        const note = aboutPanel.querySelector('#about-report-note');
        try {
            await aboutApi.debug.report();
            note.textContent = 'The issue form is open in your browser. The whole log is also on the clipboard, if the form needs more.';
        } catch (e) { note.textContent = `Could not open the report: ${e.message}`; }
    };
    aboutPanel.querySelector('#about-check').onclick = async () => {
        aboutUpdate.textContent = 'Checking…';
        const r = await aboutApi?.checkUpdate?.().catch((e) => ({ state: 'error', message: e.message }));
        aboutUpdate.textContent = !r ? '' : r.state === 'latest' ? 'You have the latest version.' : r.state === 'available' ? `Version ${r.version} is available.` : r.state === 'dev' ? 'Updates are checked in the installed app only.' : `Could not check: ${r.message}`;
    };

    // ── Tab switching ─────────────────────────────────────────────────────────
    const switchTab = (id) => {
        activeTab = id;
        body.innerHTML = '';

        TABS.forEach(({ id: tid }) => {
            const btn = tabBtns[tid];
            if (tid === id) {
                btn.style.background = 'rgba(255,255,255,0.08)';
                btn.style.color = '#fff';
            } else {
                btn.style.background = 'transparent';
                btn.style.color = 'rgba(255,255,255,0.4)';
            }
        });

        if (id === 'api') body.appendChild(apiPanel);
        if (id === 'local') body.appendChild(localPanel);
        if (id === 'about') body.appendChild(aboutPanel);
    };

    switchTab(activeTab);

    // ── API key save/cancel handlers ──────────────────────────────────────────
    const close = () => {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
        if (onClose) onClose();
    };

    apiPanel.querySelector('#settings-cancel-btn').onclick = close;
    apiPanel.querySelector('#settings-save-btn').onclick = () => {
        const key = apiPanel.querySelector('#settings-api-key').value.trim();
        if (key) {
            localStorage.setItem('muapi_key', key);
            close();
        } else {
            alert(t('settings.invalidKey'));
        }
    };

    header.querySelector('#settings-close-btn').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.appendChild(modal);
    return overlay;
}
