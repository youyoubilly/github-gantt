#!/usr/bin/env node
/**
 * Apply better labels to issues based on content analysis
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

    return issues.slice(0, 21).reverse(); // Get the last 21 (newly imported)
}

function analyzeIssue(issue) {
    const title = issue.title.toLowerCase();
    const body = issue.body.toLowerCase();
    const content = title + ' ' + body;
    
    const labels = new Set();
    
    // Detect type
    if (content.includes('修复') || content.includes('fix')) {
        labels.add('bug');
    } else if (content.includes('重构') || content.includes('refactor')) {
        labels.add('refactor');
    } else if (content.includes('添加') || content.includes('support') || content.includes('enhance')) {
        labels.add('feature');
    } else if (content.includes('更新')) {
        labels.add('enhancement');
    }
    
    // Platform detection
    if (content.includes('windows')) {
        labels.add('windows');
    }
    if (content.includes('linux')) {
        labels.add('linux');
    }
    if (content.includes('macos') || content.includes('ios') || content.includes('ipad')) {
        labels.add('macos');
    }
    if (content.includes('android') || content.includes('andriod')) {
        labels.add('android');
    }
    
    // Component detection
    if (content.includes('qt')) {
        labels.add('qt');
    }
    if (content.includes('ffmpeg')) {
        labels.add('ffmpeg');
    }
    if (content.includes('usb')) {
        labels.add('usb');
    }
    if (content.includes('gpu') || content.includes('decoder') || content.includes('硬件加速')) {
        labels.add('hardware-acceleration');
    }
    if (content.includes('jenkins') || content.includes('build')) {
        labels.add('ci/cd');
    }
    if (content.includes('kvm')) {
        labels.add('kvm');
    }
    if (content.includes('翻译') || content.includes('translation')) {
        labels.add('i18n');
    }
    if (content.includes('installer') || content.includes('flatpak') || content.includes('package')) {
        labels.add('distribution');
    }
    
    // Priority (keep from original)
    const priorityMatch = issue.body.match(/Priority:\s*(\w+)/);
    const existingLabels = issue.labels.map(l => l.name);
    if (existingLabels.includes('High')) labels.add('High');
    if (existingLabels.includes('Medium')) labels.add('Medium');
    if (existingLabels.includes('Low')) labels.add('Low');
    
    return Array.from(labels).filter(l => l); // Remove High/Medium/Low if not found
}

async function updateIssueLables(issueNumber, labels) {
    const owner_enc = encodeURIComponent(owner);
    const repo_enc = encodeURIComponent(repo);
    
    const body = JSON.stringify({ labels });
    
    return ghFetch(
        `/repos/${owner_enc}/${repo_enc}/issues/${issueNumber}`,
        { method: 'PATCH', body }
    );
}

async function main() {
    console.log('🔍 Analyzing issues and suggesting labels...\n');
    const issues = await getIssues();
    
    const suggestions = [];
    
    for (const issue of issues) {
        const suggestedLabels = analyzeIssue(issue);
        const currentLabels = issue.labels.map(l => l.name);
        
        // Keep Medium/High/Low/Priority labels
        const priorityLabels = currentLabels.filter(l => ['High', 'Medium', 'Low'].includes(l));
        const allLabels = [...new Set([...suggestedLabels, ...priorityLabels])];
        
        suggestions.push({
            number: issue.number,
            title: issue.title,
            current: currentLabels,
            suggested: allLabels,
            changed: JSON.stringify(currentLabels.sort()) !== JSON.stringify(allLabels.sort())
        });
    }
    
    // Display summary
    console.log('📊 Label suggestions:\n');
    for (const s of suggestions) {
        if (s.changed) {
            console.log(`✏️  Issue #${s.number}: ${s.title.substring(0, 50)}`);
            console.log(`   Current:  ${s.current.join(', ') || '(none)'}`);
            console.log(`   Suggested: ${s.suggested.join(', ')}`);
            console.log('');
        }
    }
    
    const changedCount = suggestions.filter(s => s.changed).length;
    console.log(`\n📈 ${changedCount}/${suggestions.length} issues need label updates`);
    
    // Ask for confirmation
    if (changedCount > 0) {
        console.log('\n⚠️  To apply these labels, run: node apply-labels.js');
    }
    
    // Export for apply script
    import('fs').then(({ writeFileSync }) => {
        writeFileSync('label-suggestions.json', JSON.stringify(suggestions, null, 2));
    });
}

main().catch(console.error);
