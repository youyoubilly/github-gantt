#!/usr/bin/env node
/**
 * Import issues from CSV to GitHub
 * Usage: node import-issues.js <csv-file> <github-token> <owner> <repo>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * Parse CSV file (simple version)
 */
function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    if (lines.length === 0) return [];

    // Parse header
    const header = lines[0].split(',').map(h => h.trim());
    
    const rows = [];
    let currentRow = [];
    let inQuotes = false;
    let currentLine = '';

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        
        // Simple CSV parsing: handle quoted fields
        for (let char of line) {
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                currentRow.push(currentLine.trim().replace(/^"|"$/g, ''));
                currentLine = '';
            } else {
                currentLine += char;
            }
        }

        if (line.endsWith(',') && !inQuotes) {
            currentRow.push('');
        }

        // Check if line ends (not in quotes)
        if (!inQuotes && currentLine) {
            if (i === lines.length - 1 || !lines[i + 1].startsWith(' ')) {
                currentRow.push(currentLine.trim().replace(/^"|"$/g, ''));
                if (currentRow.length === header.length && currentRow.some(f => f)) {
                    rows.push(currentRow);
                }
                currentRow = [];
                currentLine = '';
            }
        }
    }

    // Handle last line
    if (currentLine) {
        currentRow.push(currentLine.trim().replace(/^"|"$/g, ''));
    }
    if (currentRow.length === header.length && currentRow.some(f => f)) {
        rows.push(currentRow);
    }

    // Convert to objects
    return rows.map(row => {
        const obj = {};
        header.forEach((key, i) => {
            obj[key.trim()] = row[i] || '';
        });
        return obj;
    });
}

/**
 * Create an issue on GitHub
 */
async function createIssue(owner, repo, token, issue) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    
    const labels = [];
    if (issue.Category) labels.push(issue.Category);
    if (issue.Priority) labels.push(issue.Priority);
    if (issue.Tags) {
        const tags = issue.Tags.split(';').map(t => t.trim()).filter(t => t);
        labels.push(...tags);
    }

    const body = {
        title: issue.Title,
        body: issue.Description || '',
        labels: [...new Set(labels)], // Remove duplicates
        state: issue.Status === 'complete' ? 'closed' : 'open',
    };

    // Add dates to body if available
    if (issue.StartDate || issue.DueDate) {
        body.body += `\n\n**Dates:**\n`;
        if (issue.StartDate) body.body += `- Start: ${issue.StartDate}\n`;
        if (issue.DueDate) body.body += `- Due: ${issue.DueDate}\n`;
    }

    // Add additional metadata
    if (issue['Assigned To'] || issue['Created By']) {
        body.body += `\n**Metadata:**\n`;
        if (issue['Assigned To']) body.body += `- Assigned To: ${issue['Assigned To']}\n`;
        if (issue['Created By']) body.body += `- Created By: ${issue['Created By']}\n`;
    }

    return ghFetch(
        `/repos/${owner_enc}/${repo_enc}/issues`,
        token,
        { method: 'POST', body: JSON.stringify(body) }
    );
}

/**
 * Main import function
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length < 4) {
        console.error('Usage: node import-issues.js <csv-file> <github-token> <owner> <repo>');
        process.exit(1);
    }

    const [csvFile, token, owner, repo] = args;

    if (!fs.existsSync(csvFile)) {
        console.error(`CSV file not found: ${csvFile}`);
        process.exit(1);
    }

    console.log(`📂 Parsing CSV: ${csvFile}`);
    const tasks = parseCSV(csvFile);
    console.log(`✅ Found ${tasks.length} tasks to import\n`);

    if (tasks.length === 0) {
        console.log('No tasks to import.');
        process.exit(0);
    }

    console.log(`📤 Importing to: ${owner}/${repo}\n`);

    let created = 0;
    let failed = 0;

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        try {
            const result = await createIssue(owner, repo, token, task);
            console.log(`✓ [${i + 1}/${tasks.length}] Created issue #${result.number}: ${task.Title}`);
            created++;
        } catch (error) {
            console.error(`✗ [${i + 1}/${tasks.length}] Failed to create: ${task.Title}`);
            console.error(`  Error: ${error.message}\n`);
            failed++;
        }
    }

    console.log(`\n📊 Import Summary:`);
    console.log(`   Created: ${created}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Total: ${tasks.length}`);
}

main().catch(console.error);
