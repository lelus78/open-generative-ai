
import { muapi } from '../lib/muapi.js';
import { CameraControls } from './CameraControls.js';
import { buildNanoBananaPrompt, buildLocalCinemaPrompt, CAMERA_MAP, LENS_MAP, FOCAL_PERSPECTIVE, APERTURE_EFFECT } from '../lib/promptUtils.js';
import { AuthModal } from './AuthModal.js';
import { t, tf } from '../lib/i18n.js';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { LOCAL_MODEL_CATALOG } from '../lib/localModels.js';
import { sortByFit } from '../lib/fitBadge.js';
import { attachPromptHistory, attachImageCopy, saveHistory, removeGenerationFile, clearHistoryEntries, attachResultMenu, localProgressLabel } from '../lib/studioHelpers.js';
import { createHistoryPanel } from './HistoryPanel.js';

export function CinemaStudio() {
    const container = document.createElement('div');
    container.className = 'w-full h-full flex flex-col items-center justify-center bg-black relative overflow-hidden';

    // --- State ---
    const currentSettings = {
        prompt: '',
        aspect_ratio: '16:9',
        camera: Object.keys(CAMERA_MAP)[0],
        lens: Object.keys(LENS_MAP)[0],
        focal: 35,
        aperture: "f/1.4"
    };
    
    // Camera builder panel state
    let showCameraBuilder = false;

    // ==========================================
    // 1. HERO SECTION (Empty State)
    // ==========================================
    const heroSection = document.createElement('div');
    heroSection.className = 'flex flex-col items-center justify-center text-center px-4 animate-fade-in-up';
    heroSection.innerHTML = `
        <div class="mb-4 text-xs font-bold text-white/40 tracking-[0.2em] uppercase">${t('cinema.tagline')}</div>
        <h1 class="text-4xl md:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-b from-white to-white/50 tracking-tight leading-tight mb-2">
            ${t('cinema.headline')}
        </h1>
    `;
    container.appendChild(heroSection);

    // ==========================================
    // 2. CAMERA CONTROLS OVERLAY
    // ==========================================
    const overlayBackdrop = document.createElement('div');
    overlayBackdrop.className = 'fixed inset-0 bg-black/80 backdrop-blur-md z-40 opacity-0 pointer-events-none transition-opacity duration-300 flex items-center justify-center';

    const overlayContent = document.createElement('div');
    // Reduced padding for mobile (p-4) and added max-height/overflow handling
    overlayContent.className = 'w-full max-w-4xl bg-[#141414] border border-white/10 rounded-3xl p-4 md:p-8 shadow-2xl transform scale-95 transition-transform duration-300 flex flex-col max-h-[90vh]';
    overlayBackdrop.appendChild(overlayContent);

    // Header for Overlay
    const overlayHeader = document.createElement('div');
    overlayHeader.className = 'flex items-center justify-between mb-8';
    overlayHeader.innerHTML = `
        <div class="flex gap-4">
            <button class="px-4 py-2 bg-white text-black text-xs font-bold rounded-full">All</button>
        </div>
        <button id="close-overlay-btn" class="text-white/50 hover:text-white transition-colors">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
    `;
    overlayContent.appendChild(overlayHeader);

    // Controls Component
    const cameraControls = CameraControls((state) => {
        currentSettings.camera = state.camera;
        currentSettings.lens = state.lens;
        currentSettings.focal = state.focal;
        currentSettings.aperture = state.aperture;
        updateSummaryCard();
    });
    overlayContent.appendChild(cameraControls);

    document.body.appendChild(overlayBackdrop); // Append to body to sit above everything

    // Overlay Logic
    const openOverlay = () => {
        overlayBackdrop.classList.remove('opacity-0', 'pointer-events-none');
        overlayContent.classList.remove('scale-95');
        overlayContent.classList.add('scale-100');
    };
    const closeOverlay = () => {
        overlayBackdrop.classList.add('opacity-0', 'pointer-events-none');
        overlayContent.classList.add('scale-95');
        overlayContent.classList.remove('scale-100');
    };
    overlayContent.querySelector('#close-overlay-btn').onclick = closeOverlay;
    overlayBackdrop.onclick = (e) => { if (e.target === overlayBackdrop) closeOverlay(); };


    // ==========================================
    // 3. FLOATING PROMPT BAR
    // ==========================================
    const promptBarWrapper = document.createElement('div');
    promptBarWrapper.className = 'absolute bottom-8 left-4 right-4 md:left-1/2 md:-translate-x-1/2 md:w-full md:max-w-4xl z-30';

    const promptBar = document.createElement('div');
    promptBar.className = 'bg-[#1a1a1a] border border-white/10 rounded-[2rem] p-4 flex justify-between shadow-3xl items-end relative';

    // --- LEFT COLUMN (Input + Settings) ---
    const leftColumn = document.createElement('div');
    leftColumn.className = 'flex-1 flex flex-col gap-3 min-h-[80px] justify-between py-1 px-1';

    // 1. Input Area
    const inputRow = document.createElement('div');
    inputRow.className = 'flex items-start gap-3 w-full';



    // Textarea
    const textarea = document.createElement('textarea');
    textarea.placeholder = t('cinema.placeholder');
    textarea.className = 'flex-1 bg-transparent border-none text-white text-lg font-medium placeholder:text-white/20 focus:outline-none resize-none h-[28px] leading-relaxed overflow-hidden';
    textarea.style.height = 'auto'; // Auto-grow check
    textarea.rows = 1;
    textarea.oninput = function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    };
    inputRow.appendChild(textarea);
    const promptHistory = attachPromptHistory(textarea, 'cinema_prompt_history');

    // ── Local (desktop app) image models ──
    // The shot is composed into one text prompt, so any local text-to-image model can render it.
    let useLocalModel = false;
    let localInfo = new Map(); // id → model info (state / fit / readiness) from the desktop app
    let selectedLocalModel = null;
    try { selectedLocalModel = localStorage.getItem('cinema_local_model'); } catch { /* storage unavailable */ }
    const localImageModels = isLocalAIAvailable() ? LOCAL_MODEL_CATALOG.filter(m => m.type !== 'video') : [];

    // sd.cpp models must already be on disk (they download from Settings); Wan2GP ones may download on first use.
    const isLocalUsable = (m) => {
        const info = localInfo.get(m.id);
        if (!info) return false;
        if (info.fit === 'unfit') return false;
        if (m.provider === 'wan2gp') return info.ready !== false;
        const aux = info.auxiliaryStatus || {};
        return info.state === 'downloaded' && (!info.requiresAuxiliary || (aux.llm === 'downloaded' && aux.vae === 'downloaded'));
    };
    const usableLocalModels = () => sortByFit(localImageModels.filter(isLocalUsable), m => localInfo.get(m.id));
    const refreshLocalInfo = async () => {
        try {
            localInfo = new Map((await localAI.listModels()).map(m => [m.id, m]));
        } catch (err) {
            console.warn('[CinemaStudio] Could not read local models:', err);
        }
    };

    leftColumn.appendChild(inputRow);

    // 2. Settings Toolbar (Bottom Left)
    // 2. Settings Toolbar (Bottom Left)
    const settingsToolbar = document.createElement('div');
    settingsToolbar.className = 'flex items-center gap-3'; // Removed pl-11 to align left

    // Helper: Create Dropdown
    const createDropdown = (items, selected, onSelect, trigger) => {
        const existing = document.querySelectorAll('.custom-dropdown');
        existing.forEach(el => el.remove());

        const rect = trigger.getBoundingClientRect();
        const menu = document.createElement('div');
        menu.className = 'custom-dropdown fixed bg-[#1a1a1a] border border-white/10 rounded-xl py-1 shadow-2xl z-50 flex flex-col min-w-[100px] animate-fade-in';
        menu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        menu.style.left = rect.left + 'px';

        items.forEach(item => {
            const btn = document.createElement('button');
            btn.className = `px-3 py-2 text-xs font-bold text-left hover:bg-white/10 transition-colors ${item === selected ? 'text-primary' : 'text-white'}`;
            btn.textContent = item;
            btn.onclick = (e) => {
                e.stopPropagation();
                onSelect(item);
                menu.remove();
            };
            menu.appendChild(btn);
        });

        const closeHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== trigger) {
                menu.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
        document.body.appendChild(menu);
    };

    // Aspect Ratio
    const arBtn = document.createElement('button');
    arBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold text-white/50 hover:text-white transition-colors bg-white/5 hover:bg-white/10 rounded-lg border border-white/5';
    const updateArBtn = () => {
        arBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="10" rx="2" ry="2"/></svg> ${currentSettings.aspect_ratio}`;
    };
    updateArBtn();
    arBtn.onclick = () => {
        createDropdown(['16:9', '21:9', '9:16', '1:1', '4:5'], currentSettings.aspect_ratio, (val) => {
            currentSettings.aspect_ratio = val;
            updateArBtn();
        }, arBtn);
    };
    settingsToolbar.appendChild(arBtn);

    // Resolution
    const resBtn = document.createElement('button');
    resBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold text-white/50 hover:text-white transition-colors bg-white/5 hover:bg-white/10 rounded-lg border border-white/5';
    const updateResBtn = (val) => {
        resBtn.dataset.value = val || '2K';
        resBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg> ${resBtn.dataset.value}`;
    };
    updateResBtn('2K');
    resBtn.onclick = () => {
        createDropdown(['1K', '2K', '4K'], resBtn.dataset.value, (val) => { updateResBtn(val); }, resBtn);
    };
    settingsToolbar.appendChild(resBtn);
    
    // Camera Builder Toggle Button
    const cameraBuilderBtn = document.createElement('button');
    cameraBuilderBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold text-white/50 hover:text-white transition-colors bg-white/5 hover:bg-white/10 rounded-lg border border-white/5';
    cameraBuilderBtn.setAttribute('data-tooltip', t('cinema.builderTooltip'));
    cameraBuilderBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg> Builder`;
    settingsToolbar.appendChild(cameraBuilderBtn);

    if (isLocalAIAvailable()) {
        const toolbarBtnClass = 'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold transition-colors rounded-lg border';
        const localToggleBtn = document.createElement('button');
        const localModelBtn = document.createElement('button');
        localModelBtn.className = `${toolbarBtnClass} text-white/70 hover:text-white bg-white/5 hover:bg-white/10 border-white/5`;
        localModelBtn.style.display = 'none';

        const updateLocalModelBtn = () => {
            const model = localImageModels.find(m => m.id === selectedLocalModel);
            localModelBtn.textContent = model ? model.name : t('cinema.noLocalModel');
        };
        const updateLocalToggle = () => {
            localToggleBtn.className = `${toolbarBtnClass} ${useLocalModel ? 'bg-primary/20 border-primary/40 text-primary' : 'bg-white/5 border-white/5 text-white/50 hover:text-white hover:bg-white/10'}`;
            localToggleBtn.textContent = useLocalModel ? t('image.local') : t('image.api');
            resBtn.style.display = useLocalModel ? 'none' : '';      // 1K/2K/4K is a cloud option
            localModelBtn.style.display = useLocalModel ? '' : 'none';
        };
        const pickDefaultLocalModel = () => {
            const usable = usableLocalModels();
            if (!usable.some(m => m.id === selectedLocalModel)) selectedLocalModel = usable[0]?.id || null;
            updateLocalModelBtn();
        };

        localToggleBtn.onclick = async (e) => {
            e.stopPropagation();
            useLocalModel = !useLocalModel;
            try { localStorage.setItem('cinema_use_local', useLocalModel ? '1' : '0'); } catch { /* storage unavailable */ }
            updateLocalToggle();
            if (useLocalModel) {
                await refreshLocalInfo();
                pickDefaultLocalModel();
            }
        };
        localModelBtn.onclick = async (e) => {
            e.stopPropagation();
            await refreshLocalInfo();
            const usable = usableLocalModels();
            if (!usable.length) { alert(t('cinema.noLocalModelHelp')); return; }
            const label = (m) => {
                const info = localInfo.get(m.id);
                return `${m.name}${info?.fit === 'heavy' ? ' · heavy' : ''}${info?.needsDownload ? ` · ↓ ~${info.downloadGB ?? '?'} GB` : ''}`;
            };
            const byLabel = new Map(usable.map(m => [label(m), m]));
            const current = usable.find(m => m.id === selectedLocalModel);
            createDropdown([...byLabel.keys()], current ? label(current) : '', (picked) => {
                selectedLocalModel = byLabel.get(picked).id;
                try { localStorage.setItem('cinema_local_model', selectedLocalModel); } catch { /* storage unavailable */ }
                updateLocalModelBtn();
            }, localModelBtn);
        };

        updateLocalToggle();
        updateLocalModelBtn();
        settingsToolbar.insertBefore(localModelBtn, settingsToolbar.firstChild);
        settingsToolbar.insertBefore(localToggleBtn, settingsToolbar.firstChild);

        // Reopen in the mode used last time (needs the container mounted, so wait for it).
        const restoreLastMode = (tries = 40) => {
            if (!container.isConnected) { if (tries > 0) setTimeout(() => restoreLastMode(tries - 1), 50); return; }
            let wasLocal = false;
            try { wasLocal = localStorage.getItem('cinema_use_local') === '1'; } catch { /* storage unavailable */ }
            if (wasLocal && !useLocalModel) localToggleBtn.onclick({ stopPropagation() {} });
        };
        setTimeout(restoreLastMode, 0);
    }

    leftColumn.appendChild(settingsToolbar);
    promptBar.appendChild(leftColumn);


    // --- RIGHT GROUP (Summary + Generate) ---
    const rightGroup = document.createElement('div');
    rightGroup.className = 'flex items-center gap-2 h-full self-end mb-1';

    // Summary Card (Triggers Overlay)
    const summaryCard = document.createElement('button');
    // Removed 'hidden' class, added 'flex' and refined width constraints for mobile
    summaryCard.className = 'flex flex-col items-start justify-center px-4 py-2 bg-[#2a2a2a] rounded-xl border border-white/5 hover:border-white/20 transition-colors text-left flex-1 min-w-[100px] md:min-w-[140px] max-w-[240px] h-[56px] relative group overflow-hidden';
    summaryCard.setAttribute('data-tooltip', t('cinema.cameraSettings'));

    // Dot indicator
    const dot = document.createElement('div');
    dot.className = 'absolute top-2 right-2 w-2 h-2 bg-primary rounded-full shadow-glow-sm';
    summaryCard.appendChild(dot);

    const summaryTitle = document.createElement('span');
    summaryTitle.className = 'text-[10px] font-bold text-white uppercase truncate w-full tracking-wide';
    summaryTitle.textContent = currentSettings.camera;

    const summaryValue = document.createElement('span');
    summaryValue.className = 'text-[10px] font-medium text-white/60 truncate w-full';
    summaryValue.textContent = formatSummaryValue();

    summaryCard.appendChild(summaryTitle);
    summaryCard.appendChild(summaryValue);

    summaryCard.onclick = openOverlay;

    function formatSummaryValue() {
        return `${currentSettings.lens}, ${currentSettings.focal}mm, ${currentSettings.aperture}`;
    }

    function updateSummaryCard() {
        summaryTitle.textContent = currentSettings.camera;
        summaryValue.textContent = formatSummaryValue();
    }

    // Generate Button
    const generateBtn = document.createElement('button');
    generateBtn.className = 'h-[56px] px-8 bg-[#22d3ee] text-black rounded-xl font-black text-xs uppercase hover:bg-white transition-colors shadow-lg disabled:opacity-50 disabled:cursor-not-allowed';
    generateBtn.setAttribute('data-tooltip', 'Generate cinema shot');
    generateBtn.innerHTML = t('cinema.generateBtn');

    rightGroup.appendChild(summaryCard);
    rightGroup.appendChild(generateBtn);
    promptBar.appendChild(rightGroup);

    promptBarWrapper.appendChild(promptBar);
    container.appendChild(promptBarWrapper);

    // ==========================================
    // 3B. CAMERA BUILDER PANEL (Collapsible)
    // ==========================================
    const cameraBuilderPanel = document.createElement('div');
    cameraBuilderPanel.className = 'absolute bottom-8 left-4 right-4 md:left-1/2 md:-translate-x-1/2 md:w-full md:max-w-4xl z-20';
    cameraBuilderPanel.style.display = 'none'; // Hidden by default
    
    const builderCard = document.createElement('div');
    builderCard.className = 'bg-[#1a1a1a] border border-white/10 rounded-2xl p-4 shadow-3xl';
    
    builderCard.innerHTML = `
        <div class="flex items-center justify-between mb-4">
            <h4 class="text-xs font-bold text-white">${t('cinema.cameraBuilder')}</h4>
            <button id="close-builder-btn" class="text-white/40 hover:text-white transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-bold text-muted uppercase">${t('cinema.camera')}</label>
                <select id="builder-camera" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50">
                    ${Object.keys(CAMERA_MAP).map(c => `<option value="${c}" ${c === currentSettings.camera ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
            </div>
            <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-bold text-muted uppercase">${t('cinema.lens')}</label>
                <select id="builder-lens" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50">
                    ${Object.keys(LENS_MAP).map(l => `<option value="${l}" ${l === currentSettings.lens ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>
            <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-bold text-muted uppercase">${t('cinema.focal')}</label>
                <select id="builder-focal" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50">
                    ${Object.keys(FOCAL_PERSPECTIVE).map(f => `<option value="${f}" ${f === currentSettings.focal ? 'selected' : ''}>${f}mm</option>`).join('')}
                </select>
            </div>
            <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-bold text-muted uppercase">${t('cinema.aperture')}</label>
                <select id="builder-aperture" class="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50">
                    ${Object.keys(APERTURE_EFFECT).map(a => `<option value="${a}" ${a === currentSettings.aperture ? 'selected' : ''}>${a}</option>`).join('')}
                </select>
            </div>
        </div>

        <div class="flex flex-col gap-2">
            <label class="text-[10px] font-bold text-muted uppercase">${t('cinema.preview')}</label>
            <div id="builder-preview" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white text-xs min-h-[40px]"></div>
            <button id="apply-builder-btn" class="px-4 py-2 bg-primary text-black rounded-lg text-xs font-bold hover:shadow-glow transition-all">
                ${t('cinema.useSetup')}
            </button>
        </div>
    `;
    
    cameraBuilderPanel.appendChild(builderCard);
    container.appendChild(cameraBuilderPanel);
    
    // Camera Builder toggle logic
    cameraBuilderBtn.onclick = () => {
        showCameraBuilder = !showCameraBuilder;
        cameraBuilderPanel.style.display = showCameraBuilder ? 'block' : 'none';
        if (showCameraBuilder) updateBuilderPreview();
    };
    
    const closeBuilderBtn = cameraBuilderPanel.querySelector('#close-builder-btn');
    if (closeBuilderBtn) closeBuilderBtn.onclick = () => {
        showCameraBuilder = false;
        cameraBuilderPanel.style.display = 'none';
    };
    
    // Update builder preview
    const updateBuilderPreview = () => {
        const camera = builderCard.querySelector('#builder-camera')?.value || currentSettings.camera;
        const lens = builderCard.querySelector('#builder-lens')?.value || currentSettings.lens;
        const focal = parseInt(builderCard.querySelector('#builder-focal')?.value || currentSettings.focal);
        const aperture = builderCard.querySelector('#builder-aperture')?.value || currentSettings.aperture;
        
        const preview = buildNanoBananaPrompt('', camera, lens, focal, aperture);
        const previewEl = builderCard.querySelector('#builder-preview');
        if (previewEl) {
            previewEl.textContent = preview || t('cinema.selectSettings');
        }
    };
    
    // Builder event listeners
    const builderCamera = builderCard.querySelector('#builder-camera');
    const builderLens = builderCard.querySelector('#builder-lens');
    const builderFocal = builderCard.querySelector('#builder-focal');
    const builderAperture = builderCard.querySelector('#builder-aperture');
    
    if (builderCamera) builderCamera.onchange = updateBuilderPreview;
    if (builderLens) builderLens.onchange = updateBuilderPreview;
    if (builderFocal) builderFocal.onchange = updateBuilderPreview;
    if (builderAperture) builderAperture.onchange = updateBuilderPreview;
    
    const applyBuilderBtn = builderCard.querySelector('#apply-builder-btn');
    if (applyBuilderBtn) {
        applyBuilderBtn.onclick = () => {
            currentSettings.camera = builderCamera?.value || currentSettings.camera;
            currentSettings.lens = builderLens?.value || currentSettings.lens;
            currentSettings.focal = parseInt(builderFocal?.value || currentSettings.focal);
            currentSettings.aperture = builderAperture?.value || currentSettings.aperture;
            updateSummaryCard();
            showCameraBuilder = false;
            cameraBuilderPanel.style.display = 'none';
        };
    }


    // ==========================================
    // 3. HISTORY SIDEBAR
    // ==========================================
    const generationHistory = [];

    // History Sidebar - VISIBLE BY DEFAULT (removed translate-x-full opacity-0)
    const historyPanel = createHistoryPanel({
        host: container,
        mediaType: 'image',
        entries: () => generationHistory,
        getActiveUrl: () => resultImg.src,
        getModelLabel: (e) => {
            const id = String(e.model || 'nano-banana-pro');
            if (id.startsWith('local:')) return LOCAL_MODEL_CATALOG.find(m => m.id === id.slice(6))?.name || id.slice(6);
            return 'Nano Banana Pro';
        },
        onOpen: (e) => loadHistoryItem(e), // restores prompt and camera settings too
        onDelete: (e) => deleteEntry(e),
        onDownload: async (e) => {
            try {
                const blobUrl = URL.createObjectURL(await (await fetch(e.url)).blob());
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = `cinema-shot-${e.timestamp || Date.now()}.jpg`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            } catch { window.open(e.url, '_blank'); }
        },
        onClearAll: async () => {
            await clearHistoryEntries(generationHistory, 'cinema_history', 50);
            renderHistory();
            resetToPrompt();
        },
    });
    const historySidebar = historyPanel.element;
    container.appendChild(historySidebar);

    // ==========================================
    // 4. CANVAS AREA (Result View)
    // ==========================================
    const canvas = document.createElement('div');
    canvas.className = 'absolute inset-0 flex flex-col items-center justify-center p-4 min-[800px]:p-16 z-30 opacity-0 pointer-events-none transition-all duration-1000 translate-y-10 scale-95 bg-black/90 backdrop-blur-3xl';

    const imageContainer = document.createElement('div');
    imageContainer.className = 'relative group max-w-full max-h-[70vh] flex items-center justify-center';

    const resultImg = document.createElement('img');
    resultImg.className = 'max-h-[60vh] max-w-[90vw] rounded-2xl shadow-2xl border border-white/10 object-contain';
    imageContainer.appendChild(resultImg);
    canvas.appendChild(imageContainer);

    // Canvas Controls
    const canvasControls = document.createElement('div');
    canvasControls.className = 'mt-8 flex gap-3 opacity-0 transition-opacity delay-500 duration-500 justify-center';

    const createActionBtn = (label, primary = false) => {
        const btn = document.createElement('button');
        btn.className = primary
            ? 'bg-[#22d3ee] text-black px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-wide hover:bg-white transition-colors shadow-glow-sm hover:scale-105 active:scale-95'
            : 'bg-white/10 hover:bg-white/20 px-6 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide transition-all border border-white/5 backdrop-blur-lg text-white hover:border-white/20';
        btn.textContent = label;
        return btn;
    };

    const regenerateBtn = createActionBtn(t('cinema.regenerate'));
    const downloadBtn = createActionBtn(t('cinema.download'), true);
    const copyBtn = createActionBtn(t('common.copy'));
    const deleteBtn = createActionBtn(t('common.delete'));
    deleteBtn.className = deleteBtn.className.replace('text-white', 'text-red-400');
    const newPromptBtn = createActionBtn(t('cinema.newShot'));

    canvasControls.appendChild(regenerateBtn);
    canvasControls.appendChild(downloadBtn);
    canvasControls.appendChild(copyBtn);
    canvasControls.appendChild(deleteBtn);
    canvasControls.appendChild(newPromptBtn);
    canvas.appendChild(canvasControls);

    container.appendChild(canvas);

    // --- History Logic ---
    // Remove a result: its file on disk (local Wan2GP), its history entry, and the full-screen view if open.
    const deleteEntry = async (entry) => {
        if (entry.path && !confirm(t('common.deleteResultConfirm'))) return;
        try {
            await removeGenerationFile(entry);
        } catch (err) {
            alert(err.message);
            return;
        }
        const index = generationHistory.indexOf(entry);
        if (index >= 0) generationHistory.splice(index, 1);
        saveHistory('cinema_history', generationHistory, 50);
        renderHistory();
        if (resultImg.src === entry.url) resetToPrompt();
    };
    attachResultMenu(resultImg, [regenerateBtn, downloadBtn, copyBtn, deleteBtn, newPromptBtn]);
    deleteBtn.onclick = () => {
        const entry = generationHistory.find(e => e.url === resultImg.src);
        if (entry) deleteEntry(entry);
        else resetToPrompt();
    };

    const renderHistory = () => historyPanel.render();

    const addToHistory = (entry) => {
        generationHistory.unshift(entry);
        saveHistory('cinema_history', generationHistory, 50);
        renderHistory();
    };

    const loadHistoryItem = (entry) => {
        // Restore Settings
        if (entry.settings) {
            currentSettings.camera = entry.settings.camera;
            currentSettings.lens = entry.settings.lens;
            currentSettings.focal = entry.settings.focal;
            currentSettings.aperture = entry.settings.aperture;
            currentSettings.aspect_ratio = entry.settings.aspect_ratio;

            // Update UI elements
            textarea.value = entry.settings.prompt || '';
            updateSummaryCard();
            updateArBtn();
            updateResBtn(entry.settings.resolution || '2K');
        }

        showCanvas(entry.url);

    };

    const showCanvas = (url) => {
        resultImg.src = url;

        // Hide Input UI
        heroSection.classList.add('opacity-0', 'pointer-events-none', 'scale-95');
        promptBarWrapper.classList.add('opacity-0', 'pointer-events-none', 'translate-y-20');

        // Show Canvas
        canvas.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
        canvas.classList.add('opacity-100', 'translate-y-0', 'scale-100');
        canvasControls.classList.remove('opacity-0');
        canvasControls.classList.add('opacity-100');
    };

    const resetToPrompt = () => {
        // Hide Canvas
        canvas.classList.add('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
        canvas.classList.remove('opacity-100', 'translate-y-0', 'scale-100');

        // Show Input UI
        heroSection.classList.remove('opacity-0', 'pointer-events-none', 'scale-95');
        promptBarWrapper.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-20');

        // The prompt stays so it can be tweaked and shot again (Regenerate relies on it too).
        textarea.focus();
    };

    // Load saved history
    try {
        const saved = JSON.parse(localStorage.getItem('cinema_history') || '[]');
        if (saved.length > 0) {
            saved.forEach(e => generationHistory.push(e));
            renderHistory();
        }
    } catch (e) { }

    // Actions
    attachImageCopy({
        button: copyBtn,
        getSrc: () => resultImg.src,
        isVisible: () => canvas.classList.contains('opacity-100'),
        container,
        label: t('common.copy'),
        doneLabel: t('common.copied'),
    });
    newPromptBtn.onclick = resetToPrompt;

    regenerateBtn.onclick = () => {
        resetToPrompt();
        setTimeout(() => {
            generateBtn.click();
        }, 300);
    };

    downloadBtn.onclick = async () => {
        try {
            const response = await fetch(resultImg.src);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `cinema-shot-${Date.now()}.jpg`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch (err) {
            window.open(resultImg.src, '_blank');
        }
    };

    // ==========================================
    // 5. GENERATION LOGIC UPDATE
    // ==========================================
    generateBtn.onclick = async () => {
        const basePrompt = textarea.value.trim();
        if (!basePrompt) return;
        promptHistory.remember(basePrompt);

        if (!useLocalModel) {
            const apiKey = localStorage.getItem('muapi_key');
            if (!apiKey) {
                AuthModal(() => generateBtn.click());
                return;
            }
        }

        // Local model: make sure one is ready, and never start a multi-GB download without asking.
        if (useLocalModel) {
            await refreshLocalInfo();
            if (!usableLocalModels().some(m => m.id === selectedLocalModel)) selectedLocalModel = usableLocalModels()[0]?.id || null;
            const model = localImageModels.find(m => m.id === selectedLocalModel);
            if (!model) { alert(t('cinema.noLocalModelHelp')); return; }
            const info = localInfo.get(model.id);
            if (info?.needsDownload && !confirm(tf('fit.confirmDownload', model.name, info.downloadGB ?? '?'))) return;
        }

        generateBtn.disabled = true;
        generateBtn.innerHTML = t('cinema.shooting');

        // Compile Prompt
        // Cloud models read camera terms as photographic style; local ones would draw the camera itself.
        const compilePrompt = useLocalModel ? buildLocalCinemaPrompt : buildNanoBananaPrompt;
        let finalPrompt = compilePrompt(
            basePrompt,
            currentSettings.camera,
            currentSettings.lens,
            currentSettings.focal,
            currentSettings.aperture
        );

        let unsubscribeProgress = null;
        try {
            if (useLocalModel) {
                unsubscribeProgress = localAI.onProgress((event) => {
                    generateBtn.innerHTML = localProgressLabel(event);
                });
            }
            // Translate only the user's subject, then compose the look around the English text.
            let translatedPrompt = null;
            if (useLocalModel) {
                const translation = await localAI.translatePrompt(basePrompt);
                translatedPrompt = translation.translatedPrompt;
                finalPrompt = buildLocalCinemaPrompt(translation.text, currentSettings.camera, currentSettings.lens, currentSettings.focal, currentSettings.aperture);
            }
            const res = useLocalModel ? await localAI.generate({
                model: selectedLocalModel,
                prompt: finalPrompt,
                negative_prompt: 'blurry, low quality, distortion, bad composition, camera, tripod, film crew, photographer',
                aspect_ratio: currentSettings.aspect_ratio,
            }) : await muapi.generateImage({
                model: 'nano-banana-pro',
                prompt: finalPrompt,
                aspect_ratio: currentSettings.aspect_ratio,
                resolution: (resBtn.dataset.value || '1k').toLowerCase(),
                negative_prompt: "blurry, low quality, distortion, bad composition"
            });

            if (res && res.url) {
                // Save to history
                addToHistory({
                    url: res.url,
                    path: res.path, // file on disk (Wan2GP results), so Delete can remove it
                    translatedPrompt: translatedPrompt || res.translatedPrompt,
                    model: useLocalModel ? `local:${selectedLocalModel}` : 'nano-banana-pro',
                    timestamp: Date.now(),
                    settings: {
                        ...currentSettings,
                        prompt: basePrompt, // after the spread: currentSettings.prompt is always empty
                        resolution: resBtn.dataset.value
                    }
                });

                showCanvas(res.url);
            } else {
                throw new Error('No Data');
            }

        } catch (e) {
            console.error(e);
            alert(t('cinema.generationFailed') + e.message);
        } finally {
            unsubscribeProgress?.();
            generateBtn.disabled = false;
            generateBtn.innerHTML = t('cinema.generateBtn');
        }
    };

    return container;
}
