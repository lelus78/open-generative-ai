// A small picture editor in a dialog: crop (free or fixed shape), rotate, flip and basic colour.
// openImageEditor(file) resolves with the edited picture as { bytes, type, name } or null when cancelled.

const RATIOS = [['free', 'Free'], ['1', 'Square 1:1'], ['0.5625', 'Vertical 9:16'], ['0.8', 'Portrait 4:5'], ['1.7778', 'Wide 16:9']];
const MIN = 0.04; // smallest crop side, as a fraction of the picture

export async function openImageEditor(file) {
    const { bytes, type } = await window.localAI.movie.readImage(file);
    const sourceUrl = URL.createObjectURL(new Blob([bytes], { type }));
    const source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('That picture could not be opened.'));
        img.src = sourceUrl;
    });
    URL.revokeObjectURL(sourceUrl);

    return new Promise((resolve) => {
        const edit = { turns: 0, flip: false, brightness: 100, contrast: 100, saturation: 100, crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: 'free' };
        const wrap = document.createElement('div');
        wrap.className = 'fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4';
        wrap.innerHTML = `<div class="w-full max-w-4xl max-h-full overflow-auto rounded-2xl bg-[#0d0d10] border border-white/10 p-4 flex flex-col gap-3">
            <div class="flex items-center justify-between"><div class="text-sm font-bold">Edit picture</div><button type="button" class="ie-cancel w-8 h-8 rounded-full bg-white/10 hover:bg-white/20">✕</button></div>
            <div class="ie-stage relative mx-auto select-none touch-none" style="line-height:0"><canvas class="ie-canvas block"></canvas>
                <div class="ie-box absolute border-2 border-white cursor-move" style="box-shadow:0 0 0 9999px rgba(0,0,0,.6)">
                    ${['nw', 'ne', 'sw', 'se'].map((h) => `<div class="ie-h absolute w-4 h-4 bg-white rounded-sm" data-h="${h}" style="${h[0] === 'n' ? 'top' : 'bottom'}:-9px;${h[1] === 'w' ? 'left' : 'right'}:-9px;cursor:${h === 'nw' || h === 'se' ? 'nwse' : 'nesw'}-resize"></div>`).join('')}
                </div></div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-secondary">
                <select class="ie-ratio rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white">${RATIOS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
                <button type="button" class="ie-left px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15">⟲ Rotate left</button>
                <button type="button" class="ie-right px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15">⟳ Rotate right</button>
                <button type="button" class="ie-flip px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15">⇋ Flip</button>
                <button type="button" class="ie-reset px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15">Reset</button>
            </div>
            <div class="grid grid-cols-3 gap-3 text-xs text-secondary">
                ${[['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Colour']].map(([k, l]) => `<label class="flex flex-col gap-1">${l}<input type="range" min="40" max="180" value="100" class="ie-${k} accent-primary"></label>`).join('')}
            </div>
            <div class="ie-info text-[11px] text-secondary"></div>
            <div class="flex justify-end gap-2"><button type="button" class="ie-cancel2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-sm">Cancel</button><button type="button" class="ie-save px-4 py-2 rounded-xl bg-primary text-black text-sm font-bold">Use this picture</button></div>
        </div>`;
        document.body.appendChild(wrap);
        const $ = (s) => wrap.querySelector(s);
        const canvas = $('.ie-canvas');
        const box = $('.ie-box');
        const stage = $('.ie-stage');

        // The picture after rotation and flip, at full size.
        const base = document.createElement('canvas');
        const filterText = () => `brightness(${edit.brightness}%) contrast(${edit.contrast}%) saturate(${edit.saturation}%)`;
        function rebuildBase() {
            const swap = edit.turns % 2 === 1;
            base.width = swap ? source.naturalHeight : source.naturalWidth;
            base.height = swap ? source.naturalWidth : source.naturalHeight;
            const g = base.getContext('2d');
            g.save();
            g.translate(base.width / 2, base.height / 2);
            g.rotate((edit.turns * Math.PI) / 2);
            if (edit.flip) g.scale(-1, 1);
            g.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
            g.restore();
        }

        function draw() {
            const maxW = Math.min(window.innerWidth - 80, 820);
            const maxH = Math.max(240, window.innerHeight - 330);
            const scale = Math.min(maxW / base.width, maxH / base.height, 1);
            canvas.width = Math.round(base.width * scale);
            canvas.height = Math.round(base.height * scale);
            stage.style.width = `${canvas.width}px`;
            const g = canvas.getContext('2d');
            g.filter = filterText();
            g.drawImage(base, 0, 0, canvas.width, canvas.height);
            layoutBox();
        }
        function layoutBox() {
            const c = edit.crop;
            box.style.left = `${c.x * canvas.width}px`;
            box.style.top = `${c.y * canvas.height}px`;
            box.style.width = `${c.w * canvas.width}px`;
            box.style.height = `${c.h * canvas.height}px`;
            $('.ie-info').textContent = `Result: ${Math.round(c.w * base.width)} × ${Math.round(c.h * base.height)} px. Drag the frame to move it, drag a corner to resize.`;
        }
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        // With a fixed shape the width/height ratio is kept, measured in pixels of the picture.
        const ratioValue = () => (edit.ratio === 'free' ? 0 : Number(edit.ratio));
        function fitRatio() {
            const r = ratioValue();
            if (!r) return;
            const c = edit.crop;
            let w = c.w * base.width;
            let h = w / r;
            if (h > base.height) { h = base.height; w = h * r; }
            if (w > base.width) { w = base.width; h = w / r; }
            c.w = w / base.width;
            c.h = h / base.height;
            c.x = clamp(c.x, 0, 1 - c.w);
            c.y = clamp(c.y, 0, 1 - c.h);
        }

        let drag = null;
        box.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            box.setPointerCapture(e.pointerId);
            drag = { handle: e.target.dataset?.h || '', x: e.clientX, y: e.clientY, crop: { ...edit.crop } };
        });
        box.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = (e.clientX - drag.x) / canvas.width;
            const dy = (e.clientY - drag.y) / canvas.height;
            const o = drag.crop;
            const c = edit.crop;
            if (!drag.handle) {
                c.x = clamp(o.x + dx, 0, 1 - o.w);
                c.y = clamp(o.y + dy, 0, 1 - o.h);
            } else {
                let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
                if (drag.handle.includes('w')) left = clamp(o.x + dx, 0, right - MIN);
                if (drag.handle.includes('e')) right = clamp(o.x + o.w + dx, left + MIN, 1);
                if (drag.handle.includes('n')) top = clamp(o.y + dy, 0, bottom - MIN);
                if (drag.handle.includes('s')) bottom = clamp(o.y + o.h + dy, top + MIN, 1);
                let w = right - left, h = bottom - top;
                const r = ratioValue();
                if (r) { // keep the shape: width decides, height follows
                    h = (w * base.width) / r / base.height;
                    if (drag.handle.includes('n')) top = bottom - h; else bottom = top + h;
                    if (top < 0 || bottom > 1) { // too tall for the picture: height decides
                        h = Math.min(bottom, 1 - top, h);
                        w = (h * base.height * r) / base.width;
                        if (drag.handle.includes('w')) left = right - w; else right = left + w;
                        if (drag.handle.includes('n')) top = bottom - h; else bottom = top + h;
                    }
                }
                Object.assign(c, { x: clamp(left, 0, 1), y: clamp(top, 0, 1), w: Math.max(MIN, right - left), h: Math.max(MIN, bottom - top) });
            }
            layoutBox();
        });
        const endDrag = () => { drag = null; };
        box.addEventListener('pointerup', endDrag);
        box.addEventListener('pointercancel', endDrag);

        const resetCrop = () => { edit.crop = { x: 0, y: 0, w: 1, h: 1 }; fitRatio(); };
        function transform(fn) { fn(); resetCrop(); rebuildBase(); draw(); }
        $('.ie-left').onclick = () => transform(() => { edit.turns = (edit.turns + 3) % 4; });
        $('.ie-right').onclick = () => transform(() => { edit.turns = (edit.turns + 1) % 4; });
        $('.ie-flip').onclick = () => transform(() => { edit.flip = !edit.flip; });
        $('.ie-reset').onclick = () => {
            Object.assign(edit, { turns: 0, flip: false, brightness: 100, contrast: 100, saturation: 100, ratio: 'free' });
            for (const k of ['brightness', 'contrast', 'saturation']) $(`.ie-${k}`).value = 100;
            $('.ie-ratio').value = 'free';
            transform(() => {});
        };
        $('.ie-ratio').onchange = (e) => { edit.ratio = e.target.value; fitRatio(); layoutBox(); };
        for (const k of ['brightness', 'contrast', 'saturation']) $(`.ie-${k}`).oninput = (e) => { edit[k] = Number(e.target.value); draw(); };

        const close = (result) => { wrap.remove(); window.removeEventListener('keydown', onKey); resolve(result); };
        const onKey = (e) => { if (e.key === 'Escape') close(null); };
        window.addEventListener('keydown', onKey);
        $('.ie-cancel').onclick = () => close(null);
        $('.ie-cancel2').onclick = () => close(null);
        $('.ie-save').onclick = async () => {
            const c = edit.crop;
            const out = document.createElement('canvas');
            out.width = Math.max(1, Math.round(c.w * base.width));
            out.height = Math.max(1, Math.round(c.h * base.height));
            const g = out.getContext('2d');
            g.filter = filterText();
            g.drawImage(base, c.x * base.width, c.y * base.height, c.w * base.width, c.h * base.height, 0, 0, out.width, out.height);
            const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
            if (!blob) { close(null); return; }
            close({ bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/png', name: 'edited.png' });
        };

        rebuildBase();
        draw();
    });
}
