/**
 * Keyboard shortcut dialogs for "add blocker" and "add parent" flows.
 *
 * The 'b' and 'p' keys trigger these dialogs when a task is selected.
 * They accept an issue number from the user and call supplied callbacks.
 */

import { state } from './state.js';
import { getLiveTasks, recordChange, cascadeDateShift } from './tasks.js';
import { setStatus } from './config.js';

const blockedByDialog = document.getElementById('blocked-by-dialog');
const bbInput         = document.getElementById('bb-input');
const bbDesc          = document.getElementById('bb-desc');
const bbError         = document.getElementById('bb-error');
const bbConfirm       = document.getElementById('bb-confirm');
const bbClose         = document.getElementById('bb-close');
const bbCancel        = document.getElementById('bb-cancel');

const parentDialog = document.getElementById('parent-dialog');
const pdInput      = document.getElementById('pd-input');
const pdDesc       = document.getElementById('pd-desc');
const pdError      = document.getElementById('pd-error');
const pdConfirm    = document.getElementById('pd-confirm');
const pdClose      = document.getElementById('pd-close');
const pdCancel     = document.getElementById('pd-cancel');

// ─── Blocked-by dialog ────────────────────────────────────────────────────────

export function openBlockedByDialog(taskId) {
    const live = getLiveTasks();
    const task = live.find((t) => t.id === taskId);
    if (!task) return;
    bbDesc.textContent = `Add a dependency for #${task.id} "${task._issue.title}" — it will be blocked by the issue number you enter.`;
    bbInput.value = '';
    bbError.textContent = '';
    blockedByDialog.classList.remove('hidden');
    requestAnimationFrame(() => bbInput.focus());
}

function _closeBlockedByDialog() {
    blockedByDialog.classList.add('hidden');
}

function _confirmBlockedBy(onAddDependency) {
    const raw = bbInput.value.trim();
    const depId = raw.replace(/^#/, '');
    if (!depId || !/^\d+$/.test(depId)) {
        bbError.textContent = 'Please enter a valid issue number.';
        return;
    }
    if (depId === state.selectedTaskId) {
        bbError.textContent = 'An issue cannot depend on itself.';
        return;
    }
    const live = getLiveTasks();
    if (!live.find((t) => t.id === depId)) {
        bbError.textContent = `Issue #${depId} was not found in this repo's loaded issues.`;
        return;
    }
    _closeBlockedByDialog();

    // Auto-shift the selected issue to start after the blocker ends
    const blockerTask = live.find((t) => t.id === depId);
    if (blockerTask) {
        const blockerEnd = new Date(blockerTask.end);
        const myTask     = live.find((t) => t.id === state.selectedTaskId);
        if (myTask) {
            const myStart  = new Date(myTask.start);
            const myEnd    = new Date(myTask.end);
            const duration = myEnd - myStart;
            const newStart = new Date(blockerEnd);
            newStart.setDate(newStart.getDate() + 1);
            const newEnd  = new Date(newStart.getTime() + duration);
            const toDateStr = (d) => d.toISOString().slice(0, 10);
            recordChange(state.selectedTaskId, { start: toDateStr(newStart), end: toDateStr(newEnd) });
        }
    }

    onAddDependency?.(state.selectedTaskId, depId);
}

bbConfirm.addEventListener('click', () => _confirmBlockedBy());
bbCancel.addEventListener('click', _closeBlockedByDialog);
bbClose.addEventListener('click', _closeBlockedByDialog);
blockedByDialog.addEventListener('click', (e) => { if (e.target === blockedByDialog) _closeBlockedByDialog(); });
bbInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { _confirmBlockedBy(); }
    if (e.key === 'Escape') { _closeBlockedByDialog(); }
});

// ─── Parent dialog ────────────────────────────────────────────────────────────

export function openParentDialog(taskId) {
    const live = getLiveTasks();
    const task = live.find((t) => t.id === taskId);
    if (!task) return;
    pdDesc.textContent = `Set the parent issue for #${task.id} "${task._issue.title}". The child will be grouped below its parent in the chart.`;
    pdInput.value = '';
    pdError.textContent = '';
    parentDialog.classList.remove('hidden');
    requestAnimationFrame(() => pdInput.focus());
}

function _closeParentDialog() {
    parentDialog.classList.add('hidden');
}

function _confirmParent(onParentSet) {
    const raw = pdInput.value.trim();
    const parentId = raw.replace(/^#/, '');
    if (!parentId || !/^\d+$/.test(parentId)) {
        pdError.textContent = 'Please enter a valid issue number.';
        return;
    }
    if (parentId === state.selectedTaskId) {
        pdError.textContent = 'An issue cannot be its own parent.';
        return;
    }
    const live = getLiveTasks();
    if (!live.find((t) => t.id === parentId)) {
        pdError.textContent = `Issue #${parentId} was not found in this repo's loaded issues.`;
        return;
    }
    _closeParentDialog();

    // Update local parentMap and pending tracking
    state.parentMap.set(state.selectedTaskId, parentId);
    const taskInAll = state.allTasks.find((t) => t.id === state.selectedTaskId);
    if (taskInAll && !taskInAll._parentDeps.includes(parentId)) {
        taskInAll._parentDeps = [...taskInAll._parentDeps, parentId];
    }
    state.pendingParentChanges.set(state.selectedTaskId, parentId);

    onParentSet?.(state.selectedTaskId, parentId);
}

pdConfirm.addEventListener('click', () => _confirmParent());
pdCancel.addEventListener('click', _closeParentDialog);
pdClose.addEventListener('click', _closeParentDialog);
parentDialog.addEventListener('click', (e) => { if (e.target === parentDialog) _closeParentDialog(); });
pdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { _confirmParent(); }
    if (e.key === 'Escape') { _closeParentDialog(); }
});

export { _confirmBlockedBy, _confirmParent };
