// Shared UI helpers for "does this local model suit this PC" (fit info comes from the Electron side).
import { t } from './i18n.js';
import { localAI } from './localInferenceClient.js';

const FIT_ORDER = { recommended: 0, unknown: 1, heavy: 2, legacy: 3, unfit: 4 };

/** Position of a model in the list: models that do not fit last, demoted legacy ones just before them. */
export function fitRank(info) {
    if (!info) return FIT_ORDER.unknown;
    if (info.fit === 'unfit') return FIT_ORDER.unfit;
    if (info.legacy && info.legacyDemoted) return FIT_ORDER.legacy;
    return FIT_ORDER[info.fit] ?? FIT_ORDER.unknown;
}
const escapeAttr = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Stable sort: recommended first, then unknown, heavy, and models that do not fit last. */
export function sortByFit(models, infoOf = (m) => m) {
    return models
        .map((m, i) => ({ m, i, rank: fitRank(infoOf(m)) }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map(x => x.m);
}

/** Green tag for models whose weights are already on disk (no download needed). */
export function downloadedBadgeHtml(info) {
    if (!(info?.downloaded || info?.state === 'downloaded')) return '';
    return `<span class="px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide bg-primary/15 text-primary">✓ ${t('fit.downloaded')}</span>`;
}

export function fitBadgeHtml(info) {
    const legacy = info?.legacy
        ? `<span title="${escapeAttr(t('fit.legacyHelp'))}" class="px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide bg-white/10 text-white/50">${t('fit.legacy')}</span>`
        : '';
    if (!info?.fit || info.fit === 'unknown') return legacy;
    const styles = {
        recommended: ['bg-green-500/15 text-green-400', t('fit.recommended')],
        heavy: ['bg-yellow-500/15 text-yellow-400', t('fit.heavy')],
        unfit: ['bg-red-500/15 text-red-400', t('fit.unfit')],
    };
    const [cls, label] = styles[info.fit];
    return `<span title="${escapeAttr(info.fitReason || info.unavailableReason)}" class="px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide ${cls}">${label}</span>${legacy}`;
}

/** id → { fit, fitReason, unavailableReason, downloadGB, needsDownload, ready } for every local model. */
export async function loadFitInfo() {
    const map = new Map();
    try {
        for (const m of await localAI.listModels()) map.set(m.id, m);
    } catch (err) {
        console.warn('[fitBadge] Could not read local model fit:', err);
    }
    return map;
}

export function hardwareSummary(hw) {
    if (!hw) return '';
    const parts = [];
    parts.push(hw.gpuName ? `${hw.gpuName} · ${hw.vramGB} GB VRAM` : t('fit.noGpu'));
    if (hw.ramGB) parts.push(`${hw.ramGB} GB RAM`);
    if (hw.freeDiskGB !== null && hw.freeDiskGB !== undefined) parts.push(`${hw.freeDiskGB} GB ${t('fit.free')}`);
    return parts.join(' · ');
}
