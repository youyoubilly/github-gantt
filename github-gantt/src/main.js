/**
 * GitHub Gantt — main application logic
 *
 * Flow:
 *  1. On load: show Config screen if no token/repo stored, else go straight to step 2.
 *  2. Fetch all GitHub issues → convert to Gantt tasks → render chart.
 *  3. User edits:
 *     - Drag bar                → records date change in pendingChanges
 *     - Drag progress handle    → records progress change in pendingChanges
 *     - Click bar               → opens sidebar (shows & edits dependencies)
 *  4. "Save" button → writes GANTT_META comments back to every changed issue.
 */

import Gantt from 'frappe-gantt';
import '../../gantt/src/styles/gantt.css';
import '../../gantt/src/styles/themes.css';
import { fetchAllIssues, fetchParentMap, fetchRepoLabels, updateIssueBody, updateIssueLabels, addSubIssue, validateRepo } from './github.js';
import { issueToTask, buildUpdatedBody } from './mapper.js';
import './style.css';

// ─── State ────────────────────────────────────────────────────────────────────

let ganttInstance = null;
let allIssues = [];      // raw GitHub issues
let allTasks = [];       // Gantt task objects
/** @type {Map<string, {start?:string, end?:string, progress?:number, deps?:string[]}>} */
let pendingChanges = new Map();
let pendingParentChanges = new Map(); // childId(string) → parentId(string), assigned but not yet saved
let activeLabels = new Set();  // label names selected as active filters
let parentMap = new Map();     // childId(string) → parentId(string), from GitHub sub-issues
let selectedTaskId = null;     // id of the last clicked/active task (for keyboard shortcuts)
let titleFilter = '';          // case-insensitive title filter string
let repoLabels = [];           // all labels defined in the repo [{name, color}, ...]
let pendingLabelChanges = new Map(); // issueId(string) → label-names array (pending, not yet saved)

// ─── DOM Refs ─────────────────────────────────────────────────────────────────

const configScreen  = document.getElementById('config-screen');
const mainScreen    = document.getElementById('main-screen');
const configForm    = document.getElementById('config-form');
const ghTokenInput  = document.getElementById('gh-token');
const ghRepoInput   = document.getElementById('gh-repo');
const configError   = document.getElementById('config-error');
const repoLabel     = document.getElementById('repo-label');
const ganttWrapper  = document.getElementById('gantt-wrapper');
const saveBtn       = document.getElementById('save-btn');
const reloadBtn     = document.getElementById('reload-btn');
const settingsBtn   = document.getElementById('settings-btn');
const statusBar     = document.getElementById('status-bar');
const sidebar          = document.getElementById('sidebar');
const sidebarTitle     = document.getElementById('sidebar-title');
const sidebarBody      = document.getElementById('sidebar-body');
const sidebarClose     = document.getElementById('sidebar-close');
const viewBtns         = document.querySelectorAll('[data-view]');
const settingsModal    = document.getElementById('settings-modal');
const settingsForm     = document.getElementById('settings-form');
const sTokenInput      = document.getElementById('s-gh-token');
const sRepoInput       = document.getElementById('s-gh-repo');
const settingsError    = document.getElementById('settings-error');
const modalClose       = document.getElementById('modal-close');
const settingsLogout   = document.getElementById('settings-logout');
const toolbar          = document.querySelector('.toolbar');
const toolbarHideBtn   = document.getElementById('toolbar-hide-btn');
const toolbarCollapsed = document.getElementById('toolbar-collapsed');
const toolbarShowBtn   = document.getElementById('toolbar-show-btn');
const labelFilterBar   = document.getElementById('label-filter-bar');
const labelFilterPills = document.getElementById('label-filter-pills');
const labelFilterClear = document.getElementById('label-filter-clear');
const titleFilterInput = document.getElementById('title-filter');
const blockedByDialog  = document.getElementById('blocked-by-dialog');
const bbInput          = document.getElementById('bb-input');
const bbDesc           = document.getElementById('bb-desc');
const bbError          = document.getElementById('bb-error');
const bbConfirm        = document.getElementById('bb-confirm');
const bbClose          = document.getElementById('bb-close');
const bbCancel         = document.getElementById('bb-cancel');
const parentDialog     = document.getElementById('parent-dialog');
const pdInput          = document.getElementById('pd-input');
const pdDesc           = document.getElementById('pd-desc');
const pdError          = document.getElementById('pd-error');
const pdConfirm        = document.getElementById('pd-confirm');
const pdClose          = document.getElementById('pd-close');
const pdCancel         = document.getElementById('pd-cancel');

// ─── Config helpers ───────────────────────────────────────────────────────────

function getConfig() {
    return {
        token: localStorage.getItem('gh_token') || '',
        repo:  localStorage.getItem('gh_repo')  || '',
    };
}

function saveConfig(token, repo) {
    localStorage.setItem('gh_token', token);
    localStorage.setItem('gh_repo', repo);
}

function parseRepo(repoStr) {
    const parts = repoStr.trim().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function setStatus(msg, type = 'info') {
    statusBar.textContent = msg;
    statusBar.className = `status-bar status-${type}`;
}

// ─── Pending changes ──────────────────────────────────────────────────────────

function recordChange(issueNumber, partial) {
    const existing = pendingChanges.get(issueNumber) || {};
    pendingChanges.set(issueNumber, { ...existing, ...partial });
    updateSaveBtn();
}

/**
 * Cascade a date shift from a moved issue to everything that depends on it
 * (i.e. is "blocked by" it), recursively, preserving each blocked issue's
 * duration.  Only shifts an issue if its current start is BEFORE the blocker's
 * new end (i.e. there is still an overlap that needs resolving).
 *
 * @param {string} movedId   - task/issue id of the issue whose dates changed
 * @param {string} prevStart - old start ISO string (before the move)
 * @param {string} newStart  - new start ISO string
 * @param {string} newEnd    - new end ISO string
 * @param {Set<string>} visited - guard against cycles
 */
function cascadeDateShift(movedId, prevStart, newStart, newEnd, visited = new Set()) {
    if (visited.has(movedId)) return;
    visited.add(movedId);

    const deltaMs = new Date(newStart) - new Date(prevStart);
    if (deltaMs === 0) return;

    const live = getLiveTasks();

    // Find all tasks whose dep list contains movedId
    const dependents = live.filter((t) => {
        const deps = normalizeDeps(t.dependencies);
        return deps.includes(String(movedId));
    });

    for (const dep of dependents) {
        if (visited.has(dep.id)) continue;

        // Only push forward (don't pull backward when blocker moves earlier)
        if (deltaMs < 0) continue;

        const depStart = new Date(dep.start);
        const depEnd   = new Date(dep.end);
        const blockerEnd = new Date(newEnd);

        // If the dependent already starts after the blocker ends, no adjustment needed
        if (depStart >= blockerEnd) continue;

        const duration = depEnd - depStart;      // preserve duration
        const prevDepStart = dep.start;
        const shiftedStart = new Date(blockerEnd);
        shiftedStart.setDate(shiftedStart.getDate() + 1); // start the day after blocker ends
        const shiftedEnd   = new Date(shiftedStart.getTime() + duration);

        const newDepStart = shiftedStart.toISOString().slice(0, 10);
        const newDepEnd   = shiftedEnd.toISOString().slice(0, 10);

        recordChange(dep.id, { start: newDepStart, end: newDepEnd });

        // Recurse: this dependent is now also a "blocker" for its own dependents
        cascadeDateShift(dep.id, prevDepStart, newDepStart, newDepEnd, visited);
    }
}

function updateSaveBtn() {
    const n = pendingChanges.size + pendingLabelChanges.size + pendingParentChanges.size;
    saveBtn.disabled = n === 0;
    saveBtn.textContent = n > 0 ? `💾 Save (${n} changed)` : '💾 Save';
}

// ─── Task ↔ pending merge ─────────────────────────────────────────────────────

/**
 * Normalize a task's dependencies to a plain string array regardless of
 * whether Gantt has already converted it to an array internally.
 */
function normalizeDeps(dependencies) {
    if (!dependencies) return [];
    if (Array.isArray(dependencies)) return dependencies.filter(Boolean);
    return dependencies.split(',').map((d) => d.trim()).filter(Boolean);
}

/**
 * Return the current live tasks, merging any pending changes that haven't been
 * saved yet so the Gantt chart stays in sync after a dependency edit.
 * Dependencies are always returned as comma-separated strings so Gantt's
 * setup_tasks can process them correctly on the next refresh().
 */
function getLiveTasks() {
    return allTasks.map((task) => {
        const pending = pendingChanges.get(task.id);
        // Meta deps: pending overrides stored _metaDeps.
        // Strip any parent IDs — parent relationship is NOT a blocking dep and must
        // never draw an arrow or appear in the Dependencies section.
        const rawMeta    = pending?.deps ?? (task._metaDeps || []);
        const parentDeps = task._parentDeps || [];
        const parentSet  = new Set(parentDeps.map(String));
        const metaDeps   = rawMeta.filter((d) => !parentSet.has(String(d)));
        // Only metaDeps drive gantt arrows (blocked-by)
        const depsStr = [...new Set(metaDeps)].join(',');

        // Indent the task label to visually show depth under parent
        const parentId = parentMap.get(task.id);
        const prefix = parentId ? '  └ ' : '';
        const state = task._issue?.state;
        const stateTag = state === 'closed' ? ' ✓' : state === 'open' ? ' ●' : '';
        const baseName = `#${task.id} ${task._issue?.title || task.name}${stateTag}`;

        return {
            ...task,
            name: prefix + baseName,
            _metaDeps: metaDeps,
            _parentDeps: parentDeps,
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
 *  1. Parent issues come before their children.
 *  2. Blocking issues come before the issues they block (dependency order).
 * Both rules use a topological placement with cycle guards.
 */
function sortByHierarchy(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const result = [];
    const placed = new Set();

    function place(task) {
        if (placed.has(task.id)) return;
        if (placed.has('__visiting__' + task.id)) return; // cycle guard — skip rather than infinite loop
        placed.add('__visiting__' + task.id);

        // 1. Place parent first
        const parentId = parentMap.get(task.id);
        if (parentId && byId.has(parentId) && !placed.has(parentId)) {
            place(byId.get(parentId));
        }

        // 2. Place all blockers first (tasks this task depends on / is blocked by)
        const blockers = normalizeDeps(task.dependencies);
        for (const blockerId of blockers) {
            if (byId.has(blockerId) && !placed.has(blockerId)) {
                place(byId.get(blockerId));
            }
        }

        placed.add(task.id);
        result.push(task);

        // 3. Place direct children immediately after
        for (const t of tasks) {
            if (!placed.has(t.id) && parentMap.get(t.id) === task.id) {
                place(t);
            }
        }

        // 4. Place directly blocked tasks (tasks that depend on this one) immediately after
        for (const t of tasks) {
            if (!placed.has(t.id)) {
                const tDeps = normalizeDeps(t.dependencies);
                if (tDeps.includes(task.id)) place(t);
            }
        }
    }

    for (const task of tasks) place(task);
    return result;
}

// ─── Label filter ────────────────────────────────────────────────────────────

function getVisibleTasks() {
    const live = getLiveTasks();
    const needle = titleFilter.toLowerCase();
    const filtered = live.filter((task) => {
        // Label AND filter
        if (activeLabels.size > 0) {
            const labelNames = new Set((task._issue?.labels || []).map((l) => l.name));
            if (![...activeLabels].every((name) => labelNames.has(name))) return false;
        }
        // Title filter (case-insensitive)
        if (needle) {
            const haystack = (task._issue?.title || task.name || '').toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        return true;
    });
    return sortByHierarchy(filtered);
}

function buildLabelFilter(issues) {
    const labelMap = new Map(); // name → {color, textColor}
    for (const issue of issues) {
        for (const label of (issue.labels || [])) {
            if (!labelMap.has(label.name)) {
                labelMap.set(label.name, {
                    color: label.color,
                    textColor: labelTextColor(label.color),
                });
            }
        }
    }

    if (labelMap.size === 0) {
        labelFilterBar.classList.add('hidden');
        return;
    }

    const sorted = [...labelMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    labelFilterPills.innerHTML = sorted
        .map(([name, { color, textColor }]) => {
            const active = activeLabels.has(name) ? ' active' : '';
            return `<button class="label-filter-pill${active}" data-label="${escAttr(name)}"
                        style="background:#${escAttr(color)};color:${escAttr(textColor)}"
                    >${escHtml(name)}</button>`;
        })
        .join('');

    labelFilterBar.classList.remove('hidden');
    updateFilterClearBtn();

    labelFilterPills.querySelectorAll('.label-filter-pill').forEach((pill) => {
        pill.addEventListener('click', () => {
            const name = pill.dataset.label;
            if (activeLabels.has(name)) {
                activeLabels.delete(name);
                pill.classList.remove('active');
            } else {
                activeLabels.add(name);
                pill.classList.add('active');
            }
            updateFilterClearBtn();
            applyLabelFilter();
        });
    });
}

function updateFilterClearBtn() {
    if (activeLabels.size > 0) {
        labelFilterClear.classList.remove('hidden');
    } else {
        labelFilterClear.classList.add('hidden');
    }
}

function applyLabelFilter() {
    if (!ganttInstance) return;
    ganttInstance.refresh(getVisibleTasks());
}

// ─── Gantt rendering ──────────────────────────────────────────────────────────

function renderGantt(tasks) {
    ganttWrapper.innerHTML = '';

    ganttInstance = new Gantt('#gantt-wrapper', tasks, {
        view_mode: 'Week',
        readonly_progress: false,
        readonly_dates: false,
        today_button: true,
        popup: false,        // disable built-in popup; we use the sidebar
        popup_on: 'click',   // ignored when popup:false, but keeps the default

        on_click(task) {
            openSidebar(task);
        },

        on_date_change(task, start, end) {
            const prevStart = task.start instanceof Date
                ? task.start.toISOString().slice(0, 10)
                : String(task.start).slice(0, 10);
            let startStr = start.toISOString().slice(0, 10);
            let endStr   = end.toISOString().slice(0, 10);

            // Clamp start to the day after the latest blocker's end
            const taskDeps = normalizeDeps(task.dependencies);
            if (taskDeps.length > 0) {
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
                        // Preserve duration while clamping
                        const duration = new Date(endStr) - new Date(startStr);
                        startStr = minStartStr;
                        endStr = new Date(minStart.getTime() + duration).toISOString().slice(0, 10);
                        setStatus(`#${task.id} start clamped — can't start before blocker ends`, 'warn');
                    }
                }
            }

            recordChange(task.id, { start: startStr, end: endStr });
            cascadeDateShift(task.id, prevStart, startStr, endStr);
            refreshGanttDates();
            setStatus(`#${task.id} dates updated — unsaved`, 'warn');
        },

        on_progress_change(task, progress) {
            recordChange(task.id, { progress: Math.round(progress) });
            setStatus(`#${task.id} progress → ${Math.round(progress)}% — unsaved`, 'warn');
        },

        on_view_change(mode) {
            viewBtns.forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.view === mode.name);
            });
        },
    });

    // Block wheel scroll on the actual scroll container frappe-gantt creates.
    // Must be attached here (not at page load) because the element is created
    // fresh each time renderGantt() runs.
    const ganttContainer = ganttWrapper.querySelector('.gantt-container');
    if (ganttContainer) {
        ganttContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
        }, { passive: false });
    }
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function openSidebar(task) {
    selectedTaskId = task.id;
    const issue = task._issue;

    sidebarTitle.textContent = `#${issue.number}`;
    sidebar.classList.remove('hidden');

    // Build dependencies from live tasks (merging pending changes).
    // getLiveTasks() always returns deps as a string, so normalizeDeps handles
    // it correctly even if Gantt has internally converted deps to an array.
    const liveTasks = getLiveTasks();
    const taskNow = liveTasks.find((t) => t.id === task.id) || task;
    const allDeps      = normalizeDeps(taskNow.dependencies);
    const parentDepsSet = new Set(taskNow._parentDeps || []);

    renderSidebar(issue, taskNow, allDeps, parentDepsSet, liveTasks);
}

function renderSidebar(issue, task, deps, parentDeps, liveTasks) {
    // Resolve live labels: pending overrides issue labels
    const liveLabels = pendingLabelChanges.has(task.id)
        ? repoLabels.filter((l) => pendingLabelChanges.get(task.id).includes(l.name))
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
    const addableLabels = repoLabels.filter((l) => !currentLabelNames.has(l.name));
    const addLabelHtml = addableLabels.length
        ? `<select id="add-label-select" class="add-label-select">
               <option value="">+ add label…</option>
               ${addableLabels.map((l) =>
                   `<option value="${escAttr(l.name)}" style="background:#${l.color};color:${labelTextColor(l.color)}">${escHtml(l.name)}</option>`
               ).join('')}
           </select>`
        : '';

    const labelHtml = `<div id="label-edit-row" class="label-edit-row">${labelBadgesHtml}${addLabelHtml}</div>`;

    // Current effective parent (pending overrides persisted)
    const effectiveParentId = pendingParentChanges.has(task.id)
        ? pendingParentChanges.get(task.id)
        : parentMap.get(task.id);
    const parentTask = effectiveParentId ? liveTasks.find((t) => t.id === effectiveParentId) : null;
    const parentCurrentHtml = effectiveParentId
        ? `<div class="parent-item">
               <a href="https://github.com/${escAttr(getConfig().repo)}/issues/${effectiveParentId}"
                  target="_blank" rel="noopener noreferrer">
                   ${parentTask ? escHtml(parentTask.name) : `#${effectiveParentId}`}
               </a>
               <button class="parent-remove-btn" title="Remove parent">✕</button>
           </div>`
        : `<span class="muted">None</span>`;

    // Never show parent-only relationships in the blocked-by section —
    // they are already shown in the dedicated Parent Issue section.
    const depsToShow = deps.filter((depId) => !parentDeps.has(depId));

    const depsHtml = depsToShow.length
        ? depsToShow.map((depId) => {
              const isParent = parentDeps.has(depId);
              const depTask  = liveTasks.find((t) => t.id === depId);
              const name     = depTask ? escHtml(depTask.name) : `#${depId}`;
              return `<div class="dep-item${isParent ? ' dep-parent' : ''}" data-dep="${escAttr(depId)}">
                  <a href="https://github.com/${getConfig().repo}/issues/${depId}"
                     target="_blank" rel="noopener noreferrer">${name}</a>
                  ${isParent
                      ? `<span class="dep-parent-badge" title="GitHub parent issue">↑ parent</span>`
                      : `<button class="dep-remove" data-issue="${escAttr(task.id)}" data-dep="${escAttr(depId)}"
                                title="Remove dependency">✕</button>`}
              </div>`;
          }).join('')
        : '<p class="no-deps">No dependencies yet</p>';

    // Options for "add dependency" dropdown — exclude self and already-added
    const addableOptions = liveTasks
        .filter((t) => t.id !== task.id && !depsToShow.includes(t.id))
        .map((t) => `<option value="${escAttr(t.id)}">${escHtml(t.name)}</option>`)
        .join('');

    const issueUrl = issue.html_url || `https://github.com/${getConfig().repo}/issues/${issue.number}`;

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

    // Body preview (strip the hidden GANTT_META comment and trim)
    const bodyPreview = (issue.body || '')
        .replace(/<!-- GANTT_META:.*?-->/s, '')
        .trim()
        .slice(0, 400);

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

        ${bodyPreview ? `
        <div class="sidebar-section">
            <h4>Description</h4>
            <div class="issue-body-preview">${escHtml(bodyPreview)}${(issue.body || '').replace(/<!-- GANTT_META:.*?-->/s,'').trim().length > 400 ? '…' : ''}</div>
        </div>` : ''}

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
            <a class="gh-link" href="${escAttr(issueUrl)}" target="_blank" rel="noopener noreferrer">
                ↗ Open on GitHub
            </a>
        </div>
    `;

    // ── Event listeners inside sidebar ──────────────────────────────────────

    const dateStart        = document.getElementById('date-start');
    const dateEnd           = document.getElementById('date-end');
    const dateDuration      = document.getElementById('date-duration');
    const dateStartDisplay  = document.getElementById('date-start-display');
    const dateEndDisplay    = document.getElementById('date-end-display');

    // Clicking the display button opens the native date picker
    dateStartDisplay?.addEventListener('click', () => { try { dateStart.showPicker(); } catch { dateStart.focus(); } });
    dateEndDisplay?.addEventListener('click',   () => { try { dateEnd.showPicker();   } catch { dateEnd.focus();   } });

    function calcDuration(s, e) {
        return Math.max(1, Math.round((new Date(e) - new Date(s)) / 86400000));
    }

    function applyDates() {
        let s = dateStart.value;
        let e = dateEnd.value;
        if (!s || !e || s > e) { setStatus('Invalid date range', 'error'); return; }

        // Clamp start to the day after the latest blocker's end
        const taskDeps = normalizeDeps(task.dependencies);
        if (taskDeps.length > 0) {
            const live = getLiveTasks();
            let minStart = null;
            for (const blockerId of taskDeps) {
                const blocker = live.find((t) => t.id === blockerId);
                if (!blocker) continue;
                const blockerEnd = new Date(blocker.end);
                blockerEnd.setDate(blockerEnd.getDate() + 1);
                if (!minStart || blockerEnd > minStart) minStart = blockerEnd;
            }
            if (minStart) {
                const minStartStr = minStart.toISOString().slice(0, 10);
                if (s < minStartStr) {
                    const duration = new Date(e) - new Date(s);
                    s = minStartStr;
                    e = new Date(minStart.getTime() + duration).toISOString().slice(0, 10);
                    dateStart.value = s;
                    dateEnd.value = e;
                    setStatus(`Start clamped — can't start before blocker ends`, 'warn');
                }
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

    // Remove label buttons
    sidebarBody.querySelectorAll('.label-remove-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            applyLabelEdit(task.id, issue, (names) => names.filter((n) => n !== btn.dataset.label));
        });
    });

    // Add label dropdown
    const addLabelSelect = document.getElementById('add-label-select');
    if (addLabelSelect) {
        addLabelSelect.addEventListener('change', () => {
            const name = addLabelSelect.value;
            if (!name) return;
            applyLabelEdit(task.id, issue, (names) => [...names, name]);
        });
    }

    // Parent set/remove
    const sidebarParentInput = document.getElementById('sidebar-parent-input');
    const sidebarParentSetBtn = document.getElementById('sidebar-parent-set-btn');
    const parentRemoveBtn = sidebarBody.querySelector('.parent-remove-btn');

    sidebarParentSetBtn?.addEventListener('click', () => {
        const raw = sidebarParentInput.value.trim();
        const pId = raw.replace(/^#/, '');
        if (!pId || !/^\d+$/.test(pId)) { setStatus('Please enter a valid issue number', 'error'); return; }
        if (pId === task.id) { setStatus('An issue cannot be its own parent', 'error'); return; }
        if (!getLiveTasks().find((t) => t.id === pId)) { setStatus(`Issue #${pId} not found in loaded issues`, 'error'); return; }
        parentMap.set(task.id, pId);
        const tai = allTasks.find((t) => t.id === task.id);
        if (tai) tai._parentDeps = [pId];
        pendingParentChanges.set(task.id, pId);
        updateSaveBtn();
        ganttInstance.refresh(getVisibleTasks());
        const ft = getLiveTasks().find((t) => t.id === task.id);
        if (ft) renderSidebar(ft._issue, ft, normalizeDeps(ft.dependencies), new Set(ft._parentDeps || []), getLiveTasks());
        setStatus(`#${task.id} parent set to #${pId} — unsaved`, 'warn');
    });
    sidebarParentInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sidebarParentSetBtn?.click(); });

    parentRemoveBtn?.addEventListener('click', () => {
        parentMap.delete(task.id);
        const tai = allTasks.find((t) => t.id === task.id);
        if (tai) tai._parentDeps = [];
        pendingParentChanges.set(task.id, null);
        updateSaveBtn();
        ganttInstance.refresh(getVisibleTasks());
        const ft = getLiveTasks().find((t) => t.id === task.id);
        if (ft) renderSidebar(ft._issue, ft, normalizeDeps(ft.dependencies), new Set(ft._parentDeps || []), getLiveTasks());
        setStatus(`#${task.id} parent removed — unsaved`, 'warn');
    });

    // Remove dependency buttons
    sidebarBody.querySelectorAll('.dep-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
            const issueId = btn.dataset.issue;
            const depId   = btn.dataset.dep;
            removeDependency(issueId, depId);
        });
    });

    // Add dependency select + button
    const addDepSelect = document.getElementById('add-dep-select');
    const addDepBtn    = document.getElementById('add-dep-btn');
    if (addDepSelect && addDepBtn) {
        addDepSelect.addEventListener('change', () => {
            addDepBtn.disabled = !addDepSelect.value;
        });
        addDepBtn.addEventListener('click', () => {
            const newDep = addDepSelect.value;
            if (!newDep) return;
            addDependency(task.id, newDep);
        });
    }
}

function addDependency(issueId, depId) {
    const liveTasks = getLiveTasks();
    const task = liveTasks.find((t) => t.id === issueId);
    if (!task) return;

    const current = task._metaDeps || [];
    if (current.includes(depId)) return; // already added

    const updated = [...current, depId];
    recordChange(issueId, { deps: updated });
    setStatus(`Dependency added — unsaved`, 'warn');

    // Re-render chart to show the new arrow
    ganttInstance.refresh(getVisibleTasks());

    // Refresh sidebar for updated task
    const freshTask = getLiveTasks().find((t) => t.id === issueId);
    renderSidebar(freshTask._issue, freshTask,
        normalizeDeps(freshTask.dependencies), new Set(freshTask._parentDeps || []), getLiveTasks());
}

function removeDependency(issueId, depId) {
    const liveTasks = getLiveTasks();
    const task = liveTasks.find((t) => t.id === issueId);
    if (!task) return;

    const current = task._metaDeps || [];
    const updated = current.filter((d) => d !== depId);
    recordChange(issueId, { deps: updated });
    setStatus(`Dependency removed — unsaved`, 'warn');

    ganttInstance.refresh(getVisibleTasks());

    const freshTask = getLiveTasks().find((t) => t.id === issueId);
    renderSidebar(freshTask._issue, freshTask,
        normalizeDeps(freshTask.dependencies), new Set(freshTask._parentDeps || []), getLiveTasks());
}

/** Refresh the Gantt bars without reopening the sidebar. */
function refreshGanttDates() {
    ganttInstance.refresh(getVisibleTasks());
}

function closeSidebar() {
    sidebar.classList.add('hidden');
    selectedTaskId = null;
}

// ─── Blocked-by shortcut dialog ───────────────────────────────────────────────

function openBlockedByDialog(taskId) {
    const live = getLiveTasks();
    const task = live.find((t) => t.id === taskId);
    if (!task) return;
    bbDesc.textContent = `Add a dependency for #${task.id} "${task._issue.title}" — it will be blocked by the issue number you enter.`;
    bbInput.value = '';
    bbError.textContent = '';
    blockedByDialog.classList.remove('hidden');
    requestAnimationFrame(() => bbInput.focus());
}

function closeBlockedByDialog() {
    blockedByDialog.classList.add('hidden');
}

function confirmBlockedBy() {
    const raw = bbInput.value.trim();
    const depId = raw.replace(/^#/, '');
    if (!depId || !/^\d+$/.test(depId)) {
        bbError.textContent = 'Please enter a valid issue number.';
        return;
    }
    if (depId === selectedTaskId) {
        bbError.textContent = 'An issue cannot depend on itself.';
        return;
    }
    const live = getLiveTasks();
    if (!live.find((t) => t.id === depId)) {
        bbError.textContent = `Issue #${depId} was not found in this repo's loaded issues.`;
        return;
    }
    closeBlockedByDialog();

    // Auto-shift: move the blocked issue's start to the blocker's end date,
    // preserving the same duration.
    const blockerTask = live.find((t) => t.id === depId);
    if (blockerTask) {
        const blockerEnd  = new Date(blockerTask.end);
        const myTask      = live.find((t) => t.id === selectedTaskId);
        if (myTask) {
            const myStart    = new Date(myTask.start);
            const myEnd      = new Date(myTask.end);
            const duration   = myEnd - myStart;            // preserve duration in ms
            const newStart   = new Date(blockerEnd);
            // Advance by one day so the blocked issue starts the day after the blocker ends
            newStart.setDate(newStart.getDate() + 1);
            const newEnd     = new Date(newStart.getTime() + duration);
            const toDateStr  = (d) => d.toISOString().slice(0, 10);
            recordChange(selectedTaskId, { start: toDateStr(newStart), end: toDateStr(newEnd) });
        }
    }

    addDependency(selectedTaskId, depId);
}

bbConfirm.addEventListener('click', confirmBlockedBy);
bbCancel.addEventListener('click', closeBlockedByDialog);
bbClose.addEventListener('click', closeBlockedByDialog);
blockedByDialog.addEventListener('click', (e) => { if (e.target === blockedByDialog) closeBlockedByDialog(); });
bbInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { confirmBlockedBy(); }
    if (e.key === 'Escape') { closeBlockedByDialog(); }
});

// ─── Add Parent shortcut dialog ─────────────────────────────────────────────────

function openParentDialog(taskId) {
    const live = getLiveTasks();
    const task = live.find((t) => t.id === taskId);
    if (!task) return;
    pdDesc.textContent = `Set the parent issue for #${task.id} “${task._issue.title}”. The child will be grouped below its parent in the chart.`;
    pdInput.value = '';
    pdError.textContent = '';
    parentDialog.classList.remove('hidden');
    requestAnimationFrame(() => pdInput.focus());
}

function closeParentDialog() {
    parentDialog.classList.add('hidden');
}

async function confirmParent() {
    const raw = pdInput.value.trim();
    const parentId = raw.replace(/^#/, '');
    if (!parentId || !/^\d+$/.test(parentId)) {
        pdError.textContent = 'Please enter a valid issue number.';
        return;
    }
    if (parentId === selectedTaskId) {
        pdError.textContent = 'An issue cannot be its own parent.';
        return;
    }
    const live = getLiveTasks();
    if (!live.find((t) => t.id === parentId)) {
        pdError.textContent = `Issue #${parentId} was not found in this repo’s loaded issues.`;
        return;
    }
    closeParentDialog();

    // 1. Update local parentMap so the indent/sort kicks in immediately
    parentMap.set(selectedTaskId, parentId);

    // 2. Patch the task in allTasks so _parentDeps reflects the new parent
    const taskInAll = allTasks.find((t) => t.id === selectedTaskId);
    if (taskInAll && !taskInAll._parentDeps.includes(parentId)) {
        taskInAll._parentDeps = [...taskInAll._parentDeps, parentId];
    }

    // 3. Refresh chart to apply the new row order and indent label
    ganttInstance.refresh(getVisibleTasks());

    // 4. Record as a pending parent change (will be saved when user clicks Save)
    pendingParentChanges.set(selectedTaskId, parentId);
    updateSaveBtn();

    // Re-render sidebar if the changed issue is currently open
    if (selectedTaskId) {
        const freshTask = getLiveTasks().find((t) => t.id === selectedTaskId);
        if (freshTask) {
            renderSidebar(freshTask._issue, freshTask,
                normalizeDeps(freshTask.dependencies), new Set(freshTask._parentDeps || []), getLiveTasks());
        }
    }

    setStatus(`#${selectedTaskId} parent set to #${parentId} — unsaved`, 'warn');
}

pdConfirm.addEventListener('click', confirmParent);
pdCancel.addEventListener('click', closeParentDialog);
pdClose.addEventListener('click', closeParentDialog);
parentDialog.addEventListener('click', (e) => { if (e.target === parentDialog) closeParentDialog(); });
pdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { confirmParent(); }
    if (e.key === 'Escape') { closeParentDialog(); }
});
// ─── Label editing ───────────────────────────────────────────────────────────

function applyLabelEdit(taskId, issue, mutateFn) {
    const current = pendingLabelChanges.has(taskId)
        ? pendingLabelChanges.get(taskId)
        : (issue.labels || []).map((l) => l.name);
    const updated = mutateFn(current);
    pendingLabelChanges.set(taskId, updated);
    updateSaveBtn();
    setStatus(`#${taskId} labels updated — unsaved`, 'warn');

    // Re-render sidebar to reflect the change
    const liveTasks = getLiveTasks();
    const taskNow   = liveTasks.find((t) => t.id === taskId) || { id: taskId, _issue: issue, _parentDeps: [] };
    renderSidebar(issue, taskNow,
        normalizeDeps(taskNow.dependencies), new Set(taskNow._parentDeps || []), liveTasks);

    // Update bar color with new labels preview
    const tempLabel = updated.length > 0
        ? repoLabels.find((l) => l.name === updated[0])
        : null;
    if (tempLabel) {
        let styleEl = document.getElementById('gantt-bar-colors');
        if (styleEl) {
            const fill   = `#${tempLabel.color}`;
            const border = darkenHex(tempLabel.color);
            const rule   = `.bar-wrapper[data-id="${taskId}"] { --g-bar-color: ${fill}; --g-bar-border: ${border}; }`;
            // Replace or append the rule for this task
            const lines  = styleEl.textContent.split('\n').filter((r) => !r.includes(`data-id="${taskId}"`));
            lines.push(rule);
            styleEl.textContent = lines.join('\n');
        }
    }
}
// ─── Load issues ──────────────────────────────────────────────────────────────

async function loadIssues() {
    const { token, repo: repoStr } = getConfig();
    const parsed = parseRepo(repoStr);
    if (!parsed) { setStatus('Invalid repo format', 'error'); return; }

    ganttWrapper.innerHTML = '<div class="loading">Loading issues…</div>';
    setStatus('Fetching issues from GitHub…');
    saveBtn.disabled = true;

    try {
        allIssues  = await fetchAllIssues(parsed.owner, parsed.repo, token);
        parentMap  = await fetchParentMap(parsed.owner, parsed.repo, token, allIssues);
        [repoLabels] = await Promise.all([
            fetchRepoLabels(parsed.owner, parsed.repo, token),
        ]);
        allTasks   = allIssues.map((issue) => issueToTask(issue, parentMap));
        pendingChanges.clear();
        pendingLabelChanges.clear();
        pendingParentChanges.clear();
        updateSaveBtn();
        buildLabelFilter(allIssues);

        if (allTasks.length === 0) {
            ganttWrapper.innerHTML = '<div class="empty">No issues found in this repository.</div>';
            setStatus('No issues found');
            return;
        }

        renderGantt(getVisibleTasks());
        applyBarColors();
        const subCount = parentMap.size;
        setStatus(`Loaded ${allIssues.length} issue(s) · ${allIssues.filter((i) => i.state === 'open').length} open${subCount > 0 ? ` · ${subCount} sub-issue(s) linked` : ''}`);
    } catch (err) {
        ganttWrapper.innerHTML = '';
        setStatus(`Error: ${err.message}`, 'error');
    }
}

// ─── Save changes ─────────────────────────────────────────────────────────────

async function saveChanges() {
    if (pendingChanges.size === 0 && pendingLabelChanges.size === 0 && pendingParentChanges.size === 0) return;

    const { token, repo: repoStr } = getConfig();
    const parsed = parseRepo(repoStr);
    if (!parsed) return;

    saveBtn.disabled = true;
    const total = pendingChanges.size + pendingLabelChanges.size + pendingParentChanges.size;
    let done = 0;
    let failed = 0;

    setStatus(`Saving ${total} change(s)…`);

    // Save label changes first (they don't depend on body)
    for (const [issueNumber, labelNames] of pendingLabelChanges.entries()) {
        const { token, repo: repoStr } = getConfig();
        const parsed2 = parseRepo(repoStr);
        if (!parsed2) { failed++; continue; }
        try {
            const updatedLabels = await updateIssueLabels(parsed2.owner, parsed2.repo, token, issueNumber, labelNames);
            // Patch the local issue cache with the returned label objects
            const issue = allIssues.find((i) => String(i.number) === issueNumber);
            if (issue) issue.labels = Array.isArray(updatedLabels) ? updatedLabels : labelNames.map((n) => repoLabels.find((l) => l.name === n) || { name: n, color: '888888' });
            done++;
        } catch (err) {
            console.error(`Failed to save labels for #${issueNumber}:`, err);
            failed++;
        }
    }
    pendingLabelChanges.clear();

    // Save sequentially to avoid hitting GitHub rate limits too aggressively.
    for (const [issueNumber, changes] of pendingChanges.entries()) {
        const issue = allIssues.find((i) => String(i.number) === issueNumber);
        if (!issue) { failed++; continue; }

        try {
            const newBody = buildUpdatedBody(issue, changes);
            const updated = await updateIssueBody(parsed.owner, parsed.repo, token, issueNumber, newBody);
            // Update local cache so subsequent saves use the fresh body
            const idx = allIssues.indexOf(issue);
            if (idx !== -1) allIssues[idx] = updated;
            done++;
        } catch (err) {
            console.error(`Failed to save issue #${issueNumber}:`, err);
            failed++;
        }
    }

    pendingChanges.clear();

    // Save pending parent assignments
    for (const [childId, parentId] of pendingParentChanges.entries()) {
        if (parentId === null) { done++; continue; } // removal already applied in-memory
        const { token: tok, repo: repoStr2 } = getConfig();
        const parsed2 = parseRepo(repoStr2);
        const childIssue = allIssues.find((i) => String(i.number) === childId);
        if (parsed2 && childIssue?.node_id) {
            try {
                await addSubIssue(parsed2.owner, parsed2.repo, tok, parentId, childIssue.id);
                done++;
            } catch (err) {
                console.error(`Failed to set parent for #${childId}:`, err);
                failed++;
            }
        }
    }
    pendingParentChanges.clear();

    updateSaveBtn();

    if (failed === 0) {
        setStatus(`Saved ${done} issue(s) successfully ✓`, 'success');
    } else {
        setStatus(`Saved ${done}, failed ${failed}. Check the console for details.`, 'error');
    }

    // Reload allTasks from the updated allIssues so the local state is consistent
    allTasks = allIssues.map((issue) => issueToTask(issue, parentMap));
    buildLabelFilter(allIssues);
    applyBarColors();
}

// ─── Config screen (initial login only) ──────────────────────────────────────

function showMain() {
    configScreen.classList.add('screen-hidden');
    mainScreen.classList.remove('screen-hidden');
}

// ─── Settings modal ───────────────────────────────────────────────────────────

function openSettingsModal() {
    const { token, repo } = getConfig();
    sTokenInput.value = token;
    sRepoInput.value  = repo;
    settingsError.textContent = '';
    settingsModal.classList.remove('hidden');
    sRepoInput.focus();
}

function closeSettingsModal() {
    settingsModal.classList.add('hidden');
}

modalClose.addEventListener('click', closeSettingsModal);

// Click outside the card to close
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
});

document.addEventListener('keydown', (e) => {
    // Don't fire when typing in an input/textarea/select
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (e.key === 'Escape') {
        closeSettingsModal();
        closeBlockedByDialog();
        closeParentDialog();
    }
    if (e.key.toLowerCase() === 'b' && selectedTaskId) {
        openBlockedByDialog(selectedTaskId);
    }
    if (e.key.toLowerCase() === 'p' && selectedTaskId) {
        openParentDialog(selectedTaskId);
    }
});

settingsLogout.addEventListener('click', () => {
    if (!confirm('Sign out and clear your saved token and repository?')) return;
    localStorage.removeItem('gh_token');
    localStorage.removeItem('gh_repo');
    location.reload();
});

settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token   = sTokenInput.value.trim();
    const repoStr = sRepoInput.value.trim();

    if (!token) { settingsError.textContent = 'Token is required.'; return; }
    const parsed = parseRepo(repoStr);
    if (!parsed) { settingsError.textContent = 'Repo must be in "owner/repo" format.'; return; }

    settingsError.textContent = '';
    const btn = settingsForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
        const repoData = await validateRepo(parsed.owner, parsed.repo, token);
        saveConfig(token, repoStr);
        repoLabel.textContent = repoData.full_name;
        closeSettingsModal();
        closeSidebar();
        await loadIssues();
    } catch (err) {
        settingsError.textContent = `Could not connect: ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Apply & Reload';
    }
});

configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = ghTokenInput.value.trim();
    const repoStr = ghRepoInput.value.trim();

    if (!token) { configError.textContent = 'Token is required.'; return; }
    const parsed = parseRepo(repoStr);
    if (!parsed) { configError.textContent = 'Repo must be in "owner/repo" format.'; return; }

    configError.textContent = '';
    const btn = configForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
        const repoData = await validateRepo(parsed.owner, parsed.repo, token);
        saveConfig(token, repoStr);
        repoLabel.textContent = repoData.full_name;
        showMain();
        await loadIssues();
    } catch (err) {
        configError.textContent = `Could not connect: ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Load Issues';
    }
});

// ─── Toolbar events ───────────────────────────────────────────────────────────

saveBtn.addEventListener('click', saveChanges);

reloadBtn.addEventListener('click', async () => {
    if (pendingChanges.size > 0) {
        if (!confirm(`You have ${pendingChanges.size} unsaved change(s). Reload and discard them?`)) return;
    }
    closeSidebar();
    await loadIssues();
});

settingsBtn.addEventListener('click', openSettingsModal);

toolbarHideBtn.addEventListener('click', () => {
    toolbar.classList.add('hidden');
    toolbarCollapsed.classList.remove('hidden');
});

toolbarShowBtn.addEventListener('click', () => {
    toolbar.classList.remove('hidden');
    toolbarCollapsed.classList.add('hidden');
});

labelFilterClear.addEventListener('click', () => {
    activeLabels.clear();
    labelFilterPills.querySelectorAll('.label-filter-pill').forEach((p) => p.classList.remove('active'));
    updateFilterClearBtn();
    applyLabelFilter();
});

titleFilterInput.addEventListener('input', () => {
    titleFilter = titleFilterInput.value.trim();
    if (ganttInstance) ganttInstance.refresh(getVisibleTasks());
});

sidebarClose.addEventListener('click', closeSidebar);

// (Wheel blocking is attached per-render in renderGantt() directly on .gantt-container)

viewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        if (ganttInstance) {
            ganttInstance.change_view_mode(btn.dataset.view);
        }
    });
});

// ─── Dynamic bar colours from label hex ─────────────────────────────────────

/** Darken a 6-char hex colour by 30 % to make a border shade. */
function darkenHex(hex) {
    const r = Math.round(parseInt(hex.slice(0, 2), 16) * 0.7);
    const g = Math.round(parseInt(hex.slice(2, 4), 16) * 0.7);
    const b = Math.round(parseInt(hex.slice(4, 6), 16) * 0.7);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Inject (or update) a <style> tag that sets --g-bar-color / --g-bar-border
 * on each .bar-wrapper[data-id] element using the first label's hex colour.
 * Uses allTasks so the rules stay valid across filter changes.
 */
function applyBarColors() {
    let styleEl = document.getElementById('gantt-bar-colors');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'gantt-bar-colors';
        document.head.appendChild(styleEl);
    }

    const rules = allTasks
        .filter((t) => t._issue?.labels?.length > 0)
        .map((t) => {
            const label = t._issue.labels[0];
            const fill   = `#${label.color}`;
            const border = darkenHex(label.color);
            return `.bar-wrapper[data-id="${t.id}"] { --g-bar-color: ${fill}; --g-bar-border: ${border}; }`;
        });

    styleEl.textContent = rules.join('\n');
}

// ─── Escape helpers (prevent XSS from issue titles/labels) ───────────────────

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Format an ISO date string (YYYY-MM-DD) as "Mon DD, YYYY". */
function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Pick black or white text based on the hex background colour. */
function labelTextColor(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    // Perceived luminance formula
    return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#000' : '#fff';
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

(function init() {
    const { token, repo } = getConfig();
    if (token && repo) {
        const parsed = parseRepo(repo);
        if (parsed) {
            repoLabel.textContent = repo;
            showMain();
            loadIssues();
            return;
        }
    }
    // No valid credentials — show the login screen
    configScreen.classList.remove('screen-hidden');
})();
