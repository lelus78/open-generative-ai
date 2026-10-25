// Continuity between shots: the last frame of the previous clip goes into the next shot as one more reference
// picture (a "place" reference, so the layout, light and colours carry over). Own implementation, nothing copied.

export const CONTINUITY_NAME = 'Previous shot';
const CONTINUITY_SENTENCE = `The shot continues seamlessly from ${CONTINUITY_NAME}: the same place, light, colours and character looks, with the action going on from where it stopped.`;

/**
 * refs: [{ path, role, name, sheet }] chosen for the shot; frame: path of the previous clip's last frame (or none).
 * H3 takes at most `max` references. A full list gives up its last place/object reference for the frame;
 * characters are never dropped — when there is nothing else to give up, the list stays as it is.
 */
export function mergeContinuityRef(refs, frame, max = 4) {
    const list = refs.slice(0, max);
    if (!frame) return list;
    const reference = { path: frame, role: 'place', name: CONTINUITY_NAME, sheet: false };
    if (list.length < max) return [...list, reference];
    const roles = list.map((r) => r.role);
    let slot = roles.lastIndexOf('place');
    if (slot < 0) slot = roles.lastIndexOf('object');
    if (slot < 0) return list;
    const next = [...list];
    next[slot] = reference;
    return next;
}

/** The story with the continuity sentence, only when the frame was really used. */
export function withContinuityStory(story, refs) {
    return refs.some((r) => r.name === CONTINUITY_NAME) ? `${String(story).trim()} ${CONTINUITY_SENTENCE}` : story;
}
