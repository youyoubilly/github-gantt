/**
 * Label filter bar and title search — UI rendering + event wiring.
 *
 * Builds the label pill buttons from the loaded issue set, keeps them in sync
 * with the active-label set, and triggers a Gantt refresh when filters change.
 */

import { state } from './state.js';
import { escHtml, escAttr, labelTextColor } from './utils.js';
import { getVisibleTasks } from './tasks.js';

const labelFilterBar   = document.getElementById('label-filter-bar');
const labelFilterPills = document.getElementById('label-filter-pills');
const labelFilterClear = document.getElementById('label-filter-clear');

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Re-build the label pill buttons from a fresh set of issues.
 * Hides the bar entirely when the repo has no labels.
 * @param {object[]} issues
 */
export function buildLabelFilter(issues) {
    const labelMap = new Map(); // name → { color, textColor }
    for (const issue of issues) {
        for (const label of (issue.labels || [])) {
            if (!labelMap.has(label.name)) {
                labelMap.set(label.name, {
                    color:     label.color,
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
            const active = state.activeLabels.has(name) ? ' active' : '';
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
            if (state.activeLabels.has(name)) {
                state.activeLabels.delete(name);
                pill.classList.remove('active');
            } else {
                state.activeLabels.add(name);
                pill.classList.add('active');
            }
            updateFilterClearBtn();
            applyLabelFilter();
        });
    });
}

/** Show or hide the "Clear filters" button depending on whether any label is active. */
export function updateFilterClearBtn() {
    labelFilterClear.classList.toggle('hidden', state.activeLabels.size === 0);
}

/** Re-render the Gantt chart applying the current label + title filters. */
export function applyLabelFilter() {
    if (!state.ganttInstance) return;
    state.ganttInstance.refresh(getVisibleTasks());
}
