/**
 * Shared mutable application state.
 *
 * All modules import this single object and mutate properties in place.
 * Using a plain object (rather than individual `export let` bindings) means
 * any module can assign a new value and every other module will see it on
 * the next read — no setter boilerplate required.
 */
export const state = {
    /** @type {import('frappe-gantt').default|null} */
    ganttInstance: null,

    /** Raw GitHub issue objects returned by the API. */
    allIssues: [],

    /** Gantt task objects derived from allIssues. */
    allTasks: [],

    /** Project ID being viewed (if loading from project). */
    projectId: null,

    /** All issue numbers that belong to the current project. Used for filtering. */
    projectIssueNumbers: new Set(),

    /**
     * Edits not yet pushed to GitHub.
     * @type {Map<string, {start?:string, end?:string, progress?:number, deps?:string[]}>}
     */
    pendingChanges: new Map(),

    /**
     * Parent assignments not yet pushed.
     * Value is parentId (string) or null (means "remove parent").
     * @type {Map<string, string|null>}
     */
    pendingParentChanges: new Map(),

    /**
     * Label edits not yet pushed.
     * Value is the full list of label names to apply.
     * @type {Map<string, string[]>}
     */
    pendingLabelChanges: new Map(),

    /** Label names currently active in the filter bar. */
    activeLabels: new Set(),

    /** Assignee logins currently active in the filter bar. */
    activeAssignees: new Set(),

    /** Filter to show only open issues. */
    openOnly: true,

    /**
     * childId → parentId mapping loaded from GitHub sub-issues API.
     * @type {Map<string, string>}
     */
    parentMap: new Map(),

    /** Issue id of the bar that was most recently clicked (used for keyboard shortcuts). */
    selectedTaskId: null,

    /** Current value of the title search box (case-insensitive). */
    titleFilter: '',

    /** All labels defined in the repository, [{name, color}, ...]. */
    repoLabels: [],

    /**
     * When non-empty the user has manually reordered rows and this array
     * defines the desired order (array of task IDs).  Cleared on every reload.
     */
    rowOrderOverride: [],
};
