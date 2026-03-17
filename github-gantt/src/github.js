/**
 * GitHub REST API v3 client.
 * All calls require a Personal Access Token (PAT) with `repo` scope.
 */

const BASE = 'https://api.github.com';

async function ghFetch(path, token, options = {}) {
    const res = await fetch(`${BASE}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });

    if (!res.ok) {
        let message = res.statusText;
        try {
            const body = await res.json();
            message = body.message || message;
        } catch { /* ignore */ }
        throw new Error(`GitHub ${res.status}: ${message}`);
    }

    if (res.status === 204) return null;
    return res.json();
}

/**
 * Fetch comments for a specific issue.
 */
export async function fetchIssueComments(owner, repo, token, issueNumber) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    const comments = [];
    let page = 1;

    while (true) {
        const batch = await ghFetch(
            `/repos/${owner_enc}/${repo_enc}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
            token,
        );
        comments.push(...batch);
        if (batch.length < 100) break;
        page++;
    }

    return comments;
}

/**
 * Fetch all (open + closed) issues for a repo, filtering out pull requests.
 * Handles pagination automatically.
 */
export async function fetchAllIssues(owner, repo, token) {
    const issues = [];
    let page = 1;

    while (true) {
        const owner_enc = encodeURIComponent(owner);
        const repo_enc = encodeURIComponent(repo);
        const batch = await ghFetch(
            `/repos/${owner_enc}/${repo_enc}/issues?state=all&per_page=100&page=${page}`,
            token,
        );
        // GitHub issues endpoint also returns PRs; filter them out.
        const onlyIssues = batch.filter((i) => !i.pull_request);
        issues.push(...onlyIssues);
        if (batch.length < 100) break;
        page++;
    }

    return issues;
}

/**
 * Fetch all labels defined in a repo.
 */
export async function fetchRepoLabels(owner, repo, token) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc  = encodeURIComponent(repo);
    const labels = [];
    let page = 1;
    while (true) {
        const batch = await ghFetch(
            `/repos/${owner_enc}/${repo_enc}/labels?per_page=100&page=${page}`,
            token,
        );
        labels.push(...batch);
        if (batch.length < 100) break;
        page++;
    }
    return labels;
}

/**
 * Replace all labels on an issue (PUT /repos/.../issues/N/labels).
 * @param {string[]} labelNames  Array of label name strings.
 */
export function updateIssueLabels(owner, repo, token, issueNumber, labelNames) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc  = encodeURIComponent(repo);
    return ghFetch(
        `/repos/${owner_enc}/${repo_enc}/issues/${issueNumber}/labels`,
        token,
        {
            method: 'PUT',
            body: JSON.stringify({ labels: labelNames }),
        },
    );
}

/**
 * PATCH an issue's body (to store Gantt metadata).
 */
export function updateIssueBody(owner, repo, token, issueNumber, newBody) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    return ghFetch(
        `/repos/${owner_enc}/${repo_enc}/issues/${issueNumber}`,
        token,
        {
            method: 'PATCH',
            body: JSON.stringify({ body: newBody }),
        },
    );
}

/**
 * Build a Map of sub-issue number (string) → parent issue number (string).
 * Uses two strategies:
 *  1. Check issue.parent / issue.parent_issue fields (GitHub sub-issues REST API).
 *  2. For issues with sub_issues_summary.total > 0, call the sub-issues endpoint.
 * Errors are swallowed silently — repos that don't use sub-issues just return an empty map.
 */
export async function fetchParentMap(owner, repo, token, issues) {
    const parentMap = new Map();
    const owner_enc = encodeURIComponent(owner);
    const repo_enc  = encodeURIComponent(repo);
    const issueNums = new Set(issues.map((i) => String(i.number)));

    // Strategy 1 — direct parent field returned by newer GitHub API versions
    for (const issue of issues) {
        const parentNum = issue.parent?.number ?? issue.parent_issue?.number ?? null;
        if (parentNum != null) {
            parentMap.set(String(issue.number), String(parentNum));
        }
    }

    // Strategy 2 — fetch sub-issues list for each parent issue
    const parentIssues = issues.filter((i) => (i.sub_issues_summary?.total ?? 0) > 0);
    await Promise.all(
        parentIssues.map(async (parent) => {
            try {
                const children = await ghFetch(
                    `/repos/${owner_enc}/${repo_enc}/issues/${parent.number}/sub_issues`,
                    token,
                );
                if (Array.isArray(children)) {
                    for (const child of children) {
                        const childId = String(child.number);
                        if (issueNums.has(childId) && !parentMap.has(childId)) {
                            parentMap.set(childId, String(parent.number));
                        }
                    }
                }
            } catch {
                // Sub-issues API unavailable or not used — skip silently.
            }
        }),
    );

    return parentMap;
}

/**
 * Add a sub-issue (child) to a parent issue via GitHub's sub-issues API.
 * Requires the child issue's GraphQL node_id (available as issue.node_id).
 * Best-effort — callers should catch errors.
 */
export function addSubIssue(owner, repo, token, parentNumber, childIssueId) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc  = encodeURIComponent(repo);
    return ghFetch(
        `/repos/${owner_enc}/${repo_enc}/issues/${parentNumber}/sub_issues`,
        token,
        {
            method: 'POST',
            body: JSON.stringify({ sub_issue_id: childIssueId }),
        },
    );
}

/**
 * Validate that the token can access the given repo by reading its metadata.
 */
export function validateRepo(owner, repo, token) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    return ghFetch(`/repos/${owner_enc}/${repo_enc}`, token);
}
