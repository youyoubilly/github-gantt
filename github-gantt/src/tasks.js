/**
 * Task data logic — live task computation, pending-change tracking,
 * topological sorting, and date cascade helpers.
 *
 * This module never touches the DOM directly except for the Save button
 * badge (updateSaveBtn), keeping all Gantt-chart rendering concerns in
 * gantt-renderer.js.
 */

import { state } from './state.js';
import { normalizeDeps } from './utils.js';

const saveBtn = document.getElementById('save-btn');

// ─── Pending-change tracking ──────────────────────────────────────────────────

/** Update the Save button's label and disabled state to reflect pending changes. */
export function updateSaveBtn() {
    const n = state.pendingChanges.size + state.pendingLabelChanges.size + state.pendingParentChanges.size;
    saveBtn.disabled = n === 0;
    saveBtn.textContent = n > 0 ? `💾 Save (${n} changed)` : '💾 Save';
}

/**
 * Merge a partial change object into pendingChanges for an issue, then
 * refresh the Save button badge.
 */
export function recordChange(issueNumber, partial) {
    const existing = state.pendingChanges.get(issueNumber) || {};
    state.pendingChanges.set(issueNumber, { ...existing, ...partial });
    updateSaveBtn();
}

/**
 * Cascade a date shift from a moved issue to everything that depends on it
 * (blocked-by chain), recursively, preserving each blocked issue's duration.
 * Only shifts forward — never pulls an issue backward when its blocker moves
 * earlier.
 *
 * @param {string}   movedId   task id of the issue whose dates just changed
 * @param {string}   prevStart ISO start before the move
 * @param {string}   newStart  ISO start after the move
 * @param {string}   newEnd    ISO end after the move
 * @param {Set<string>} visited cycle guard
 */
export function cascadeDateShift(movedId, prevStart, newStart, newEnd, visited = new Set()) {
    if (visited.has(movedId)) return;
    visited.add(movedId);

    const deltaMs = new Date(newStart) - new Date(prevStart);
    if (deltaMs === 0) return;

    const live = getLiveTasks();
    const dependents = live.filter((t) => normalizeDeps(t.dependencies).includes(String(movedId)));

    for (const dep of dependents) {
        if (visited.has(dep.id)) continue;
        if (deltaMs < 0) continue; // only push forward

        const depStart   = new Date(dep.start);
        const depEnd     = new Date(dep.end);
        const blockerEnd = new Date(newEnd);
        if (depStart >= blockerEnd) continue; // already after blocker, no adjustment needed

        const duration     = depEnd - depStart;
        const prevDepStart = dep.start;
        const shiftedStart = new Date(blockerEnd);
        shiftedStart.setDate(shiftedStart.getDate() + 1);
        const shiftedEnd = new Date(shiftedStart.getTime() + duration);

        const newDepStart = shiftedStart.toISOString().slice(0, 10);
        const newDepEnd   = shiftedEnd.toISOString().slice(0, 10);

        recordChange(dep.id, { start: newDepStart, end: newDepEnd });
        cascadeDateShift(dep.id, prevDepStart, newDepStart, newDepEnd, visited);
    }
}

/**
 * Compute the earliest allowed start date for a task given its blockers.
 * Returns `{ start, end, clamped }`. When `clamped` is true the caller
 * should show a status message explaining the clamp.
 *
 * @param {string[]} taskDeps  list of blocker task ids
 * @param {string}   startStr  proposed start (ISO)
 * @param {string}   endStr    proposed end (ISO)
 */
export function clampStartToDeps(taskDeps, startStr, endStr) {
    const live = getLiveTasks();
    let minStart = null;
    for (const blockerId of taskDeps) {
        const blocker = live.find((t) => t.id === blockerId);
        if (!blocker) continue;
        const blockerEnd = new Date(blocker.end);
        blockerEnd.setDate(blockerEnd.getDate() + 1); // day after blocker ends
        if (!minStart || blockerEnd > minStart) minStart = blockerEnd;
    }
    if (minStart) {
        const minStartStr = minStart.toISOString().slice(0, 10);
        if (startStr < minStartStr) {
            const duration = new Date(endStr) - new Date(startStr);
            return {
                start:   minStartStr,
                end:     new Date(minStart.getTime() + duration).toISOString().slice(0, 10),
                clamped: true,
            };
        }
    }
    return { start: startStr, end: endStr, clamped: false };
}

// ─── Live task computation ────────────────────────────────────────────────────

/**
 * Return the full task list merged with any unsaved pending changes so the
 * chart always reflects the latest in-memory edits.
 *
 * Key rules applied here:
 *  - Parent relationship is NOT a blocking dependency (no arrow, no deps section).
 *  - Task label includes a state indicator (✓ closed, ● open) and a child indent.
 */
export function getLiveTasks() {
    return state.allTasks.map((task) => {
        const pending    = state.pendingChanges.get(task.id);
        const rawMeta    = pending?.deps ?? (task._metaDeps || []);
        const parentDeps = task._parentDeps || [];
        const parentSet  = new Set(parentDeps.map(String));
        // Strip parent IDs from the deps that drive gantt arrows
        const metaDeps   = rawMeta.filter((d) => !parentSet.has(String(d)));
        const depsStr    = [...new Set(metaDeps)].join(',');

        const parentId = state.parentMap.get(task.id);
        const prefix   = parentId ? '  └ ' : '';
        const st       = task._issue?.state;
        const stateTag = st === 'closed' ? ' ✓' : st === 'open' ? ' ●' : '';
        const baseName = `#${task.id} ${task._issue?.title || task.name}${stateTag}`;

        return {
            ...task,
            name:         prefix + baseName,
            _metaDeps:    metaDeps,
            _parentDeps:  parentDeps,
            dependencies: depsStr,
            ...(pending && {
                start:    pending.start    || task.start,
                end:      pending.end      || task.end,
                progress: pending.progress !== undefined ? pending.progress : task.progress,
            }),
        };
    });
}

/**
 * Sort tasks so that:
 *  1. If the user has manually reordered rows, use that order.
 *  2. Otherwise: parent before children, blockers before the tasks they block.
 *
 * Uses a depth-first topological placement with a cycle guard.
 */
export function sortByHierarchy(tasks) {
    // Honour the manual drag-to-reorder order when set.
    if (state.rowOrderOverride.length > 0) {
        const byId   = new Map(tasks.map((t) => [t.id, t]));
        const result = [];
        for (const id of state.rowOrderOverride) {
            if (byId.has(id)) result.push(byId.get(id));
        }
        // Append any tasks not captured in the override (e.g. newly loaded).
        for (const t of tasks) {
            if (!result.includes(t)) result.push(t);
        }
        return result;
    }

    const byId   = new Map(tasks.map((t) => [t.id, t]));
    const result = [];
    const placed = new Set();

    function place(task) {
        if (placed.has(task.id)) return;
        if (placed.has('__visiting__' + task.id)) return; // cycle guard
        placed.add('__visiting__' + task.id);

        // 1. Place parent before this task
        const parentId = state.parentMap.get(task.id);
        if (parentId && byId.has(parentId) && !placed.has(parentId)) {
            place(byId.get(parentId));
        }

        // 2. Place all blockers before this task
        for (const blockerId of normalizeDeps(task.dependencies)) {
            if (byId.has(blockerId) && !placed.has(blockerId)) {
                place(byId.get(blockerId));
            }
        }

        placed.add(task.id);
        result.push(task);

        // 3. Place direct children immediately after
        for (const t of tasks) {
            if (!placed.has(t.id) && state.parentMap.get(t.id) === task.id) {
                place(t);
            }
        }

        // 4. Place directly blocked tasks immediately after
        for (const t of tasks) {
            if (!placed.has(t.id) && normalizeDeps(t.dependencies).includes(task.id)) {
                place(t);
            }
        }
    }

    for (const task of tasks) place(task);
    return result;
}

/**
 * Apply active label + title filters to the live tasks, then sort.
 * This is the function that should be passed to ganttInstance.refresh().
 */
export function getVisibleTasks() {
    const live   = getLiveTasks();
    const needle = state.titleFilter.toLowerCase();

    const filtered = live.filter((task) => {
        if (state.activeLabels.size > 0) {
            const labelNames = new Set((task._issue?.labels || []).map((l) => l.name));
            if (![...state.activeLabels].every((name) => labelNames.has(name))) return false;
        }
        if (needle) {
            const haystack = (task._issue?.title || task.name || '').toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        return true;
    });

    return sortByHierarchy(filtered);
}

/** Refresh the Gantt chart to reflect the latest live task state. */
export function refreshGanttDates() {
    state.ganttInstance?.refresh(getVisibleTasks());
}
