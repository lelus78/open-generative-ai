// Prompt variations for batch generation.
//   {red|blue|green}  alternatives written by the user: each repetition takes one of them
//   [castle, tower]   words the local AI should replace with fitting alternatives
// Without either, every repetition uses the same prompt (a new seed gives a different image).

const ALTERNATIVES = /\{([^{}]*\|[^{}]*)\}/g;
const AI_WORDS = /\[([^\[\]]*)\]/g;   // [] with nothing inside: the AI invents a detail

export const MAX_REPEATS = 24;

const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

export const hasAlternatives = (prompt) => new RegExp(ALTERNATIVES.source).test(prompt);
export const hasAiWords = (prompt) => new RegExp(AI_WORDS.source).test(prompt);

/** `[word]` markers removed, the words kept. */
export const stripAiMarkers = (prompt) => prompt.replace(AI_WORDS, '$1')
    .replace(/\s*,(\s*,)+/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').replace(/\s{2,}/g, ' ');

/** Every combination of the {a|b} groups, shuffled, cycled to exactly `count` prompts. */
export function expandAlternatives(prompt, count) {
    const groups = [...prompt.matchAll(ALTERNATIVES)].map(m => m[1].split('|').map(s => s.trim()).filter(Boolean));
    if (!groups.length) return Array(count).fill(prompt);

    let combos = [[]];
    for (const options of groups) {
        const next = [];
        for (const combo of combos) for (const option of options) next.push([...combo, option]);
        combos = next.length > 500 ? shuffle(next).slice(0, 500) : next;
    }
    const ordered = shuffle(combos);
    return Array.from({ length: count }, (_, i) => {
        const picks = ordered[i % ordered.length];
        let n = 0;
        return prompt.replace(ALTERNATIVES, () => picks[n++]);
    });
}

/** Prompts for one batch, plus `ai: true` when the AI part still has to run on the result. */
export function planVariants(prompt, count) {
    if (hasAiWords(prompt) && !hasAlternatives(prompt)) return { prompts: [], ai: true };
    const prompts = expandAlternatives(prompt, count).map(stripAiMarkers);
    return { prompts, ai: false };
}
