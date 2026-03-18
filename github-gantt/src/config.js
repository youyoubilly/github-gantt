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
 * Parse various GitHub URL formats into { owner, repo, projectId }, or return null if invalid.
 * Accepts:
 *   - GitHub repo URL: https://github.com/owner/repo
 *   - GitHub org project URL: https://github.com/orgs/owner/projects/14
 *   - Project + repo: https://github.com/orgs/owner/projects/14 owner/repo
 *   - Direct format: owner/repo or just projectId
 * @param {string} repoStr
 */
export function parseRepo(repoStr) {
    const input = repoStr.trim();
    
    // Try parsing as "project_url repo_format" (space-separated)
    const parts = input.split(/\s+/);
    if (parts.length >= 2) {
        const firstPart = parts[0];
        const restPart = parts.slice(1).join('/');
        
        // Check if first part is a project URL
        if (firstPart.includes('github.com') && firstPart.includes('projects')) {
            try {
                const projectMatch = firstPart.match(/projects\/(\d+)/);
                const ownerMatch = firstPart.match(/\/orgs\/([^/]+)\//);
                
                if (projectMatch && ownerMatch) {
                    const projectId = projectMatch[1];
                    const owner = ownerMatch[1];
                    const repoParts = restPart.split('/');
                    
                    if (repoParts.length === 2 && repoParts[0] && repoParts[1]) {
                        return { owner, repo: repoParts[1], projectId };
                    } else if (repoParts.length === 1 && repoParts[0]) {
                        return { owner, repo: repoParts[0], projectId };
                    }
                }
            } catch (e) {
                // Fall through to single URL parsing
            }
        }
    }
    
    // Try parsing as single URL
    if (input.includes('://') || input.includes('github.com')) {
        try {
            const url = new URL(input.startsWith('http') ? input : 'https://' + input);
            const pathname = url.pathname;
            
            // Handle: https://github.com/orgs/owner/projects/14
            const orgMatch = pathname.match(/^\/orgs\/([^/]+)\/projects\/(\d+)$/);
            if (orgMatch) {
                return { owner: orgMatch[1], repo: null, projectId: orgMatch[2] };
            }
            
            // Handle: https://github.com/owner/repo
            const repoMatch = pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/);
            if (repoMatch) {
                return { owner: repoMatch[1], repo: repoMatch[2], projectId: null };
            }
        } catch (e) {
            return null;
        }
    }
    
    // Parse direct owner/repo format
    const dirParts = input.split('/');
    if (dirParts.length === 2 && dirParts[0] && dirParts[1]) {
        return { owner: dirParts[0], repo: dirParts[1], projectId: null };
    }
    
    // Parse project ID only
    if (/^\d+$/.test(input)) {
        return { owner: null, repo: null, projectId: input };
    }
    
    return null;
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
