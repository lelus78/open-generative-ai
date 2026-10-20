// Shared UI helpers for "does this local model suit this PC" (fit info comes from the Electron side).
import { t } from './i18n.js';
import { localAI } from './localInferenceClient.js';

const FIT_ORDER = { recommended: 0, unknown: 1, heavy: 2, unfit: 3 };
const escapeAttr = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Stable sort: recommended first, then unknown, heavy, and models that do not fit last. */
export function sortByFit(models, infoOf = (m) => m) {
    return models
        .map((m, i) => ({ m, i, rank: FIT_ORDER[infoOf(m)?.fit] ?? FIT_ORDER.unknown }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map(x => x.m);
}

export function fitBadgeHtml(info) {
    if (!info?.fit || info.fit === 'unknown') return '';
    const styles = {
        recommended: ['bg-green-500/15 text-green-400', t('fit.recommended')],
        heavy: ['bg-yellow-500/15 text-yellow-400', t('fit.heavy')],
        unfit: ['bg-red-500/15 text-red-400', t('fit.unfit')],
    };
    const [cls, label] = styles[info.fit];
    return `<span title="${escapeAttr(info.fitReason || info.unavailableReason)}" class="px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide ${cls}">${label}</span>`;
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
