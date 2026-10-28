// What an assistant reads when it connects: the server instructions (how the tools fit together) and the
// prompts, ready-made recipes a user can pick from the client (in Claude Code they appear as slash commands).
const INSTRUCTIONS = [
    'Open Generative AI runs image, video, music and movie models on this PC. Nothing goes to the cloud.',
    'Start with list_models: it says which models this PC can run and which are already downloaded. A model that is not downloaded downloads on first use (gigabytes, minutes).',
    'Pictures: generate_image or edit_image (any language; prompts are translated). Video: generate_video (text or a start picture), h3_shot (MiniMax H3, keeps reference pictures faithful), make_lipsync. Sound: generate_music, generate_sound_effect.',
    'Movies: movie_options for the valid ids → movie_storyboard to plan the shots → make each shot → movie_render. movie_reel turns photos of one creation into a vertical reel. movie_open_in_app hands a project to the user.',
    'Long work runs as a job: the answer is a job id when it is not done in time. Call job_status with wait_seconds (up to 55) to wait for it; it reports progress and an estimate of the time left. One GPU job runs at a time; the others queue.',
    'Results carry structured content (path, seed, job_id, progress) next to the text: use the paths it returns, all on this PC.',
    'Real people: a video or edit model can change a face. When a photo shows a real person, keep it as a picture with a camera move (movie_render, movie_reel) unless the user asks otherwise.',
    'Prompts: enhance_prompt with kind image, video, music or sfx writes them the way each model wants. Sound effects want one plain sentence about the sound itself ("car tires screeching on asphalt as the car speeds away"), not a story; music wants genre, instruments, mood and BPM.',
    'Reading errors (debug_log has the details; do not keep changing the prompt for an error that is not about the prompt):',
    '- "out of memory" / "CUDA error": the model does not fit next to what is loaded. Wait for other jobs, use a smaller size or shorter clip, or a lighter model from list_models.',
    '- "not downloaded" / "not installed" / a model marked unavailable in list_models: tell the user what is missing (Settings → Local Models) or pick a ready model; do not retry the same call.',
    '- "already running" / "wait for it to finish": one GPU job at a time. Use job_status or list_jobs and try again when it is done.',
    '- "Wan2GP is not configured" / "ffmpeg was not found": a setup step for the user, not something a retry fixes.',
    '- "must be the absolute path of an existing …": pass a full path on this PC, as returned by a previous result.',
    '- "Generation cancelled": the user or cancel_job stopped it. Do not start it again unless asked.',
    '- A result that looks wrong (a different person, missing object): change the prompt or the references, not the settings.',
    'When something else fails, debug_log says why.',
].join('\n');

const arg = (name, description, required = false) => ({ name, description, required });

const PROMPTS = [
    {
        name: 'reel_from_photos',
        title: 'Reel from photos',
        description: 'A vertical reel (Discovery and/or Showcase) from the photos of one creation, opening on the best photo.',
        arguments: [
            arg('photos', 'A folder or the photo paths, in story order', true),
            arg('goal', 'followers, showcase or sell'),
            arg('variant', 'discovery, showcase or both (default both)'),
            arg('title', 'Name of the creation'),
            arg('handle', 'Your account, e.g. @my_lab'),
        ],
        build: (a) => [
            `Make an Instagram reel from these photos: ${a.photos}.`,
            `Goal: ${a.goal || 'followers'}. Variant: ${a.variant || 'both'}.${a.title ? ` The creation is called "${a.title}".` : ''}${a.handle ? ` The account is ${a.handle}.` : ''}`,
            'Steps with the open-generative-ai tools:',
            '1. Look at the photos and note which ones show a real person; pass them as faces.',
            '2. Call movie_reel with action "plan". Check the opener and write a short hook (under 6 words) and captions that fit the photos.',
            '3. Compose a fitting music track with generate_music (as long as the reel) unless I give one.',
            '4. Call movie_reel again with action "render", the texts and music_path; wait with job_status.',
            '5. Tell me the files, the length of each reel and which photo opens it.',
        ].join('\n'),
    },
    {
        name: 'product_spot',
        title: 'Product spot',
        description: 'A short product video: H3 shots that keep the real object faithful, music and an end title.',
        arguments: [arg('product', 'What the product is', true), arg('pictures', 'Photo paths of the product (1-4)', true), arg('seconds', 'Length of the spot, default 20')],
        build: (a) => [
            `Make a ${a.seconds || 20}-second spot for ${a.product}, using these photos as references: ${a.pictures}.`,
            'Steps with the open-generative-ai tools:',
            '1. movie_options, then movie_storyboard (aspect 9:16 unless I say otherwise) with the product as an "object" reference.',
            '2. Make each shot with h3_shot, the photos as references, so the object stays identical. Keep camera and light moving, not the object.',
            '3. generate_music for the mood, then movie_render with a title card at the end and fades.',
            '4. Give me the file and the job times; if a shot changes the object, redo only that shot.',
        ].join('\n'),
    },
    {
        name: 'music_video',
        title: 'Music video',
        description: 'Music first, then pictures and clips cut to its length.',
        arguments: [arg('idea', 'What the video is about', true), arg('style', 'Look and music style')],
        build: (a) => [
            `Make a short music video about: ${a.idea}.${a.style ? ` Style: ${a.style}.` : ''}`,
            'Steps with the open-generative-ai tools:',
            '1. generate_music (about 30 s) and movie_probe it for the exact length.',
            '2. movie_storyboard with 6 shots; make the pictures with generate_image and animate the best ones with generate_video.',
            '3. movie_render with the music (music_path), transitions from movie_options, shot lengths that add up to the music.',
            '4. movie_open_in_app so I can adjust it, and tell me the file.',
        ].join('\n'),
    },
];

module.exports = { INSTRUCTIONS, PROMPTS };
