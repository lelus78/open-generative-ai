// Right-hand history of generated results, shared by the Image, Video, Cinema and Lip Sync studios.
// Cards show the prompt, the model, how long ago and where it ran; the panel can be searched,
// collapsed to a thumbnail strip, and every result can be reused, downloaded or deleted.
import { t, tf, getLang } from '../lib/i18n.js';
import { TRASH_ICON } from '../lib/studioHelpers.js';

const COLLAPSED_KEY = 'history_panel_collapsed';
const EXPANDED_PADDING = '20rem';   // room left in the studio so the prompt bar is not covered
const COLLAPSED_PADDING = '3.5rem';

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
    download: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
    reuse: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    chevronRight: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>',
    chevronLeft: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>',
};

function toTime(entry) {
    const value = entry.timestamp;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(ms)) return ms;
    const fromId = Number(entry.id);          // ids are creation times in some studios
    return Number.isFinite(fromId) && fromId > 1e12 ? fromId : null;
}

function timeAgo(ms) {
    if (ms === null) return '';
    const seconds = Math.round((ms - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' });
    const steps = [['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, size] of steps) {
        if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
    }
    return rtf.format(0, 'second');
}

function dayLabel(ms) {
    if (ms === null) return t('history.earlier');
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(ms))) / 86400000);
    if (diffDays <= 0) return t('history.today');
    if (diffDays === 1) return t('history.yesterday');
    return new Date(ms).toLocaleDateString(getLang(), { day: 'numeric', month: 'long' });
}

/**
 * @param {{
 *   host: HTMLElement,                         studio container (gets padding so content is not covered)
 *   mediaType: 'image'|'video',
 *   entries: () => object[],                   newest first
 *   getActiveUrl: () => string,
 *   getModelLabel?: (entry) => string,
 *   onOpen: (entry) => void,
 *   onDelete: (entry) => void,
 *   onDownload: (entry) => void,
 *   onReuse?: (entry) => void,
 *   onClearAll?: () => void,
 * }} options
 */
export function createHistoryPanel(options) {
    const { host, mediaType, entries, getActiveUrl, onOpen, onDelete, onDownload, onReuse, onClearAll } = options;
    const getModelLabel = options.getModelLabel || ((e) => String(e.model || '').replace(/^(local:|wan2gp:)/, '').replace(/[-_]/g, ' '));

    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { /* storage unavailable */ }
    let query = '';

    const root = document.createElement('div');
    root.className = 'fixed right-0 top-0 h-full z-50 bg-black/70 backdrop-blur-xl border-l border-white/5 flex flex-col transition-all duration-300 translate-x-full opacity-0';

    const header = document.createElement('div');
    header.className = 'flex items-center gap-2 px-3 pt-4 pb-2 shrink-0';
    const title = document.createElement('div');
    title.className = 'flex-1 min-w-0 text-[11px] font-black text-white uppercase tracking-widest truncate';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'p-1.5 rounded-lg text-muted hover:text-white hover:bg-white/10 transition-colors shrink-0';
    header.appendChild(title);
    header.appendChild(toggleBtn);

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = t('history.search');
    search.className = 'mx-3 mb-2 px-3 py-2 rounded-xl bg-white/5 border border-white/5 focus:border-primary/50 outline-none text-[11px] text-white placeholder:text-muted shrink-0';
    search.oninput = () => { query = search.value.trim().toLowerCase(); render(); };

    const list = document.createElement('div');
    list.className = 'flex-1 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col gap-1.5';

    const footer = document.createElement('div');
    footer.className = 'px-3 py-3 border-t border-white/5 shrink-0';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'w-full py-2 rounded-xl text-[10px] font-bold uppercase tracking-wide text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors';
    clearBtn.textContent = t('history.clearAll');
    footer.appendChild(clearBtn);

    root.appendChild(header);
    root.appendChild(search);
    root.appendChild(list);
    root.appendChild(footer);

    toggleBtn.onclick = () => {
        collapsed = !collapsed;
        try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
        render();
    };

    clearBtn.onclick = () => {
        const all = entries();
        if (!all.length) return;
        const hasFiles = all.some(e => e.path);
        if (!confirm(tf('history.clearAllConfirm', all.length, hasFiles))) return;
        onClearAll?.();
    };

    const mediaHtml = (entry) => mediaType === 'video'
        ? `<video src="${escapeHtml(entry.url)}" preload="metadata" muted class="w-full h-full object-cover"></video>`
        : `<img src="${escapeHtml(entry.url)}" alt="" loading="lazy" class="w-full h-full object-cover">`;

    const isLocal = (entry) => !!entry.path || /^(local:|wan2gp:)/.test(String(entry.model || ''));

    const actionButton = (cls, title, icon, handler) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `p-1.5 rounded-lg transition-transform hover:scale-110 ${cls}`;
        b.title = title;
        b.innerHTML = icon;
        b.onclick = (e) => { e.stopPropagation(); handler(); };
        return b;
    };

    const buildCard = (entry) => {
        const active = getActiveUrl() === entry.url;
        const card = document.createElement('div');
        card.className = `group/card relative flex gap-3 p-2 rounded-2xl border cursor-pointer transition-all ${active ? 'border-primary/60 bg-primary/5 shadow-glow' : 'border-white/5 bg-white/[0.03] hover:bg-white/[0.07] hover:border-white/15'}`;

        const prompt = entry.prompt || entry.settings?.prompt || '';
        const when = timeAgo(toTime(entry));
        card.innerHTML = `
            <div class="w-16 h-16 shrink-0 rounded-xl overflow-hidden bg-white/5">${mediaHtml(entry)}</div>
            <div class="min-w-0 flex-1 flex flex-col justify-center gap-1.5">
                <p title="${escapeHtml(entry.translatedPrompt ? `English: ${entry.translatedPrompt}` : '')}" class="text-[11px] leading-snug ${prompt ? 'text-white/90' : 'text-muted italic'}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(prompt || t('history.noPrompt'))}</p>
                <div class="flex items-center gap-1.5 flex-wrap text-[9px] text-muted">
                    <span class="px-1.5 py-0.5 rounded-md bg-white/5 text-white/70 font-bold truncate max-w-[7.5rem]">${escapeHtml(getModelLabel(entry))}</span>
                    ${isLocal(entry) ? `<span class="px-1.5 py-0.5 rounded-md bg-primary/15 text-primary font-black uppercase">${t('history.local')}</span>` : ''}
                    <span>${escapeHtml(when)}</span>
                </div>
            </div>
        `;

        const actions = document.createElement('div');
        actions.className = 'absolute top-1.5 right-1.5 hidden group-hover/card:flex gap-1';
        if (onReuse && prompt) actions.appendChild(actionButton('bg-white/15 text-white', t('history.reuse'), ICONS.reuse, () => onReuse(entry)));
        actions.appendChild(actionButton('bg-primary text-black', t('common.download'), ICONS.download, () => onDownload(entry)));
        actions.appendChild(actionButton('bg-red-500 text-white', t('common.delete'), TRASH_ICON, () => onDelete(entry)));
        card.appendChild(actions);

        card.onclick = () => { onOpen(entry); render(); };
        return card;
    };

    const buildStripThumb = (entry) => {
        const active = getActiveUrl() === entry.url;
        const thumb = document.createElement('div');
        thumb.className = `w-full aspect-square rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${active ? 'border-primary shadow-glow' : 'border-white/10 hover:border-white/30'}`;
        thumb.title = entry.prompt || entry.settings?.prompt || '';
        thumb.innerHTML = mediaHtml(entry);
        thumb.onclick = () => { onOpen(entry); render(); };
        return thumb;
    };

    function render() {
        const all = entries();
        const visible = all.length > 0;
        root.classList.toggle('translate-x-full', !visible);
        root.classList.toggle('opacity-0', !visible);
        root.classList.toggle('pointer-events-none', !visible);
        root.classList.toggle('translate-x-0', visible);
        root.classList.toggle('opacity-100', visible);

        root.classList.toggle('w-72', visible && !collapsed);
        root.classList.toggle('md:w-80', visible && !collapsed);
        root.classList.toggle('w-14', visible && collapsed);

        if (host && window.innerWidth >= 768) {
            host.style.paddingRight = visible ? (collapsed ? COLLAPSED_PADDING : EXPANDED_PADDING) : '';
        }

        toggleBtn.innerHTML = collapsed ? ICONS.chevronLeft : ICONS.chevronRight;
        toggleBtn.title = collapsed ? t('history.expand') : t('history.collapse');
        title.textContent = `${t('common.history')} · ${all.length}`;
        title.style.display = collapsed ? 'none' : '';
        header.className = `flex items-center gap-2 px-3 pt-4 pb-2 shrink-0 ${collapsed ? 'justify-center' : ''}`;
        search.style.display = !collapsed && all.length > 4 ? '' : 'none';
        footer.style.display = collapsed ? 'none' : '';
        list.className = collapsed
            ? 'flex-1 overflow-y-auto custom-scrollbar px-2 pb-3 flex flex-col gap-2'
            : 'flex-1 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col gap-1.5';

        list.innerHTML = '';
        if (collapsed) {
            all.forEach(entry => list.appendChild(buildStripThumb(entry)));
            return;
        }

        const filtered = query
            ? all.filter(e => `${e.prompt || ''} ${e.settings?.prompt || ''} ${getModelLabel(e)}`.toLowerCase().includes(query))
            : all;
        if (!filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'text-[11px] text-muted text-center py-6';
            empty.textContent = t('history.noMatches');
            list.appendChild(empty);
            return;
        }

        let currentDay = null;
        filtered.forEach(entry => {
            const day = dayLabel(toTime(entry));
            if (day !== currentDay) {
                currentDay = day;
                const label = document.createElement('div');
                label.className = 'text-[9px] font-black text-muted uppercase tracking-widest pt-2 pb-1 px-1';
                label.textContent = day;
                list.appendChild(label);
            }
            list.appendChild(buildCard(entry));
        });
    }

    return { element: root, render };
}
