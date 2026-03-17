/**
 * Pure utility functions — no side-effects, no DOM access, no state.
 *
 * Safe to import from any module without worrying about load order.
 */

// ─── String escaping (XSS prevention) ────────────────────────────────────────

export function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function escAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Date formatting ──────────────────────────────────────────────────────────

/** Format an ISO date string (YYYY-MM-DD) as "Mon DD, YYYY". */
export function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

/** Pick black or white text based on the hex background colour (perceived luminance). */
export function labelTextColor(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#000' : '#fff';
}

/** Darken a 6-char hex colour by 30 % (used to generate a border shade). */
export function darkenHex(hex) {
    const r = Math.round(parseInt(hex.slice(0, 2), 16) * 0.7);
    const g = Math.round(parseInt(hex.slice(2, 4), 16) * 0.7);
    const b = Math.round(parseInt(hex.slice(4, 6), 16) * 0.7);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ─── Task dependency helpers ──────────────────────────────────────────────────

/**
 * Normalise a task's `dependencies` field to a plain string array.
 * Handles both comma-separated strings (raw from Gantt) and arrays
 * (after frappe-gantt's internal setup_tasks has run).
 */
export function normalizeDeps(dependencies) {
    if (!dependencies) return [];
    if (Array.isArray(dependencies)) return dependencies.filter(Boolean);
    return dependencies.split(',').map((d) => d.trim()).filter(Boolean);
}
