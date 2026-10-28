// "Report a problem": a GitHub issue filled in with the app version, the system, the GPU and the end of the
// debug log, made anonymous first (home folder and user name taken out). Nothing is sent by the app: the
// browser opens the issue form and the user reads, edits and submits it. Pure helpers, unit-tested.
const REPO_ISSUES = 'https://github.com/lelus78/open-generative-ai/issues/new';
const MAX_URL = 7500;   // GitHub (and browsers) cut longer prefilled URLs

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces the home folder (in any spelling: C:\Users\x, C:/Users/x, file:///C:/Users/x, %20) and the user name. */
function anonymize(text, { home = '', user = '' } = {}) {
    let out = String(text || '');
    if (home) {
        const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'), encodeURI(home.replace(/\\/g, '/')), home.replace(/\\/g, '/').replace(/ /g, '%20')]);
        for (const v of [...variants].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRegExp(v), 'gi'), '~');
    }
    if (user && user.length >= 3) out = out.replace(new RegExp(`\\b${escapeRegExp(user)}\\b`, 'gi'), '<user>');
    return out;
}

/** The issue form URL. The log keeps its newest lines when it has to be shortened to fit the URL. */
function issueUrl({ version = '?', platform = '?', gpu = '', log = '' } = {}) {
    const title = `Problem in ${version}: `;
    const head = [
        '**What happened?**', '<!-- what you did, what you expected, what you got -->', '', '',
        `**App:** ${version} · ${platform}${gpu ? ` · ${gpu}` : ''}`, '',
        '<details><summary>Debug log (anonymized: home folder and user name removed)</summary>', '', '```',
    ].join('\n');
    const tail = '\n```\n</details>\n';
    const build = (lines) => `${REPO_ISSUES}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(`${head}\n${lines.join('\n')}${tail}`)}`;
    let lines = String(log || '').split('\n').filter(Boolean);
    let url = build(lines);
    while (url.length > MAX_URL && lines.length > 1) {
        lines = ['… (older lines cut: the whole log is on the clipboard)', ...lines.slice(Math.ceil(lines.length * 0.2) + 1)];
        url = build(lines);
    }
    return url;
}

module.exports = { anonymize, issueUrl, REPO_ISSUES, MAX_URL };
