// "Contact sheet" prompts: one image that shows a character from several sides, or a place from several
// camera angles. These are the reference pictures the Anime (H3) studio needs to keep a character or a
// location the same from shot to shot.

export const SHEETS = {
    off: { label: 'Sheet: off', tooltip: 'Make a normal image' },
    character: {
        label: 'Character sheet',
        tooltip: 'One image with the same character from the front, the side and the back (close-ups on top, full body below)',
        role: 'character',
        aspects: ['4:5', '3:4', '2:3', '1:1'],
    },
    environment: {
        label: 'Environment sheet',
        tooltip: 'One image with the same place from four camera angles, without people',
        role: 'place',
        aspects: ['16:9', '3:2', '4:3', '1:1'],
    },
};

export const SHEET_ORDER = ['off', 'character', 'environment'];

const TEMPLATES = {
    character: (subject) => `character design reference sheet of ${subject}. `
        + 'Turnaround model sheet laid out as a clean grid of six panels: the top row has three head-and-shoulders close-ups (front view, side profile, back of the head), '
        + 'the bottom row has three full-body views (front, side, back), all evenly spaced. '
        + 'It is exactly the same character in every panel, with identical face, hairstyle, outfit, accessories and colors, in a neutral standing pose with the arms relaxed at the sides (no hands on hips, no leaning, no furniture), '
        + 'on a plain light studio background, consistent style and lighting, sharp clean details, no text, no labels',
    environment: (subject) => `environment design reference sheet of ${subject}. `
        + 'One image divided into a clean 2x2 grid of four panels showing the same location from four camera angles: a wide establishing shot, '
        + 'the reverse angle looking the opposite way, a medium shot of the main area, and a close-up of the key details and props. '
        + 'The architecture, layout, colors, materials, lighting and time of day are identical in every panel, no people, no text, no labels',
};

/** The prompt to send for the chosen sheet (the text unchanged when no sheet is chosen). */
export function applySheet(kind, prompt) {
    const subject = String(prompt || '').trim().replace(/[.\s]+$/, '');
    const template = TEMPLATES[kind];
    return template && subject ? template(subject) : String(prompt || '');
}

/** The first aspect ratio from the sheet's preference list that the model offers; null when none fits. */
export function pickSheetAspect(kind, available = []) {
    const wanted = SHEETS[kind]?.aspects || [];
    return wanted.find((ratio) => available.includes(ratio)) || null;
}

/** The next choice when the button is pressed: off → character → environment → off. */
export function nextSheet(kind) {
    return SHEET_ORDER[(SHEET_ORDER.indexOf(kind) + 1) % SHEET_ORDER.length];
}
