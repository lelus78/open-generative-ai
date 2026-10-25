// MiniMax H3 follows a structured prompt (subject definitions → summary → retention → shot description →
// sound). This turns "references + a few sentences" into that format. Pure module (no electron import).

const DEFAULT_STYLE = 'a hand-drawn Japanese anime scene with expressive cel shading, soft cinematic lighting, and fluid motion';
const DEFAULT_SOUND = 'Ambient sounds and sound effects that match the action on screen.';
// H3 makes the sound track itself and, left alone, lets characters babble in an invented language.
const NO_VOICES = 'No speech, no dialogue, no voices, no singing, no humming and no narration: the characters stay silent.';

const ROLES = {
    character: {
        define: (n, label, sheet) => `<Subject ${n}> is ${label || 'the character'} in <Picture ${n}>`
            + (sheet ? ', the character reference sheet that shows the same character from several sides, ' : ', ')
            + 'preserving exact identity, facial features, build, hairstyle, clothing, and overall character design.'
            + (sheet ? ` The sheet is only a reference: the character appears once in the video, never as several copies, and the sheet's grid, panels and plain background are not part of the scene.` : ''),
        keep: 'identity, facial features, build, hairstyle, clothing, and overall character design are retained',
        phrase: (n, label) => `<Subject ${n}>, ${label || 'the character'} from <Picture ${n}>`,
    },
    place: {
        define: (n, label, sheet) => `<Subject ${n}> is ${label || 'the setting'} in <Picture ${n}>`
            + (sheet ? ', the environment reference sheet that shows the same location from several camera angles, ' : ', ')
            + 'preserving its exact layout, colors, key details, and lighting.'
            + (sheet ? ' The sheet is only a reference: the video shows the location as one continuous space, not as separate panels.' : ''),
        keep: 'layout, colors, key details, and lighting are retained',
        phrase: (n, label) => `<Subject ${n}>, ${label || 'the setting'} from <Picture ${n}>`,
    },
    object: {
        define: (n, label) => `<Subject ${n}> is ${label || 'the object'} in <Picture ${n}>, preserving its exact design, shape, and colors.`,
        keep: 'design, shape, and colors are retained',
        phrase: (n, label) => `<Subject ${n}>, ${label || 'the object'} from <Picture ${n}>`,
    },
};

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace each reference's name in the story with its <Subject N> tag so the model can tell who is who. */
function tagNames(story, refs) {
    let text = story;
    refs.forEach((ref, index) => {
        const name = (ref.tag || ref.name || '').trim(); // `tag`: a stand-in name when the user left the name empty
        if (name.length < 2) return;
        text = text.replace(new RegExp(`(?<![\\w<])${escapeRegExp(name)}(?![\\w>])`, 'gi'), `<Subject ${index + 1}>`);
    });
    return text;
}

/**
 * @param {object} spec
 * @param {{role?: 'character'|'place'|'object', name?: string}[]} spec.refs  one per reference image, in upload order
 * @param {string} spec.story  what happens, ideally in English, optionally using the reference names
 * @param {string} [spec.style]
 * @param {string} [spec.sound]
 */
function composeH3Prompt({ refs = [], story = '', style = '', sound = '', voices = false }) {
    if (!refs.length) throw new Error('Add at least one reference image.');
    const body = tagNames(String(story).trim(), refs);
    if (!body) throw new Error('Describe what should happen in the video.');
    const roleOf = (ref) => ROLES[ref.role] || ROLES.character;
    const label = (ref) => (ref.name || '').trim() || '';
    const subjects = refs.map((ref, i) => roleOf(ref).define(i + 1, label(ref), !!ref.sheet));
    const retention = refs.map((ref, i) => `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - ${roleOf(ref).keep}.`);
    const soundBase = (sound || '').trim() || DEFAULT_SOUND;
    const soundLine = voices ? soundBase : `${soundBase.replace(/[.\s]+$/, '')}. ${NO_VOICES}`;
    const subjectTags = refs.map((_, i) => `<Subject ${i + 1}>`);
    const involved = subjectTags.length > 1 ? `${subjectTags.slice(0, -1).join(', ')} and ${subjectTags[subjectTags.length - 1]}` : subjectTags[0];

    return [
        'subject_definitions:',
        ...subjects,
        '',
        'summary:',
        `[reference generation] The target video shows ${involved} in a single continuous cinematic shot: ${body}`,
        '',
        'retention_analysis:',
        ...retention,
        '',
        'detailed_description:',
        `The target video is ${(style || '').trim() || DEFAULT_STYLE}.`,
        `[Shot 1] ${body}`,
        '',
        `overall_soundscape: ${soundLine}`,
        '',
        'non_diegetic_music: N/A',
        '',
    ].join('\n');
}

module.exports = { composeH3Prompt, tagNames, DEFAULT_STYLE, DEFAULT_SOUND, NO_VOICES };
