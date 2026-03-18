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
import { fetchAllIssues, fetchParentMap, fetchRepoLabels, validateRepo, fetchProjectIssueNumbers } from './github.js';
import { issueToTask } from './mapper.js';
import './style.css';

import { state } from './state.js';
import { getConfig, saveConfig, parseRepo, setStatus } from './config.js';
import { normalizeDeps } from './utils.js';
import { getLiveTasks, updateSaveBtn, recordChange, cascadeDateShift, getVisibleTasks } from './tasks.js';
import { buildLabelFilter, updateFilterClearBtn, buildAssigneeFilter, updateAssigneeFilterClearBtn, applyLabelFilter } from './filters.js';
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
const assigneeFilterClear = document.getElementById('assignee-filter-clear');
const openOnlyFilter     = document.getElementById('open-only-filter');
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
    const parsed = parseRepo(repoStr);
    if (!parsed || (!parsed.repo && !parsed.projectId)) { 
        settingsError.textContent = 'Invalid input. Use: GitHub project URL, owner/repo, or project ID'; 
        return; 
    }

    settingsError.textContent = '';
    const btn = settingsForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
        let owner, repo, projectId;
        if (parsed.projectId) {
            projectId = parsed.projectId;
            owner = parsed.owner;
        } else {
            owner = parsed.owner;
            repo = parsed.repo;
        }
        
        const repoData = await validateRepo(owner, repo, token, projectId);
        saveConfig(token, repoStr);
        repoLabel.textContent = repoData.full_name;
        state.projectId = projectId || null;
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
    const parsed = parseRepo(repoStr);
    if (!parsed || (!parsed.repo && !parsed.projectId)) { 
        configError.textContent = 'Invalid input. Use: GitHub project URL, owner/repo, or project ID'; 
        return; 
    }

    configError.textContent = '';
    const btn = configForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
        let owner, repo, projectId;
        if (parsed.projectId) {
            projectId = parsed.projectId;
            owner = parsed.owner;
            // Will fetch project details to get repo if needed
        } else {
            owner = parsed.owner;
            repo = parsed.repo;
        }
        
        const repoData = await validateRepo(owner, repo, token, projectId);
        saveConfig(token, repoStr);
        repoLabel.textContent = repoData.full_name;
        state.projectId = projectId || null;
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

assigneeFilterClear.addEventListener('click', () => {
    state.activeAssignees.clear();
    const assigneePills = document.getElementById('assignee-filter-pills');
    assigneePills.querySelectorAll('.assignee-filter-pill').forEach((p) => p.classList.remove('active'));
    updateAssigneeFilterClearBtn();
    applyLabelFilter();
});

openOnlyFilter.addEventListener('change', () => {
    state.openOnly = openOnlyFilter.checked;
    state.ganttInstance?.refresh(getVisibleTasks());
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
        let allIssues, owner, repo, projectId;
        
        if (parsed.projectId) {
            // Load from project
            projectId = parsed.projectId;
            owner = parsed.owner;
            setStatus('Fetching project data…');
            
            // Get all issue numbers in the project
            const projectIssueNumbers = await fetchProjectIssueNumbers(projectId, owner, token);
            state.projectIssueNumbers = projectIssueNumbers;
            state.projectId = projectId;
            
            if (projectIssueNumbers.size === 0) {
                document.getElementById('gantt-wrapper').innerHTML = '<div class="empty">No issues found in this project.</div>';
                setStatus('No issues found in project');
                return;
            }
            
            // Fetch issues from all repos in the org or specified repo
            if (parsed.repo) {
                // Specific repo provided with project
                allIssues = await fetchAllIssues(owner, parsed.repo, token);
            } else {
                // Need to get issues from multiple repos — for now, require user to specify repo
                document.getElementById('gantt-wrapper').innerHTML = '<div class="empty">Please specify both project URL and repository (owner/repo) for multi-repo projects.</div>';
                setStatus('Multi-repo projects require explicit owner/repo');
                return;
            }
            
            // Filter to only issues in the project
            allIssues = allIssues.filter((issue) => projectIssueNumbers.has(String(issue.number)));
            repo = parsed.repo;
        } else {
            // Load from repo
            owner = parsed.owner;
            repo = parsed.repo;
            if (!repo) { setStatus('Repository is required', 'error'); return; }
            allIssues = await fetchAllIssues(owner, repo, token);
        }

        state.allIssues  = allIssues;
        state.parentMap  = await fetchParentMap(owner, repo, token, state.allIssues);
        state.repoLabels = await fetchRepoLabels(owner, repo, token);
        state.allTasks   = state.allIssues.map((issue) => issueToTask(issue, state.parentMap));

        state.pendingChanges.clear();
        state.pendingLabelChanges.clear();
        state.pendingParentChanges.clear();
        state.rowOrderOverride = [];
        updateSaveBtn();
        buildLabelFilter(state.allIssues);
        buildAssigneeFilter(state.allIssues);
        
        // Set open-only filter to checked (default enabled)
        openOnlyFilter.checked = state.openOnly;

        if (state.allTasks.length === 0) {
            document.getElementById('gantt-wrapper').innerHTML = '<div class="empty">No issues found.</div>';
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
