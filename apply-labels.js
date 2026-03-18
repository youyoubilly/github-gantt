#!/usr/bin/env node
/**
 * Fetch existing labels and apply them to issues
 */

import fs from 'fs';

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

async function fetchExistingLabels() {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    
    const labels = [];
    let page = 1;

    while (true) {
        const batch = await ghFetch(
            `/repos/${owner_enc}/${repo_enc}/labels?per_page=100&page=${page}`
        );
        labels.push(...batch);
        if (batch.length < 100) break;
        page++;
    }

    return labels.map(l => l.name);
}

function findMatchingLabel(suggested, existingLabels) {
    // Exact match
    if (existingLabels.includes(suggested)) {
        return suggested;
    }
    
    // Case-insensitive match
    const lower = suggested.toLowerCase();
    const match = existingLabels.find(l => l.toLowerCase() === lower);
    if (match) return match;
    
    // Partial match
    const partialMatch = existingLabels.find(l => 
        lower.includes(l.toLowerCase()) || l.toLowerCase().includes(lower)
    );
    if (partialMatch) return partialMatch;
    
    return null;
}

async function updateIssueLabels(issueNumber, labels) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    
    const body = JSON.stringify({ labels: Array.from(new Set(labels)) });
    
    return ghFetch(
        `/repos/${owner_enc}/${repo_enc}/issues/${issueNumber}`,
        { method: 'PATCH', body }
    );
}

async function main() {
    const suggestionsFile = 'label-suggestions.json';
    
    if (!fs.existsSync(suggestionsFile)) {
        console.error(`❌ ${suggestionsFile} not found. Run analyze-labels.js first.`);
        process.exit(1);
    }
    
    console.log('📋 Fetching existing labels from repository...\n');
    const existingLabels = await fetchExistingLabels();
    console.log(`Found ${existingLabels.length} existing labels:`);
    console.log(`${existingLabels.join(', ')}\n`);
    
    const suggestions = JSON.parse(fs.readFileSync(suggestionsFile, 'utf-8'));
    
    console.log('🔄 Mapping suggested labels to existing labels...\n');
    
    const labelMapping = {};
    for (const suggestion of suggestions) {
        const mapped = [];
        for (const suggested of suggestion.suggested) {
            const match = findMatchingLabel(suggested, existingLabels);
            if (match) {
                mapped.push(match);
            } else {
                console.log(`⚠️  Label not found: "${suggested}" (Issue #${suggestion.number})`);
            }
        }
        
        if (mapped.length > 0) {
            labelMapping[suggestion.number] = mapped;
        }
    }
    
    console.log(`\n📤 Applying labels...\n`);
    
    let success = 0;
    let failed = 0;
    
    for (const [issueNumber, labels] of Object.entries(labelMapping)) {
        try {
            await updateIssueLabels(issueNumber, labels);
            console.log(`✓ Issue #${issueNumber}: ${labels.join(', ')}`);
            success++;
        } catch (error) {
            console.error(`✗ Issue #${issueNumber}: ${error.message}`);
            failed++;
        }
    }
    
    console.log(`\n📊 Applied labels:`);
    console.log(`   Success: ${success}`);
    console.log(`   Failed: ${failed}`);
}

main().catch(console.error);
