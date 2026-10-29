# TaskX — Design

**Date:** 2026-10-29
**Status:** awaiting approval
**Size:** small project — short design, no reviewer round

## Intent

One window that answers two questions in a glance:

1. **What should I work on next?** — projects ordered by the priority I set.
2. **Where did I leave this one?** — one line of "last", one line of "next" per project.

Not a project manager. Not a memory engine. A compass with a memory.

## Why now

Work is spread across several projects. Reconstructing context costs time and, worse, the uncertainty makes it easier to open nothing at all. The failure mode to fix is the twenty minutes of scrolling before touching any work.

## Goals

- Open the app and know what to do within ten seconds.
- Capture "what I did" and "what's next" in under ten seconds, without leaving the window.
- Survive a full restart with nothing lost.
- Work with no account, no network, no API key.

## Non-goals (v1)

- Git status, commits, branches.
- Launching an editor or terminal.
- Search, tags, due dates, calendars, time tracking.
- Notes beyond the two lines, sessions, history, decisions log.
- Cloud sync, accounts, sharing.
- Any AI feature.

## Anti-goals

- Becoming a second thing to maintain. If it takes longer to update than to remember, it has failed.
- A dashboard that looks impressive and is opened twice.
- Auto-detecting context from files or commits before the manual habit is proven.

## Constraints

- Windows-first. Runs on the installed Node 22; no Rust toolchain, no build step, no bundler.
- Single local user.
- Plain JavaScript. No React, no TypeScript, no transpiler.

## Approaches considered

| | What it is | Trade |
|---|---|---|
| **A. Tauri 2** | ~10 MB native shell from the original proposal | Needs Rust + MSVC Build Tools (1–3 GB, not installed). Setup risk before any window appears. |
| **B. Electron, vanilla** | Real desktop window on the existing Node install | ~150 MB on disk for Electron's runtime. No build tooling. |
| **C. HTML file in a browser** | 30 lines, zero install | A tab that gets forgotten; browser storage can be cleared. Fails the habit test. |

**Chosen: B.** The hypothesis under test is "will I record a line before I close the laptop". Spending the first day on a Rust toolchain delays that test. If the app earns a second month, the shell can move to Tauri — the UI and storage do not change.

## How it is built

### Stack

Electron, vanilla HTML/CSS/JS, `node:test` for the store. No dependencies beyond Electron.

```text
TaskX/
├─ package.json
├─ main.js              Electron main: window, IPC, app lifecycle
├─ preload.js           contextBridge: load/save only
├─ store.js             pure module: validate, sort, atomic load/save
├─ renderer/
│  ├─ index.html
│  ├─ style.css
│  └─ app.js            state, render, inline edit, reorder
├─ test/
│  └─ store.test.js
└─ docs/superpowers/specs/2026-10-29-taskx-design.md
```

### Security posture

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer never touches `fs`; it calls two IPC channels through the preload bridge. No shell execution, no remote content, no navigation away from the local file.

### Storage

One JSON file in `app.getPath('userData')/data.json`. Written atomically (temp file + rename) so a crash mid-save cannot truncate it.

```json
{
  "version": 1,
  "projects": [
    { "id": "p1", "name": "Bud Bud", "priority": 0,
      "last": "Refined reminder behaviour.", "next": "Test three postponements.", "updatedAt": 1730... }
  ]
}
```

A JSON file rather than SQLite: six projects, one writer, and the file stays openable in Notepad. `version` exists so a later migration has somewhere to look.

`store.js` exports a factory taking the file path, so tests run against a temp directory instead of the real profile.

### Screen

One window, ~760×560, no tabs, no navigation.

- Projects listed top to bottom by `priority`, best first. Priority 0 is the current north star and is visually marked.
- Each row: name, `last:`, `next:`.
- Click a row to edit `name`, `last`, `next` in place.
- Arrow buttons move a project up or down. Saving re-numbers priorities sequentially.
- `+ Add project`, and a delete confirmed once.
- Empty state says one line: add your first project.
- Calm visual: no gradients, no cards floating in space, no icons that need labels.

### Behaviour rules

- Every edit saves immediately. There is no Save button and no unsaved state.
- Sort is by priority number only — never by date, never by name. Opening the app must not reorder anything.
- `last` and `next` are free text, one line each. No formatting, no markdown.

## What is left to the builder

- Exact layout, spacing and type scale.
- Whether reorder is arrow buttons or drag; arrows are the default because they are testable and obvious.
- The empty-state copy.
- Window title and app icon.

## Done means

1. Start the app from a clean checkout.
2. Add two real projects.
3. Give each a `last` and a `next`.
4. Quit the app fully, reopen it — both projects, both lines, same order.
5. Move project B above project A, quit, reopen — order holds.
6. Editing a line takes under ten seconds from click to saved.

`node --test` covers the store: load of missing file, round-trip save, atomic replace, priority renumbering, and a malformed file not crashing the app.
