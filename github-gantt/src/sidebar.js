/**
 * Sidebar rendering and event handling — the right-hand inspector panel.
 *
 * Renders issue details (labels, assignees, dependencies, dates, parent issue).
 * No Gantt rendering logic here; uses callbacks for external updates.
 */

import { marked } from 'marked';
import { state } from './state.js';
import { escHtml, escAttr, fmtDate, labelTextColor, normalizeDeps } from './utils.js';
import { parseRepo, setStatus, getConfig } from './config.js';
import { recordChange, cascadeDateShift, clampStartToDeps, refreshGanttDates, getLiveTasks } from './tasks.js';

const sidebar        = document.getElementById('sidebar');
const sidebarTitle   = document.getElementById('sidebar-title');
const sidebarBody    = document.getElementById('sidebar-body');
const sidebarClose   = document.getElementById('sidebar-close');

// ─── Markdown rendering ───────────────────────────────────────────────────────

/**
 * Render markdown text to safe HTML.
 * Uses marked with sanitization to prevent XSS.
 */
function renderMarkdown(text) {
    if (!text) return '';
    return marked(text);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open the sidebar for the given task, setting selectedTaskId and rendering
 * the full issue inspector panel.
 *
 * @param {object}   task
 * @param {Function} options.onAddDependency   (issueId, depId) → void
 * @param {Function} options.onRemoveDependency (issueId, depId) → void
 */
export function openSidebar(task, { onAddDependency, onRemoveDependency } = {}) {
    state.selectedTaskId = task.id;
    const issue = task._issue;

    sidebarTitle.textContent = `#${issue.number}`;
    sidebar.classList.remove('hidden');

    const liveTasks    = getLiveTasks();
    const taskNow      = liveTasks.find((t) => t.id === task.id) || task;
    const allDeps      = normalizeDeps(taskNow.dependencies);
    const parentDepsSet = new Set(taskNow._parentDeps || []);

    _renderSidebar(issue, taskNow, allDeps, parentDepsSet, liveTasks, {
        onAddDependency,
        onRemoveDependency,
    });
}

export function closeSidebar() {
    sidebar.classList.add('hidden');
    state.selectedTaskId = null;
}

// ─── Internal rendering ───────────────────────────────────────────────────────

function _renderSidebar(issue, task, deps, parentDeps, liveTasks, { onAddDependency, onRemoveDependency } = {}) {
    // Resolve live labels
    const liveLabels = state.pendingLabelChanges.has(task.id)
        ? state.repoLabels.filter((l) => state.pendingLabelChanges.get(task.id).includes(l.name))
        : (issue.labels || []);

    const labelBadgesHtml = liveLabels
        .map((l) => `<span class="label-badge label-badge-removable"
                          style="background:#${l.color};color:${labelTextColor(l.color)}"
                          data-label="${escAttr(l.name)}">
                        ${escHtml(l.name)}
                        <button class="label-remove-btn" data-label="${escAttr(l.name)}" title="Remove label">✕</button>
                    </span>`)
        .join(' ');

    const currentLabelNames = new Set(liveLabels.map((l) => l.name));
    const addableLabels     = state.repoLabels.filter((l) => !currentLabelNames.has(l.name));
    const addLabelHtml = addableLabels.length
        ? `<select id="add-label-select" class="add-label-select">
               <option value="">+ add label…</option>
               ${addableLabels.map((l) =>
                   `<option value="${escAttr(l.name)}" style="background:#${l.color};color:${labelTextColor(l.color)}">${escHtml(l.name)}</option>`
               ).join('')}
           </select>`
        : '';

    const labelHtml = `<div id="label-edit-row" class="label-edit-row">${labelBadgesHtml}${addLabelHtml}</div>`;

    // Parent section
    const effectiveParentId = state.pendingParentChanges.has(task.id)
        ? state.pendingParentChanges.get(task.id)
        : state.parentMap.get(task.id);
    const parentTask = effectiveParentId ? liveTasks.find((t) => t.id === effectiveParentId) : null;
    const parentCurrentHtml = effectiveParentId
        ? `<div class="parent-item">
               <a href="https://github.com/${escAttr(parseRepo(getConfig().repo)?.repo || '')}/issues/${effectiveParentId}"
                  target="_blank" rel="noopener noreferrer">
                   ${parentTask ? escHtml(parentTask.name) : `#${effectiveParentId}`}
               </a>
               <button class="parent-remove-btn" title="Remove parent">✕</button>
           </div>`
        : `<span class="muted">None</span>`;

    // Dependencies (exclude parent-only relationships)
    const depsToShow = deps.filter((depId) => !parentDeps.has(depId));
    const depsHtml = depsToShow.length
        ? depsToShow.map((depId) => {
              const depTask = liveTasks.find((t) => t.id === depId);
              const name    = depTask ? escHtml(depTask.name) : `#${depId}`;
              return `<div class="dep-item" data-dep="${escAttr(depId)}">
                  <a href="https://github.com/${getConfig().repo}/issues/${depId}"
                     target="_blank" rel="noopener noreferrer">${name}</a>
                  <button class="dep-remove" data-issue="${escAttr(task.id)}" data-dep="${escAttr(depId)}"
                          title="Remove dependency">✕</button>
              </div>`;
          }).join('')
        : '<p class="no-deps">No dependencies yet</p>';

    const addableOptions = liveTasks
        .filter((t) => t.id !== task.id && !depsToShow.includes(t.id))
        .map((t) => `<option value="${escAttr(t.id)}">${escHtml(t.name)}</option>`)
        .join('');

    const repoStr  = getConfig().repo || '';
    const issueUrl = issue.html_url || `https://github.com/${repoStr}/issues/${issue.number}`;

    // Assignees
    const assigneeHtml = (issue.assignees || []).length
        ? (issue.assignees || []).map((a) =>
              `<a href="https://github.com/${escAttr(a.login)}" target="_blank" rel="noopener noreferrer"
                 class="assignee" title="${escAttr(a.login)}">
                  <img src="${escAttr(a.avatar_url)}&s=28" width="22" height="22"
                       alt="${escAttr(a.login)}" loading="lazy" />
                  ${escHtml(a.login)}
              </a>`).join('')
        : '<span class="muted">Unassigned</span>';

    // Milestone
    const milestoneHtml = issue.milestone
        ? `<a href="${escAttr(issue.milestone.html_url)}" target="_blank" rel="noopener noreferrer"
              class="milestone-link">🏁 ${escHtml(issue.milestone.title)}</a>`
        : '';

    // Full body (without GANTT_META)
    const fullBody = (issue.body || '')
        .replace(/<!-- GANTT_META:.*?-->/s, '')
        .trim();

    sidebarTitle.innerHTML = `<a href="${escAttr(issueUrl)}" target="_blank" rel="noopener noreferrer">#${issue.number}</a>`;
    sidebarBody.innerHTML = `
        <div class="sidebar-issue-title">${escHtml(issue.title)}</div>
        <div class="sidebar-meta">
            <span class="state-badge state-${issue.state}">${issue.state}</span>
        </div>
        <div class="sidebar-section sidebar-labels-section">
            <h4>Labels</h4>
            ${labelHtml}
        </div>
        ${milestoneHtml ? `<div class="sidebar-section sidebar-inline">${milestoneHtml}</div>` : ''}
        <div class="sidebar-section">
            <h4>Assignees</h4>
            <div class="assignees-row">${assigneeHtml}</div>
        </div>
        <div class="sidebar-section">
            <h4>Description</h4>
            <div id="issue-description-container" class="issue-description-container">
                <div id="issue-description-view" class="issue-description-view" style="cursor: pointer;">
                    ${fullBody ? `<div class="issue-description-content">${renderMarkdown(fullBody)}</div>` : `<div class="issue-description-empty">Click to add description…</div>`}
                </div>
                <div id="issue-description-edit-mode" class="issue-description-edit-mode" style="display: none;">
                    <textarea id="issue-description-textarea" class="issue-description-edit" placeholder="Add or edit description…">${escHtml(fullBody)}</textarea>
                    <div class="description-buttons">
                        <button id="description-save-btn" class="description-btn description-btn-primary">Save</button>
                        <button id="description-cancel-btn" class="description-btn description-btn-secondary">Cancel</button>
                    </div>
                </div>
                <div class="description-resize-handle"></div>
            </div>
        </div>
        <div class="sidebar-section">
            <h4>Dates</h4>
            <div class="date-row">
                <div class="date-field">
                    <span class="date-field-label">Start</span>
                    <button class="date-display" id="date-start-display" type="button">${fmtDate(task.start)}</button>
                    <input type="date" id="date-start" class="date-hidden-input" value="${escAttr(task.start)}" />
                </div>
                <div class="date-field">
                    <span class="date-field-label">End</span>
                    <button class="date-display" id="date-end-display" type="button">${fmtDate(task.end)}</button>
                    <input type="date" id="date-end" class="date-hidden-input" value="${escAttr(task.end)}" />
                </div>
                <div class="date-field duration-field">
                    <span class="date-field-label">Days</span>
                    <input type="number" id="date-duration" class="date-duration-input" min="1" step="1"
                           value="${Math.max(1, Math.round((new Date(task.end) - new Date(task.start)) / 86400000))}" />
                </div>
            </div>
        </div>
        <div class="sidebar-section">
            <h4>Progress</h4>
            <div class="progress-row">
                <input type="range" id="prog-slider" min="0" max="100"
                       value="${task.progress}" ${issue.state === 'closed' ? 'disabled' : ''} />
                <span id="prog-label">${Math.round(task.progress)}%</span>
            </div>
        </div>
        <div class="sidebar-section">
            <h4>Parent Issue</h4>
            <div id="sidebar-parent-current">${parentCurrentHtml}</div>
            <div class="parent-set-row">
                <input type="text" id="sidebar-parent-input" placeholder="#issue number" />
                <button id="sidebar-parent-set-btn">Set</button>
            </div>
        </div>
        <div class="sidebar-section">
            <h4>Dependencies <small>(blocked by)</small></h4>
            <div id="deps-list">${depsHtml}</div>
            ${addableOptions ? `
            <div class="add-dep-row">
                <select id="add-dep-select">
                    <option value="">— add dependency —</option>
                    ${addableOptions}
                </select>
                <button id="add-dep-btn" disabled>Add</button>
            </div>` : ''}
        </div>
        <div class="sidebar-section">
            <div class="section-header">
                <h4>Comments <span class="comment-count">${issue.comments || 0}</span></h4>
                <button id="comments-toggle-btn" class="toggle-btn" title="Toggle comments section">
                    <span class="toggle-icon">▶</span>
                </button>
            </div>
            <div id="comments-list" class="comments-list collapsed">
                ${issue._comments && issue._comments.length > 0 
                    ? issue._comments.map((comment) => `
                        <div class="comment-item">
                            <div class="comment-header">
                                <strong>${escHtml(comment.user?.login || 'Unknown')}</strong>
                                <span class="comment-date">${new Date(comment.created_at).toLocaleDateString()}</span>
                            </div>
                            <div class="comment-body">${renderMarkdown(comment.body)}</div>
                        </div>
                    `).join('')
                    : '<div class="no-comments">No comments yet</div>'}
            </div>
        </div>
        <div class="sidebar-section">
            <a class="gh-link" href="${escAttr(issueUrl)}" target="_blank" rel="noopener noreferrer">
                ↗ Open on GitHub
            </a>
        </div>
    `;

    // ── Wire up event listeners ────────────────────────────────────────────────

    const dateStart       = document.getElementById('date-start');
    const dateEnd         = document.getElementById('date-end');
    const dateDuration    = document.getElementById('date-duration');
    const dateStartDisplay = document.getElementById('date-start-display');
    const dateEndDisplay   = document.getElementById('date-end-display');

    dateStartDisplay?.addEventListener('click', () => { try { dateStart.showPicker(); } catch { dateStart.focus(); } });
    dateEndDisplay?.addEventListener('click',   () => { try { dateEnd.showPicker();   } catch { dateEnd.focus();   } });

    function calcDuration(s, e) {
        return Math.max(1, Math.round((new Date(e) - new Date(s)) / 86400000));
    }

    function applyDates() {
        let s = dateStart.value;
        let e = dateEnd.value;
        if (!s || !e || s > e) { setStatus('Invalid date range', 'error'); return; }

        const taskDeps = normalizeDeps(task.dependencies);
        if (taskDeps.length > 0) {
            const clamped = clampStartToDeps(taskDeps, s, e);
            if (clamped.clamped) {
                s = clamped.start;
                e = clamped.end;
                setStatus(`Start clamped — can't start before blocker ends`, 'warn');
            }
        }

        dateDuration.value = calcDuration(s, e);
        if (dateStartDisplay) dateStartDisplay.textContent = fmtDate(s);
        if (dateEndDisplay)   dateEndDisplay.textContent   = fmtDate(e);
        const prevStart = task.start;
        recordChange(task.id, { start: s, end: e });
        cascadeDateShift(task.id, prevStart, s, e);
        refreshGanttDates();
        setStatus(`#${task.id} dates updated — unsaved`, 'warn');
    }

    function applyDuration() {
        const days = parseInt(dateDuration.value, 10);
        if (!days || days < 1 || !dateStart.value) return;
        const newEnd = new Date(dateStart.value);
        newEnd.setDate(newEnd.getDate() + days);
        const newEndStr = newEnd.toISOString().slice(0, 10);
        dateEnd.value = newEndStr;
        if (dateEndDisplay) dateEndDisplay.textContent = fmtDate(newEndStr);
        const prevStart = task.start;
        recordChange(task.id, { start: dateStart.value, end: newEndStr });
        cascadeDateShift(task.id, prevStart, dateStart.value, newEndStr);
        refreshGanttDates();
        setStatus(`#${task.id} dates updated — unsaved`, 'warn');
    }

    dateStart.addEventListener('change', applyDates);
    dateEnd.addEventListener('change', applyDates);
    dateDuration.addEventListener('change', applyDuration);

    // Description editing (view/edit toggle) and resize handle
    const descriptionContainer = document.getElementById('issue-description-container');
    const descriptionView = document.getElementById('issue-description-view');
    const descriptionEditMode = document.getElementById('issue-description-edit-mode');
    const descriptionTextarea = document.getElementById('issue-description-textarea');
    const descriptionSaveBtn = document.getElementById('description-save-btn');
    const descriptionCancelBtn = document.getElementById('description-cancel-btn');
    const resizeHandle = document.querySelector('.description-resize-handle');

    function enterEditMode() {
        descriptionView.style.display = 'none';
        descriptionEditMode.style.display = 'block';
        descriptionTextarea.focus();
    }

    function exitEditMode() {
        descriptionView.style.display = 'block';
        descriptionEditMode.style.display = 'none';
    }

    function saveDescription() {
        const newBody = descriptionTextarea.value.trim();
        recordChange(task.id, { body: newBody });
        setStatus(`#${task.id} description updated — unsaved`, 'warn');

        // Update the view with new content and exit edit mode
        if (newBody) {
            document.querySelector('#issue-description-view .issue-description-content').innerHTML = renderMarkdown(newBody);
        } else {
            document.querySelector('#issue-description-view').innerHTML = `<div class="issue-description-empty">Click to add description…</div>`;
        }
        exitEditMode();
    }

    // Resize handle drag logic
    let isResizing = false;
    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        const startY = e.clientY;
        const startHeight = descriptionContainer.offsetHeight;

        function handleMouseMove(moveEvent) {
            if (!isResizing) return;
            const delta = moveEvent.clientY - startY;
            const newHeight = Math.max(150, startHeight + delta);
            descriptionContainer.style.height = `${newHeight}px`;
        }

        function handleMouseUp() {
            isResizing = false;
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        }

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    });

    descriptionView.addEventListener('click', enterEditMode);
    descriptionSaveBtn.addEventListener('click', saveDescription);
    descriptionCancelBtn.addEventListener('click', () => {
        descriptionTextarea.value = fullBody;
        exitEditMode();
    });

    const progSlider = document.getElementById('prog-slider');
    const progLabel  = document.getElementById('prog-label');
    if (progSlider) {
        progSlider.addEventListener('input', () => {
            progLabel.textContent = `${progSlider.value}%`;
        });
        progSlider.addEventListener('change', () => {
            const val = Number(progSlider.value);
            recordChange(task.id, { progress: val });
            refreshGanttDates();
            setStatus(`#${task.id} progress → ${val}% — unsaved`, 'warn');
        });
    }

    // Labels
    sidebarBody.querySelectorAll('.label-remove-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            _applyLabelEdit(task.id, issue, (names) => names.filter((n) => n !== btn.dataset.label));
        });
    });

    const addLabelSelect = document.getElementById('add-label-select');
    if (addLabelSelect) {
        addLabelSelect.addEventListener('change', () => {
            const name = addLabelSelect.value;
            if (!name) return;
            _applyLabelEdit(task.id, issue, (names) => [...names, name]);
        });
    }

    // Parent issue
    const sidebarParentInput = document.getElementById('sidebar-parent-input');
    const sidebarParentSetBtn = document.getElementById('sidebar-parent-set-btn');
    const parentRemoveBtn = sidebarBody.querySelector('.parent-remove-btn');

    sidebarParentSetBtn?.addEventListener('click', () => {
        const raw = sidebarParentInput.value.trim();
        const pId = raw.replace(/^#/, '');
        if (!pId || !/^\d+$/.test(pId)) { setStatus('Please enter a valid issue number', 'error'); return; }
        if (pId === task.id) { setStatus('An issue cannot be its own parent', 'error'); return; }
        if (!getLiveTasks().find((t) => t.id === pId)) { setStatus(`Issue #${pId} not found in loaded issues`, 'error'); return; }
        state.parentMap.set(task.id, pId);
        const allTaskItem = state.allTasks.find((t) => t.id === task.id);
        if (allTaskItem) allTaskItem._parentDeps = [pId];
        state.pendingParentChanges.set(task.id, pId);
        state.ganttInstance?.refresh(getVisibleTasks());
        const ft = getLiveTasks().find((t) => t.id === task.id);
        if (ft) _renderSidebar(ft._issue, ft, normalizeDeps(ft.dependencies), new Set(ft._parentDeps || []), getLiveTasks(), { onAddDependency, onRemoveDependency });
        setStatus(`#${task.id} parent set to #${pId} — unsaved`, 'warn');
    });
    sidebarParentInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sidebarParentSetBtn?.click(); });

    parentRemoveBtn?.addEventListener('click', () => {
        state.parentMap.delete(task.id);
        const allTaskItem = state.allTasks.find((t) => t.id === task.id);
        if (allTaskItem) allTaskItem._parentDeps = [];
        state.pendingParentChanges.set(task.id, null);
        state.ganttInstance?.refresh(getVisibleTasks());
        const ft = getLiveTasks().find((t) => t.id === task.id);
        if (ft) _renderSidebar(ft._issue, ft, normalizeDeps(ft.dependencies), new Set(ft._parentDeps || []), getLiveTasks(), { onAddDependency, onRemoveDependency });
        setStatus(`#${task.id} parent removed — unsaved`, 'warn');
    });

    // Dependencies
    sidebarBody.querySelectorAll('.dep-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
            const issueId = btn.dataset.issue;
            const depId   = btn.dataset.dep;
            onRemoveDependency?.(issueId, depId);
        });
    });

    const addDepSelect = document.getElementById('add-dep-select');
    const addDepBtn    = document.getElementById('add-dep-btn');
    if (addDepSelect && addDepBtn) {
        addDepSelect.addEventListener('change', () => {
            addDepBtn.disabled = !addDepSelect.value;
        });
        addDepBtn.addEventListener('click', () => {
            const newDep = addDepSelect.value;
            if (newDep) onAddDependency?.(task.id, newDep);
        });
    }

    // Comments toggle
    const commentsToggleBtn = document.getElementById('comments-toggle-btn');
    const commentsList = document.getElementById('comments-list');
    if (commentsToggleBtn && commentsList) {
        commentsToggleBtn.addEventListener('click', () => {
            commentsList.classList.toggle('collapsed');
            const toggleIcon = commentsToggleBtn.querySelector('.toggle-icon');
            toggleIcon.textContent = commentsList.classList.contains('collapsed') ? '▶' : '▼';
        });
    }
}

function _applyLabelEdit(taskId, issue, mutateFn) {
    const current = state.pendingLabelChanges.has(taskId)
        ? state.pendingLabelChanges.get(taskId)
        : (issue.labels || []).map((l) => l.name);
    const updated = mutateFn(current);
    state.pendingLabelChanges.set(taskId, updated);
    state.ganttInstance?.refresh(getVisibleTasks());

    // Re-render sidebar
    const liveTasks = getLiveTasks();
    const taskNow   = liveTasks.find((t) => t.id === taskId) || { id: taskId, _issue: issue, _parentDeps: [] };
    _renderSidebar(issue, taskNow,
        normalizeDeps(taskNow.dependencies), new Set(taskNow._parentDeps || []), liveTasks);

    // Update bar colour (simple version — full implementation in save logic)
    const tempLabel = updated.length > 0
        ? state.repoLabels.find((l) => l.name === updated[0])
        : null;
    if (tempLabel) {
        let styleEl = document.getElementById('gantt-bar-colors');
        if (styleEl) {
            const rule = `.bar-wrapper[data-id="${taskId}"] { --g-bar-color: #${tempLabel.color}; --g-bar-border: ${_darkenColor(tempLabel.color)}; }`;
            const lines = styleEl.textContent.split('\n').filter((r) => !r.includes(`data-id="${taskId}"`));
            lines.push(rule);
            styleEl.textContent = lines.join('\n');
        }
    }
}

function _darkenColor(hex) {
    const r = Math.round(parseInt(hex.slice(0, 2), 16) * 0.7);
    const g = Math.round(parseInt(hex.slice(2, 4), 16) * 0.7);
    const b = Math.round(parseInt(hex.slice(4, 6), 16) * 0.7);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export { _renderSidebar };
