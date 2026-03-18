#!/usr/bin/env node
/**
 * Review imported issues and suggest labels
 */

const BASE = 'https://api.github.com';
const owner = 'TechxArtisanStudio';
const repo = 'R-D';
const token = process.env.GITHUB_TOKEN;

if (!token) {
    console.error('❌ Error: GITHUB_TOKEN environment variable not set');
    process.exit(1);
}

async function ghFetch(path, options = {}) {
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

async function getIssues() {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    
    const issues = [];
    let page = 1;

    while (true) {
        const batch = await ghFetch(
            `/repos/${owner_enc}/${repo_enc}/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`
        );
        const onlyIssues = batch.filter((i) => !i.pull_request);
        issues.push(...onlyIssues);
        if (batch.length < 100) break;
        page++;
    }

    return issues.slice(0, 21); // Get the last 21 (newly imported)
}

async function main() {
    console.log('📋 Fetching recently imported issues...\n');
    const issues = await getIssues();
    
    issues.sort((a, b) => a.number - b.number);
    
    for (const issue of issues) {
        console.log(`Issue #${issue.number}: ${issue.title}`);
        console.log(`  Status: ${issue.state}`);
        console.log(`  Current Labels: ${issue.labels.map(l => l.name).join(', ') || '(none)'}`);
        console.log(`  Body preview: ${issue.body.substring(0, 100)}...`);
        console.log('');
    }
}

main().catch(console.error);
