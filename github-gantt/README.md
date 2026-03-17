# GitHub Gantt

A visual Gantt chart for managing GitHub Issues — plan dates, track dependencies, set parent/child hierarchies, and save everything back to GitHub.

![screenshot placeholder](https://placehold.co/900x400?text=GitHub+Gantt)

---

## Features

| Feature | Description |
|---|---|
| **Gantt bars** | Drag to reschedule; resize right edge to change duration |
| **Dependencies** | Arrow lines between blocked/blocking issues; blocked issues can't be dragged before their blocker ends |
| **Cascade shift** | Moving a blocker forward automatically shifts all blocked issues |
| **Parent / child** | Group child issues under their parent row with `└` indent |
| **Assignee avatar** | First assignee's avatar shown as a thumbnail on the bar |
| **Issue status** | `●` open / `✓` closed appended to each bar label |
| **Label filter** | Filter visible rows by one or more labels |
| **Title search** | Free-text filter in the toolbar |
| **Sidebar** | Click any bar to edit dates, progress, labels, parent, and dependencies |
| **Save** | Batch-save all pending changes to GitHub (issue body GANTT_META + sub-issues API) |
| **View modes** | Quarter Day · Half Day · Day · Week · Month |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18  
- [pnpm](https://pnpm.io/) or npm  
- A GitHub Personal Access Token with `repo` scope

### Install & run locally

```bash
# from the repo root
cd github-gantt
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

### Build for production

```bash
npm run build
# output is in github-gantt/dist/
```

Serve the `dist/` folder with any static file host.

---

## Setup in the app

1. Click the **⚙ Settings** button (top-right).
2. Enter your **GitHub token** (PAT with `repo` scope).
3. Enter the **repository** in `owner/repo` format (e.g. `octocat/hello-world`).
4. Click **Load Issues**.

---

## How dates are stored

Each issue's Gantt metadata is stored as a hidden HTML comment in the issue body — invisible on GitHub.com but readable by this app:

```
<!-- GANTT_META: {"start":"2024-01-01","end":"2024-01-10","progress":30,"deps":["5","12"]} -->
```

Saving writes this comment back via the GitHub REST API. Nothing else in the issue body is changed.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `b` | Add a **blocked-by** dependency to the selected issue |
| `p` | Set a **parent** issue for the selected issue |
| `Esc` | Close any open dialog |

Select an issue first by clicking its bar.

---

## Dependency rules

- **Blockers appear above** the issues they block in the row order.
- **Dragging a blocked issue** before its blocker's end date is prevented — the start is clamped automatically.
- **Moving a blocker forward** cascades a shift to all transitively blocked issues.
- **Parent relationships** are separate from blocking dependencies — they group rows visually but do not draw dependency arrows.

---

## Project structure

```
github-gantt/
  index.html          # App shell + modal dialogs
  src/
    main.js           # UI, state, interactions
    github.js         # GitHub REST API helpers
    mapper.js         # Issue ↔ Gantt task conversion + GANTT_META
    style.css         # All styles
  vite.config.js

gantt/                # Local fork of frappe-gantt
  src/
    index.js          # Core Gantt class
    bar.js            # Bar rendering (supports thumbnail)
    defaults.js       # View configs (Day view shows day-of-week)
    styles/
```

---

## License

MIT
