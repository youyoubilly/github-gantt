/**
 * GitHub Gantt — Entry point and orchestration.
 *
 * Wires up all the modules, handles config/settings screens, and delegates
 * all specific logic to domain-focused modules. No single function here
 * should exceed ~20 lines.
 */

import Gantt from 'frappe-gantt';
import '../../gantt/src/styles/gantt.css';
import '../../gantt/src/styles/themes.css';
import { fetchAllIssues, fetchParentMap, fetchRepoLabels, validateRepo } from './github.js';
import { issueToTask } from './mapper.js';
import './style.css';

import { state } from './state.js';
import { getConfig, saveConfig, parseRepo, setStatus } from './config.js';
import { normalizeDeps } from './utils.js';
import { getLiveTasks, updateSaveBtn, recordChange, cascadeDateShift, getVisibleTasks } from './tasks.js';
import { buildLabelFilter, updateFilterClearBtn, applyLabelFilter } from './filters.js';
import { renderGantt, applyBarColors } from './gantt-renderer.js';
import { openSidebar, closeSidebar, _renderSidebar } from './sidebar.js';
import { openBlockedByDialog, openParentDialog } from './dialogs.js';
import { saveChanges } from './save.js';

// ─── DOM Refs ─────────────────────────────────────────────────────────────────

const configScreen       = document.getElementById('config-screen');
const mainScreen         = document.getElementById('main-screen');
const configForm         = document.getElementById('config-form');
const ghTokenInput       = document.getElementById('gh-token');
const ghRepoInput        = document.getElementById('gh-repo');
const configError        = document.getElementById('config-error');
const repoLabel          = document.getElementById('repo-label');
const saveBtn            = document.getElementById('save-btn');
const reloadBtn          = document.getElementById('reload-btn');
const settingsBtn        = document.getElementById('settings-btn');
const settingsModal      = document.getElementById('settings-modal');
const settingsForm       = document.getElementById('settings-form');
const sTokenInput        = document.getElementById('s-gh-token');
const sRepoInput         = document.getElementById('s-gh-repo');
const settingsError      = document.getElementById('settings-error');
const modalClose         = document.getElementById('modal-close');
const settingsLogout     = document.getElementById('settings-logout');
const toolbar            = document.querySelector('.toolbar');
const toolbarHideBtn     = document.getElementById('toolbar-hide-btn');
const toolbarCollapsed   = document.getElementById('toolbar-collapsed');
const toolbarShowBtn     = document.getElementById('toolbar-show-btn');
const labelFilterPills   = document.getElementById('label-filter-pills');
const labelFilterClear   = document.getElementById('label-filter-clear');
const titleFilterInput   = document.getElementById('title-filter');
const sidebarClose       = document.getElementById('sidebar-close');
const viewBtns           = document.querySelectorAll('[data-view]');

// ─── Screen navigation ─────────────────────────────────────────────────────────

function showMain() {
    configScreen.classList.add('screen-hidden');
    mainScreen.classList.remove('screen-hidden');
}

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

// ─── Event listeners ──────────────────────────────────────────────────────────

// Settings modal
modalClose.addEventListener('click', closeSettingsModal);
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
});

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    if (e.key === 'Escape') {
        closeSettingsModal();
        closeSidebar();
    }
    if (e.key.toLowerCase() === 'b' && state.selectedTaskId) {
        openBlockedByDialog(state.selectedTaskId);
    }
    if (e.key.toLowerCase() === 'p' && state.selectedTaskId) {
        openParentDialog(state.selectedTaskId);
    }
});

// Logout
settingsLogout.addEventListener('click', () => {
    if (!confirm('Sign out and clear your saved token and repository?')) return;
    localStorage.removeItem('gh_token');
    localStorage.removeItem('gh_repo');
    location.reload();
});

// Settings form
settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token   = sTokenInput.value.trim();
    const repoStr = sRepoInput.value.trim();

    if (!token) { settingsError.textContent = 'Token is required.'; return; }
    if (!parseRepo(repoStr)) { settingsError.textContent = 'Repo must be in "owner/repo" format.'; return; }

    settingsError.textContent = '';
    const btn = settingsForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
        const { owner, repo } = parseRepo(repoStr);
        const repoData = await validateRepo(owner, repo, token);
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

// Config form (initial login)
configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = ghTokenInput.value.trim();
    const repoStr = ghRepoInput.value.trim();

    if (!token) { configError.textContent = 'Token is required.'; return; }
    if (!parseRepo(repoStr)) { configError.textContent = 'Repo must be in "owner/repo" format.'; return; }

    configError.textContent = '';
    const btn = configForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
        const { owner, repo } = parseRepo(repoStr);
        const repoData = await validateRepo(owner, repo, token);
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

// Toolbar buttons
saveBtn.addEventListener('click', saveChanges);

reloadBtn.addEventListener('click', async () => {
    if (state.pendingChanges.size > 0) {
        if (!confirm(`You have ${state.pendingChanges.size} unsaved change(s). Reload and discard them?`)) return;
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
    state.activeLabels.clear();
    labelFilterPills.querySelectorAll('.label-filter-pill').forEach((p) => p.classList.remove('active'));
    updateFilterClearBtn();
    applyLabelFilter();
});

titleFilterInput.addEventListener('input', () => {
    state.titleFilter = titleFilterInput.value.trim();
    state.ganttInstance?.refresh(getVisibleTasks());
});

sidebarClose.addEventListener('click', closeSidebar);

viewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        state.ganttInstance?.change_view_mode(btn.dataset.view);
    });
});

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadIssues() {
    const { token, repo: repoStr } = getConfig();
    const parsed = parseRepo(repoStr);
    if (!parsed) { setStatus('Invalid repo format', 'error'); return; }

    document.getElementById('gantt-wrapper').innerHTML = '<div class="loading">Loading issues…</div>';
    setStatus('Fetching issues from GitHub…');
    saveBtn.disabled = true;

    try {
        state.allIssues  = await fetchAllIssues(parsed.owner, parsed.repo, token);
        state.parentMap  = await fetchParentMap(parsed.owner, parsed.repo, token, state.allIssues);
        state.repoLabels = await fetchRepoLabels(parsed.owner, parsed.repo, token);
        state.allTasks   = state.allIssues.map((issue) => issueToTask(issue, state.parentMap));

        state.pendingChanges.clear();
        state.pendingLabelChanges.clear();
        state.pendingParentChanges.clear();
        state.rowOrderOverride = [];
        updateSaveBtn();
        buildLabelFilter(state.allIssues);

        if (state.allTasks.length === 0) {
            document.getElementById('gantt-wrapper').innerHTML = '<div class="empty">No issues found in this repository.</div>';
            setStatus('No issues found');
            return;
        }

        renderGantt(getVisibleTasks(), {
            onTaskClick: (task) => {
                openSidebar(task, {
                    onAddDependency:    addDependency,
                    onRemoveDependency: removeDependency,
                });
            },
        });
        applyBarColors();
        const subCount = state.parentMap.size;
        setStatus(`Loaded ${state.allIssues.length} issue(s) · ${state.allIssues.filter((i) => i.state === 'open').length} open${subCount > 0 ? ` · ${subCount} sub-issue(s) linked` : ''}`);
    } catch (err) {
        document.getElementById('gantt-wrapper').innerHTML = '';
        setStatus(`Error: ${err.message}`, 'error');
    }
}

// ─── Dependency management ────────────────────────────────────────────────────

function addDependency(issueId, depId) {
    const liveTasks = getLiveTasks();
    const task = liveTasks.find((t) => t.id === issueId);
    if (!task) return;

    const current = task._metaDeps || [];
    if (current.includes(depId)) return;

    const updated = [...current, depId];
    recordChange(issueId, { deps: updated });
    setStatus(`Dependency added — unsaved`, 'warn');

    state.ganttInstance.refresh(getVisibleTasks());

    const freshTask = getLiveTasks().find((t) => t.id === issueId);
    if (freshTask) {
        _renderSidebar(freshTask._issue, freshTask,
            normalizeDeps(freshTask.dependencies), new Set(freshTask._parentDeps || []), getLiveTasks(), {
            onAddDependency:    addDependency,
            onRemoveDependency: removeDependency,
        });
    }
}

function removeDependency(issueId, depId) {
    const liveTasks = getLiveTasks();
    const task = liveTasks.find((t) => t.id === issueId);
    if (!task) return;

    const current = task._metaDeps || [];
    const updated = current.filter((d) => d !== depId);
    recordChange(issueId, { deps: updated });
    setStatus(`Dependency removed — unsaved`, 'warn');

    state.ganttInstance.refresh(getVisibleTasks());

    const freshTask = getLiveTasks().find((t) => t.id === issueId);
    if (freshTask) {
        _renderSidebar(freshTask._issue, freshTask,
            normalizeDeps(freshTask.dependencies), new Set(freshTask._parentDeps || []), getLiveTasks(), {
            onAddDependency:    addDependency,
            onRemoveDependency: removeDependency,
        });
    }
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
    configScreen.classList.remove('screen-hidden');
})();
