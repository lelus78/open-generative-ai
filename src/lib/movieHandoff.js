// Sends a finished clip or picture from another studio to the Movie studio's timeline.
// The studio is mounted lazily, so items wait here until it asks for them.

const queue = [];

export const isMovieAvailable = () => typeof window !== 'undefined' && !!window.localAI?.movie;

/**
 * @param {{ path?: string, url?: string, kind?: 'video'|'image', prompt?: string }} item
 *   `path` is a file on disk; otherwise `url` (a data: or http image) is saved by the studio first.
 */
export function sendToMovie(item) {
    queue.push(item);
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'movie' } }));
    window.dispatchEvent(new CustomEvent('movie:items'));
}

export function takeQueuedMovieItems() {
    return queue.splice(0, queue.length);
}
