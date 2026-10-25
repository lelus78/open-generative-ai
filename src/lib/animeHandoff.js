// Sends a picture from another studio (Image, Cinema) to the Anime (H3) studio as a reference image.
// The studio is mounted lazily, so references wait here until it asks for them.

const queue = [];

export const isAnimeAvailable = () => typeof window !== 'undefined' && !!window.localAI?.h3;

/** Turns an image URL (data: or http) into a File, or throws a readable error. */
export async function imageUrlToFile(url, name = 'reference.png') {
    let response;
    try { response = await fetch(url); } catch { throw new Error('This image cannot be read from here — save it and add it by hand.'); }
    if (!response.ok) throw new Error('This image cannot be read from here — save it and add it by hand.');
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type || 'image/png' });
}

/** @param {{ url: string, prompt?: string, name?: string }} reference */
export function sendToAnime(reference) {
    queue.push(reference);
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'anime' } }));
    window.dispatchEvent(new CustomEvent('anime:references'));
}

export function takeQueuedReferences() {
    return queue.splice(0, queue.length);
}
