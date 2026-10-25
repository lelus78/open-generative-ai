// Timeline helpers shared by the Movie studio and its tests.

/**
 * A title card marked `transparent` has no background of its own: its text is drawn over the next scene
 * (over the previous one when it is the last card) and the card itself leaves the timeline.
 * A scene that already has a title of its own keeps it, and the transparent card stays a normal card then.
 */
export function foldTransparentTitles(scenes) {
    const list = scenes.map((scene) => ({ ...scene }));
    const taken = new Set();
    list.forEach((scene, index) => {
        if (scene.kind !== 'title' || !scene.transparent) return;
        const candidates = [index + 1, index - 1].filter((i) => list[i] && list[i].kind !== 'title' && !String(list[i].title || '').trim() && !taken.has(i));
        if (!candidates.length) return;
        const target = list[candidates[0]];
        target.title = scene.title;
        target.subtitle = scene.subtitle;
        target.titleStyle = scene.titleStyle;
        target.titleColor = scene.titleColor;
        taken.add(candidates[0]);
        scene.folded = true;
    });
    return list.filter((scene) => !scene.folded);
}
