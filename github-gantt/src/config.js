/**
 * GitHub credential helpers, repo string parsing, and the status bar.
 *
 * Nothing in this module imports from other app modules, so it is safe
 * to import from anywhere without risking circular dependencies.
 */

const statusBar = document.getElementById('status-bar');

// ─── Credential storage ───────────────────────────────────────────────────────

export function getConfig() {
    return {
        token: localStorage.getItem('gh_token') || '',
        repo:  localStorage.getItem('gh_repo')  || '',
    };
}

export function saveConfig(token, repo) {
    localStorage.setItem('gh_token', token);
    localStorage.setItem('gh_repo', repo);
}

// ─── Repository string parsing ────────────────────────────────────────────────

/**
 * Parse "owner/repo" into { owner, repo }, or return null if invalid.
 * @param {string} repoStr
 */
export function parseRepo(repoStr) {
    const parts = repoStr.trim().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
}

// ─── Status bar ───────────────────────────────────────────────────────────────

/**
 * Display a message in the status bar.
 * @param {string} msg
 * @param {'info'|'warn'|'error'|'success'} type
 */
export function setStatus(msg, type = 'info') {
    statusBar.textContent = msg;
    statusBar.className = `status-bar status-${type}`;
}
