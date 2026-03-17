/**
 * Save logic for all pending changes (dates, labels, parent, dependencies).
 *
 * Executes sequentially to avoid GitHub rate limits, with proper error logging
 * and recovery.
 */

import { state } from './state.js';
import { setStatus, parseRepo, getConfig } from './config.js';
import { updateSaveBtn, getLiveTasks, getVisibleTasks } from './tasks.js';
import { buildLabelFilter, applyLabelFilter } from './filters.js';
import { applyBarColors } from './gantt-renderer.js';
import { updateIssueBody, updateIssueLabels, addSubIssue } from './github.js';
import { buildUpdatedBody, issueToTask } from './mapper.js';

const saveBtn = document.getElementById('save-btn');

/**
 * Save all pending changes to GitHub, then reload the local state.
 * Logs failures to console but continues with other changes.
 */
export async function saveChanges() {
    // Early return if nothing to save
    if (state.pendingChanges.size === 0 && state.pendingLabelChanges.size === 0 && state.pendingParentChanges.size === 0) {
        return;
    }

    const { token, repo: repoStr } = getConfig();
    const parsed = parseRepo(repoStr);
    if (!parsed) return;

    saveBtn.disabled = true;
    const total = state.pendingChanges.size + state.pendingLabelChanges.size + state.pendingParentChanges.size;
    let done = 0;
    let failed = 0;

    setStatus(`Saving ${total} change(s)…`);

    // 1. Save label changes first (independent of body)
    for (const [issueNumber, labelNames] of state.pendingLabelChanges.entries()) {
        try {
            const updatedLabels = await updateIssueLabels(parsed.owner, parsed.repo, token, issueNumber, labelNames);
            const issue = state.allIssues.find((i) => String(i.number) === issueNumber);
            if (issue) {
                issue.labels = Array.isArray(updatedLabels)
                    ? updatedLabels
                    : labelNames.map((n) => state.repoLabels.find((l) => l.name === n) || { name: n, color: '888888' });
            }
            done++;
        } catch (err) {
            console.error(`Failed to save labels for #${issueNumber}:`, err);
            failed++;
        }
    }
    state.pendingLabelChanges.clear();

    // 2. Save date/progress changes (body updates)
    for (const [issueNumber, changes] of state.pendingChanges.entries()) {
        const issue = state.allIssues.find((i) => String(i.number) === issueNumber);
        if (!issue) { failed++; continue; }

        try {
            const newBody = buildUpdatedBody(issue, changes);
            const updated = await updateIssueBody(parsed.owner, parsed.repo, token, issueNumber, newBody);
            const idx = state.allIssues.indexOf(issue);
            if (idx !== -1) state.allIssues[idx] = updated;
            done++;
        } catch (err) {
            console.error(`Failed to save issue #${issueNumber}:`, err);
            failed++;
        }
    }
    state.pendingChanges.clear();

    // 3. Save parent assignments
    for (const [childId, parentId] of state.pendingParentChanges.entries()) {
        if (parentId === null) {
            done++; // removal already applied in-memory
            continue;
        }
        const childIssue = state.allIssues.find((i) => String(i.number) === childId);
        if (childIssue?.node_id) {
            try {
                await addSubIssue(parsed.owner, parsed.repo, token, parentId, childIssue.id);
                done++;
            } catch (err) {
                console.error(`Failed to set parent for #${childId}:`, err);
                failed++;
            }
        }
    }
    state.pendingParentChanges.clear();

    updateSaveBtn();

    if (failed === 0) {
        setStatus(`Saved ${done} issue(s) successfully ✓`, 'success');
    } else {
        setStatus(`Saved ${done}, failed ${failed}. Check the console for details.`, 'error');
    }

    // Reload all tasks from the updated issues
    state.allTasks = state.allIssues.map((issue) => issueToTask(issue, state.parentMap));
    buildLabelFilter(state.allIssues);
    applyBarColors();
}
