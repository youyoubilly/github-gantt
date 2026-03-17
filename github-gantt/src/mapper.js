/**
 * Converts GitHub issues ↔ Frappe Gantt tasks.
 *
 * Gantt metadata is stored in the issue body as a hidden HTML comment:
 *   <!-- GANTT_META: {"start":"2024-01-01","end":"2024-01-10","progress":30,"deps":["2","5"]} -->
 *
 * The comment is invisible when the issue is rendered on GitHub.com.
 */

const META_RE = /<!-- GANTT_META: ([\s\S]*?) -->/;

// ─── Metadata parsing ────────────────────────────────────────────────────────

export function parseMeta(issueBody) {
    if (!issueBody) return null;
    const m = issueBody.match(META_RE);
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

/**
 * Replace (or append) the GANTT_META comment in an issue body.
 * Returns the updated body string.
 */
export function writeMeta(issueBody, meta) {
    const tag = `<!-- GANTT_META: ${JSON.stringify(meta)} -->`;
    const body = issueBody || '';
    if (META_RE.test(body)) {
        return body.replace(META_RE, tag);
    }
    return body + (body.trim() ? '\n\n' : '') + tag;
}

/**
 * Strip the metadata comment from a body string (for display purposes).
 */
export function stripMeta(issueBody) {
    return (issueBody || '').replace(META_RE, '').trim();
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toDateStr(date) {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ─── Issue → Task ─────────────────────────────────────────────────────────────

/**
 * Convert a GitHub issue object to a Frappe Gantt task object.
 * @param {object} issue     Raw GitHub issue
 * @param {Map}    parentMap childNumber(string) → parentNumber(string) — from fetchParentMap()
 */
export function issueToTask(issue, parentMap = new Map()) {
    const meta = parseMeta(issue.body);

    const created = new Date(issue.created_at);
    const defaultEnd = new Date(created);
    defaultEnd.setDate(defaultEnd.getDate() + 7);

    const start = meta?.start || toDateStr(created);
    const end = meta?.end || toDateStr(defaultEnd);
    const progress = issue.state === 'closed' ? 100 : (meta?.progress ?? 0);

    // Explicitly added deps (stored in GANTT_META, editable, persisted to GitHub)
    const metaDeps = meta?.deps || [];

    // Parent-inferred dep from GitHub sub-issues (read-only, NOT persisted)
    const parentNum = parentMap.get(String(issue.number));
    const parentDeps = parentNum != null ? [String(parentNum)] : [];

    // Combined list for the Gantt chart (deduped)
    const allDeps = [...new Set([...metaDeps, ...parentDeps])];

    // Build a human-readable description (strip metadata before showing)
    const description = stripMeta(issue.body).slice(0, 300) || '';

    // Decide a CSS class for the bar
    let custom_class = '';
    if (issue.state === 'closed') custom_class = 'bar-closed';
    else if (issue.labels?.some((l) => l.name === 'bug')) custom_class = 'bar-bug';
    else if (issue.labels?.some((l) => l.name === 'enhancement')) custom_class = 'bar-enhancement';

    // First assignee's avatar — used as a thumbnail on the bar
    const thumbnail = issue.assignees?.[0]?.avatar_url
        ? `${issue.assignees[0].avatar_url}&s=40`
        : null;

    return {
        id: String(issue.number),
        name: `#${issue.number} ${issue.title}`,
        start,
        end,
        progress,
        dependencies: metaDeps.join(','),  // only explicit blocking deps — parentDeps handled by sort
        _metaDeps:   metaDeps,   // GANTT_META deps — editable & persisted
        _parentDeps: parentDeps, // GitHub parent relationship — read-only, not persisted
        custom_class,
        description,
        thumbnail,
        // Keep the original issue for reference in callbacks
        _issue: issue,
    };
}

/**
 * Build the new issue body that should be written back to GitHub after
 * the user makes changes in the Gantt chart.
 *
 * @param {object} issue   Original GitHub issue object
 * @param {object} updates Partial update: { start, end, progress, deps }
 */
export function buildUpdatedBody(issue, updates) {
    const existing = parseMeta(issue.body) || {};
    const merged = { ...existing, ...updates };
    return writeMeta(issue.body, merged);
}
