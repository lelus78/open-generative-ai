import { SettingsModal } from './SettingsModal.js';
import { createTranslateToggle } from '../lib/studioHelpers.js';
import { openDebugPanel, isDebugAvailable } from './DebugPanel.js';
import { t, getLang, setLang } from '../lib/i18n.js';

export function Header(navigate) {
    const header = document.createElement('header');
    header.className = 'w-full flex flex-col z-50 sticky top-0';


    // 2. Main Navigation Bar
    const navBar = document.createElement('div');
    navBar.className = 'w-full h-16 bg-black flex items-center justify-between px-4 md:px-6 border-b border-white/5 backdrop-blur-md bg-opacity-95';

    const leftPart = document.createElement('div');
    leftPart.className = 'flex items-center gap-8';

    // Logo
    const logoContainer = document.createElement('div');
    logoContainer.className = 'cursor-pointer hover:scale-110 transition-transform';
    logoContainer.innerHTML = `
        <div class="w-8 h-8 bg-white rounded-lg flex items-center justify-center p-1.5 shadow-lg">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="black"/>
                <path d="M2 17L12 22L22 17" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
    `;

    const menu = document.createElement('nav');
    menu.className = 'hidden lg:flex items-center gap-6 text-[13px] font-bold text-secondary';
    const items = [
        { label: t('nav.image'),   page: 'image' },
        { label: t('nav.video'),   page: 'video' },
        { label: t('nav.lipsync'), page: 'lipsync' },
        ...(window.localAI?.h3 ? [{ label: t('nav.anime'), page: 'anime' }] : []),
        ...(window.localAI?.movie ? [{ label: t('nav.movie'), page: 'movie' }] : []),
        { label: t('nav.cinema'),  page: 'cinema' },
        { label: t('nav.workflows'), page: 'workflows' },
        { label: t('nav.agents'),  page: 'agents' },
        { label: t('nav.mcpcli'),  page: 'mcp-cli' },
    ];

    items.forEach(({ label, page }, idx) => {
        const link = document.createElement('a');
        link.textContent = label;
        link.className = `hover:text-white transition-all cursor-pointer relative group ${idx === 0 ? 'text-white' : ''}`;
        link.dataset.page = page;

        if (idx === 0) {
            const dot = document.createElement('div');
            dot.className = 'absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-primary rounded-full';
            link.appendChild(dot);
        }

        link.onclick = () => {
            Array.from(menu.children).forEach(child => child.classList.remove('text-white'));
            link.classList.add('text-white');
            navigate(page);
        };

        menu.appendChild(link);
    });

    // Other studios can jump to a tab (e.g. Image → Anime): move the highlight with them.
    window.addEventListener('navigate', (e) => {
        const target = Array.from(menu.children).find(child => child.dataset.page === e.detail?.page);
        if (!target) return;
        Array.from(menu.children).forEach(child => child.classList.remove('text-white'));
        target.classList.add('text-white');
        const dot = menu.querySelector('.bg-primary.rounded-full');
        if (dot) target.appendChild(dot);
    });

    leftPart.appendChild(logoContainer);
    leftPart.appendChild(menu);

    const rightPart = document.createElement('div');
    rightPart.className = 'flex items-center gap-4';

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/10 bg-white/5 text-[13px] font-bold text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors';
    settingsBtn.title = t('web.settingsTitle');
    settingsBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>${t('nav.settings')}</span>
    `;
    settingsBtn.onclick = () => {
        document.body.appendChild(SettingsModal());
    };

    // Language toggle button
    const langBtn = document.createElement('button');
    const currentLang = getLang();
    langBtn.className = 'flex items-center px-3 py-1.5 rounded-md border border-white/10 bg-white/5 text-[13px] font-bold text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors';
    langBtn.title = currentLang === 'zh-CN' ? t('web.switchToEn') : t('web.switchToZh');
    langBtn.textContent = currentLang === 'zh-CN' ? 'EN' : '中文';
    langBtn.onclick = () => setLang(currentLang === 'zh-CN' ? 'en' : 'zh-CN');

    // Debug log (desktop app): what was sent to the local tools and why something failed. Also Ctrl+Shift+D.
    const debugBtn = document.createElement('button');
    debugBtn.className = 'flex items-center px-2.5 py-1.5 rounded-md border border-white/10 bg-white/5 text-[13px] text-white/60 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all';
    debugBtn.title = 'Debug log (Ctrl+Shift+D)';
    debugBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 2l1 2M14 2l-1 2"/></svg>';
    debugBtn.onclick = openDebugPanel;

    const translateBtn = createTranslateToggle({ compact: true });
    if (translateBtn) rightPart.appendChild(translateBtn);
    rightPart.appendChild(langBtn);
    if (isDebugAvailable()) rightPart.appendChild(debugBtn);
    rightPart.appendChild(settingsBtn);

    navBar.appendChild(leftPart);
    navBar.appendChild(rightPart);

    header.appendChild(navBar);

    return header;
}
