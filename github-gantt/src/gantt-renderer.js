/**
 * Gantt chart rendering, row drag-to-reorder, and bar colour injection.
 *
 * renderGantt() accepts an `onTaskClick` callback so this module has no
 * dependency on sidebar.js — the caller (main.js / save.js) supplies the
 * handler, keeping the dependency graph acyclic.
 */

import Gantt from 'frappe-gantt';
import { state } from './state.js';
import { normalizeDeps, darkenHex } from './utils.js';
import { setStatus } from './config.js';
import {
    recordChange,
    cascadeDateShift,
    clampStartToDeps,
    getVisibleTasks,
    refreshGanttDates,
} from './tasks.js';

const ganttWrapper = document.getElementById('gantt-wrapper');

// ─── Chart initialisation ─────────────────────────────────────────────────────

/**
 * (Re-)initialise the frappe-gantt chart inside #gantt-wrapper.
 *
 * @param {object[]} tasks   Task objects from getVisibleTasks()
 * @param {object}   options
 * @param {Function} options.onTaskClick  Called with the task when a bar is clicked
 */
export function renderGantt(tasks, { onTaskClick } = {}) {
    ganttWrapper.innerHTML = '';

    state.ganttInstance = new Gantt('#gantt-wrapper', tasks, {
        view_mode:         'Week',
        readonly_progress: false,
        readonly_dates:    false,
        today_button:      true,
        popup:             false,   // we use the sidebar instead
        popup_on:          'click',

        on_click(task) {
            onTaskClick?.(task);
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
                const clamped = clampStartToDeps(taskDeps, startStr, endStr);
                if (clamped.clamped) {
                    startStr = clamped.start;
                    endStr   = clamped.end;
                    setStatus(`#${task.id} start clamped — can't start before blocker ends`, 'warn');
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
            document.querySelectorAll('[data-view]').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.view === mode.name);
            });
        },
    });

    // Block horizontal wheel-scroll from propagating out of the chart container.
    const ganttContainer = ganttWrapper.querySelector('.gantt-container');
    if (ganttContainer) {
        ganttContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
        }, { passive: false });
    }

    // Monkey-patch refresh so row drag handles are rebuilt after every update.
    const _origRefresh = state.ganttInstance.refresh.bind(state.ganttInstance);
    state.ganttInstance.refresh = (refreshTasks) => {
        _origRefresh(refreshTasks);
        attachRowDragHandles();
    };

    attachRowDragHandles();
}

// ─── Row drag-to-reorder ──────────────────────────────────────────────────────

/**
 * Place a thin sticky overlay with ⠿ drag handles alongside each Gantt row.
 * Called after every render/refresh so handles stay aligned.
 */
export function attachRowDragHandles() {
    const ganttContainer = ganttWrapper.querySelector('.gantt-container');
    if (!ganttContainer || !state.ganttInstance) return;

    const barHeight = state.ganttInstance.options.bar_height; // 30
    const pad       = state.ganttInstance.options.padding;    // 18
    const rowHeight = barHeight + pad;                        // 48
    const headerH   = state.ganttInstance.config.header_height;

    // Remove the previous overlay along with its scroll listener.
    const old = ganttContainer.querySelector('.row-drag-overlay');
    if (old) {
        old._scrollOff?.();
        old.remove();
    }

    const tasks = [...state.ganttInstance.tasks].sort((a, b) => a._index - b._index);
    if (tasks.length === 0) return;

    const overlay = document.createElement('div');
    overlay.className = 'row-drag-overlay';
    overlay.style.cssText = `
        position: absolute; top: 0;
        left: ${ganttContainer.scrollLeft}px;
        z-index: 500; pointer-events: none; width: 22px;
    `;
    ganttContainer.appendChild(overlay);

    const onScroll = () => { overlay.style.left = ganttContainer.scrollLeft + 'px'; };
    ganttContainer.addEventListener('scroll', onScroll, { passive: true });
    overlay._scrollOff = () => ganttContainer.removeEventListener('scroll', onScroll);

    for (const task of tasks) {
        const handleTop = headerH + (pad / 2) + task._index * rowHeight;
        const handle    = document.createElement('div');
        handle.className   = 'row-drag-handle';
        handle.dataset.id  = task.id;
        handle.title       = `Drag to reorder #${task.id}`;
        handle.style.top   = handleTop + 'px';
        handle.style.height = rowHeight + 'px';
        handle.textContent = '⠿';
        overlay.appendChild(handle);

        handle.addEventListener('mousedown', (e) => {
            _startRowDrag(e, task.id, tasks, ganttContainer, rowHeight, headerH);
        });
    }
}

function _startRowDrag(e, taskId, tasks, container, rowHeight, headerH) {
    e.preventDefault();
    e.stopPropagation();

    const currentOrder = tasks.map((t) => t.id);
    const fromIndex    = currentOrder.indexOf(taskId);
    const totalRows    = tasks.length;

    const indicator = document.createElement('div');
    indicator.className = 'row-drop-indicator';
    indicator.style.top = (headerH + fromIndex * rowHeight) + 'px';
    container.appendChild(indicator);

    const draggedHandle = container.querySelector(`.row-drag-handle[data-id="${taskId}"]`);
    draggedHandle?.classList.add('dragging');

    let insertIdx = fromIndex;

    function onMove(ev) {
        const rect   = container.getBoundingClientRect();
        const svgY   = ev.clientY - rect.top + container.scrollTop - headerH;
        const rowIdx = Math.max(0, Math.min(totalRows - 1, Math.floor(svgY / rowHeight)));
        const frac   = (svgY % rowHeight) / rowHeight;
        insertIdx    = rowIdx + (frac >= 0.5 ? 1 : 0);
        indicator.style.top = (headerH + Math.min(insertIdx, totalRows) * rowHeight - 1) + 'px';
    }

    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        indicator.remove();
        draggedHandle?.classList.remove('dragging');

        const newOrder = currentOrder.filter((id) => id !== taskId);
        const adj      = insertIdx > fromIndex ? insertIdx - 1 : insertIdx;
        newOrder.splice(adj, 0, taskId);

        if (newOrder.join(',') !== currentOrder.join(',')) {
            state.rowOrderOverride = newOrder;
            state.ganttInstance.refresh(getVisibleTasks());
        }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ─── Bar colours ─────────────────────────────────────────────────────────────

/**
 * Inject (or update) a <style id="gantt-bar-colors"> tag that assigns each
 * bar's colour from the first GitHub label on the issue.
 * Uses state.allTasks so colours persist across filter changes.
 */
export function applyBarColors() {
    let styleEl = document.getElementById('gantt-bar-colors');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'gantt-bar-colors';
        document.head.appendChild(styleEl);
    }

    const rules = state.allTasks
        .filter((t) => t._issue?.labels?.length > 0)
        .map((t) => {
            const label  = t._issue.labels[0];
            const fill   = `#${label.color}`;
            const border = darkenHex(label.color);
            return `.bar-wrapper[data-id="${t.id}"] { --g-bar-color: ${fill}; --g-bar-border: ${border}; }`;
        });

    styleEl.textContent = rules.join('\n');
}
