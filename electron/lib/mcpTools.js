// The tools the app's MCP server offers. Everything that touches the engines comes in through
// `deps`, so the selection rules and the tool contracts can be unit-tested without Electron.
//
// deps = {
//   listModels(): Promise<Array<{ id, name, engine, kind: 'image'|'edit'|'video'|'lipsync', ready, downloaded, fit, legacy, reason }>>
//   generate(params): Promise<{ url, path, seed, translatedPrompt, mediaType }>
//   enhance(text): Promise<string>
//   cancel(): void
//   recent(limit): Array<{ path, modifiedAt }>
//   notify(event): void            // lets the app show what is being done
// }
const fs = require('fs');
const path = require('path');

const ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];
const FIT_RANK = { recommended: 0, unknown: 1, heavy: 2 };
const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;

/** Best model of a kind that can run now: downloaded first, then the better fit; legacy ones last. */
function rankModels(models) {
    return models
        .map((m, i) => ({ m, i }))
        .sort((a, b) => (Number(!!a.m.legacy) - Number(!!b.m.legacy))
            || (Number(!a.m.downloaded) - Number(!b.m.downloaded))
            || ((FIT_RANK[a.m.fit] ?? 1) - (FIT_RANK[b.m.fit] ?? 1))
            || (a.i - b.i))
        .map(x => x.m);
}

/** Resolve the model to use: the one asked for (id or part of the name) or the best available of that kind. */
function pickModel(models, kind, requested) {
    const ofKind = models.filter(m => m.kind === kind);
    if (requested) {
        const wanted = String(requested).trim().toLowerCase();
        const found = ofKind.find(m => m.id.toLowerCase() === wanted)
            || ofKind.find(m => m.name.toLowerCase().includes(wanted) || m.id.toLowerCase().includes(wanted));
        if (!found) throw new Error(`No ${kind} model matches "${requested}". Use list_models to see the available ones.`);
        if (!found.ready) throw new Error(`${found.name} cannot be used now: ${found.reason || 'not ready'}.`);
        return found;
    }
    const best = rankModels(ofKind.filter(m => m.ready))[0];
    if (!best) throw new Error(`No ${kind} model is ready on this PC. Install or download one in Settings → Local Models.`);
    return best;
}

const text = (value) => ({ type: 'text', text: value });

// Tool annotations: hints that let a client approve the harmless tools on its own. Everything stays on this PC.
const READS = { readOnlyHint: true, openWorldHint: false };
const MAKES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const STOPS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const modelInfo = (m) => ({ id: m.id, name: m.name, kind: m.kind, engine: m.engine, ready: !!m.ready, downloaded: !!m.downloaded, fit: m.fit || 'unknown', legacy: !!m.legacy, ...(m.reason ? { reason: m.reason } : {}) });

function describeModels(models) {
    if (!models.length) return 'No models found.';
    return models.map(m => {
        const state = !m.ready ? `unavailable (${m.reason || 'not ready'})` : m.downloaded ? 'downloaded' : 'not downloaded yet (downloads on first use)';
        const fit = m.fit && m.fit !== 'unknown' ? `, ${m.fit}` : '';
        return `- ${m.id} — ${m.name} [${m.kind}${m.legacy ? ', legacy' : ''}${fit}] ${state}`;
    }).join('\n');
}

/** Build the content of a tool result for a finished image: a line of text and, when small enough, the picture. */
function imageResult(result, summary, structured = {}) {
    const content = [text(summary)];
    const match = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(String(result.url || ''));
    if (match && Buffer.byteLength(match[2], 'base64') <= MAX_INLINE_IMAGE_BYTES) {
        content.push({ type: 'image', data: match[2], mimeType: match[1] });
    }
    return { content, structuredContent: structured };
}

function createTools(deps) {
    const emit = (event) => { try { deps.notify?.(event); } catch { /* UI feedback is optional */ } };

    /** With a shared job list (the app) a picture is a job: the tool waits a little and answers with a job id when the model is still loading. */
    async function runImageJob(args, waitSeconds) {
        if (!deps.jobs) return runImageNow(args);
        const job = deps.jobs.start({
            name: `${args.kind === 'edit' ? 'edit' : 'image'} with ${args.model.name}`, lane: 'gpu', cancel: deps.cancel,
            run: async () => {
                const out = await runImageNow(args);
                return { summary: out.content.find((c) => c.type === 'text')?.text || '', content: out.content, path: out.structuredContent.path, data: out.structuredContent };
            },
        });
        await deps.jobs.wait(job, waitSeconds === undefined ? 50 : waitSeconds);
        if (job.state === 'error') throw new Error(job.error);
        if (job.state === 'done') return { content: job.result.content, structuredContent: { job_id: job.id, state: 'done', ...job.result.data } };
        return {
            content: [text(`${job.id} (${job.name}) is ${job.state === 'queued' ? 'waiting for the engine to be free' : 'still running'} (a heavy model needs minutes the first time it is loaded). Ask again with job_status ${job.id} and wait_seconds.`)],
            structuredContent: { job_id: job.id, name: job.name, state: job.state },
        };
    }

    async function runImageNow({ tool, kind, model, params, prompt }) {
        emit({ phase: 'start', tool, model: model.id, modelName: model.name, prompt });
        try {
            const result = await deps.generate({ ...params, model: model.id });
            if (result.mediaType === 'video') throw new Error(`${model.name} produces video, not an image.`);
            emit({
                phase: 'result',
                entry: {
                    id: `mcp-${Date.now()}`,
                    url: result.url,
                    path: result.path,
                    prompt,
                    model: `local:${model.id}`,
                    aspect_ratio: params.aspect_ratio,
                    seed: result.seed,
                    translatedPrompt: result.translatedPrompt || undefined,
                    timestamp: new Date().toISOString(),
                },
            });
            const lines = [
                `${kind === 'edit' ? 'Edited' : 'Generated'} with ${model.name}${result.seed !== undefined ? ` (seed ${result.seed})` : ''}.`,
                result.path ? `File: ${result.path}` : null,
                result.translatedPrompt ? `The prompt was translated to: ${result.translatedPrompt}` : null,
                'The result is also shown in the app (history of Image Studio).',
            ].filter(Boolean);
            return imageResult(result, lines.join('\n'), {
                path: result.path || null, model: model.id, seed: result.seed ?? null,
                ...(result.translatedPrompt ? { translated_prompt: result.translatedPrompt } : {}),
            });
        } catch (err) {
            emit({ phase: 'error', tool, message: String(err?.message || err) });
            throw err;
        }
    }

    return [
        {
            name: 'list_models',
            description: 'List the local AI models of the app with their kind (image, edit, video, lipsync, audio), whether the PC can run them and whether they are already downloaded.',
            inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'edit', 'video', 'lipsync', 'audio'], description: 'Only models of this kind' } } },
            annotations: READS,
            run: async ({ kind }) => {
                const models = (await deps.listModels()).filter(m => !kind || m.kind === kind);
                return { content: [text(describeModels(models))], structuredContent: { models: models.map(modelInfo) } };
            },
        },
        {
            name: 'generate_image',
            annotations: MAKES,
            description: 'Generate an image from a text prompt with a local model, on this PC. Any language works (non-English prompts are translated). The result also appears in the app. A large model takes minutes the first time it is loaded, then seconds.',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'What to draw. Detailed prompts work best.' },
                    model: { type: 'string', description: 'Model id or part of its name (see list_models). Default: the best one ready on this PC.' },
                    aspect_ratio: { type: 'string', enum: ASPECT_RATIOS, description: 'Default 1:1' },
                    negative_prompt: { type: 'string' },
                    seed: { type: 'integer', description: 'Same seed + same prompt gives the same image. Omit for random.' },
                    steps: { type: 'integer', description: 'Sampling steps. Omit to use the model default.' },
                    wait_seconds: { type: 'integer', minimum: 0, maximum: 55, description: 'Seconds to wait for the picture before answering with a job id (default 50). job_status keeps waiting.' },
                },
                required: ['prompt'],
            },
            run: async ({ prompt, model, aspect_ratio, negative_prompt, seed, steps, wait_seconds }) => {
                if (!String(prompt || '').trim()) throw new Error('prompt is required.');
                const picked = pickModel(await deps.listModels(), 'image', model);
                return runImageJob({
                    tool: 'generate_image', kind: 'image', model: picked, prompt,
                    params: { prompt, aspect_ratio: ASPECT_RATIOS.includes(aspect_ratio) ? aspect_ratio : '1:1', negative_prompt, seed, steps },
                }, wait_seconds);
            },
        },
        {
            name: 'edit_image',
            annotations: MAKES,
            description: 'Edit an existing picture with an instruction, e.g. "make the dog black" or "change the sky to sunset", keeping the rest of the picture. Runs locally; the result also appears in the app.',
            inputSchema: {
                type: 'object',
                properties: {
                    image_path: { type: 'string', description: 'Absolute path of the picture on this PC (png, jpg or webp)' },
                    prompt: { type: 'string', description: 'The change to make, written as an instruction. Say what must stay unchanged.' },
                    model: { type: 'string', description: 'An edit model id or name (see list_models with kind "edit")' },
                    aspect_ratio: { type: 'string', enum: ASPECT_RATIOS, description: 'Default 1:1; pick the one closest to the picture' },
                    seed: { type: 'integer' },
                    wait_seconds: { type: 'integer', minimum: 0, maximum: 55, description: 'Seconds to wait for the result before answering with a job id (default 50). job_status keeps waiting.' },
                },
                required: ['image_path', 'prompt'],
            },
            run: async ({ image_path, prompt, model, aspect_ratio, seed, wait_seconds }) => {
                if (!String(prompt || '').trim()) throw new Error('prompt is required.');
                if (!path.isAbsolute(String(image_path || '')) || !fs.existsSync(image_path) || !fs.statSync(image_path).isFile()) {
                    throw new Error('image_path must be the absolute path of an existing picture.');
                }
                if (!/\.(png|jpe?g|webp)$/i.test(image_path)) throw new Error('image_path must be a png, jpg or webp picture.');
                const picked = pickModel(await deps.listModels(), 'edit', model);
                return runImageJob({
                    tool: 'edit_image', kind: 'edit', model: picked, prompt,
                    params: { prompt, image: image_path, aspect_ratio: ASPECT_RATIOS.includes(aspect_ratio) ? aspect_ratio : '1:1', seed },
                }, wait_seconds);
            },
        },
        {
            name: 'enhance_prompt',
            description: 'Rewrite a short idea (any language) into a detailed English prompt with the local Qwen model, written for the kind of media: '
                + 'image (setting, composition, light, mood, style), video (action, camera movement), music (genre, instruments, mood, BPM) '
                + 'or sfx (what makes the sound and what it does, in plain words, as Stable Audio wants it). Returns the text only.',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string' },
                    kind: { type: 'string', enum: ['image', 'video', 'music', 'sfx'], description: 'What the prompt is for. Default image.' },
                },
                required: ['prompt'],
            },
            annotations: READS,
            run: async ({ prompt, kind }) => {
                const enhanced = await deps.enhance(String(prompt || ''), ['image', 'video', 'music', 'sfx'].includes(kind) ? kind : 'image');
                return { content: [text(enhanced)], structuredContent: { prompt: enhanced } };
            },
        },
        {
            name: 'recent_results',
            description: 'List the most recent files generated by the app (newest first) with their path.',
            inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10' } } },
            annotations: READS,
            run: async ({ limit }) => {
                const items = deps.recent(Math.min(50, Math.max(1, Number(limit) || 10)));
                return {
                    content: [text(items.length ? items.map(i => `${i.modifiedAt}  ${i.path}`).join('\n') : 'No results yet.')],
                    structuredContent: { items: items.map(i => ({ path: i.path, modified_at: i.modifiedAt })) },
                };
            },
        },
        {
            name: 'cancel_generation',
            description: 'Stop the generation that is running in the app, if any.',
            inputSchema: { type: 'object', properties: {} },
            annotations: STOPS,
            run: async () => { deps.cancel(); return { content: [text('Cancel requested.')] }; },
        },
    ];
}

module.exports = { createTools, pickModel, rankModels, describeModels, ASPECT_RATIOS, READS, MAKES, STOPS };
