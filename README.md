# TaskX

## What it is

A small, sharp-cornered panel that floats off the left edge of the desktop. It sits there as one square tile, opens when you move towards it, and shows your projects in the priority order you set. Each project keeps a log of what you did on it — every entry stays, dated, forever — plus the one line saying what's next.

The look is deliberately plain: solid surfaces, hairline borders, one accent colour, no blur, no gradients, no shadows. Dark, always — it does not follow the Windows app theme.

## Run it

```bash
npm install
npm run dev     # build and run
npm run build   # installer in src-tauri/target/release/bundle
```

Requires the Rust toolchain and the MSVC build tools; WebView2 ships with Windows.

`npm test` runs the Rust tests: the storage layer (15 cases, ported from the earlier Electron build) and the easing curve the panel animates on.

## Using it

Every project reads the same way, three lines, each with its own mark:

- **★ name · 2h** — the star marks it important; starred projects sit on top with a blue bar. The age is the time since the last log entry.
- **☐ next step** — white. Tick the box when it is done: it moves into the log and the field clears for the next one.
- **✓ last thing done** — grey, one line.

Moving around:

- A square tile with the Northstar mark sits half tucked past the left edge, halfway down. That is TaskX at rest.
- Point at it: after 80 ms it opens into a small card with every starred project and the log field. The card is as tall as what it holds.
- `Alt+X` (or the notification-area icon) opens the card from anywhere with the cursor already in the log field: type, `Enter`, done.
- The arrows in the card's header open the dashboard: every project on the left, the selected one on the right with its next step and its full log.
- Move away: the card closes back to the tile after 450 ms. It never closes under you while you are typing or holding a half-typed log line.
- ↑/↓ on a row reorder it within its group; a starred project never sinks below a plain one.
- The pin keeps the panel open. The chevron or `Escape` closes it. Alt+F4 hides it to the notification area.
- `Ctrl+N` adds a project, `Enter` commits a log line, `Escape` drops a half-typed one.
- The notification-area menu has "Start at login". It is on after the first install, and stays off once you turn it off.

The panel keeps a single instance running; starting it again just opens it. It is always above other windows and never appears in the taskbar. Its sizes and position are constants in `src-tauri/src/panel.rs`. Nothing is composited behind it: the surfaces are opaque, which is what makes the design hold on Windows 10 without acrylic, Mica or `backdrop-filter`.

## Where your data lives

Windows:

```
%APPDATA%\taskx\data.json
```

which is `C:\Users\<you>\AppData\Roaming\taskx\data.json`. The Tauri build reads and writes the same file the Electron build did, so nothing was migrated or moved.

It is plain JSON — open it in any editor, copy it to back it up. Deleting the file resets the app to its empty state.

Each project holds `entries` (a dated log, oldest first; nothing is ever removed), `next`, and `star` when it is important. Typing is saved 300 ms after the last key. Each entry also keeps the `next` line as it stood at that moment, so the history shows what you meant to do next at the time. The app keeps the previous version of the file as `data.json.bak` on every write, and an unreadable one as `data.json.corrupt.bak`.

Copy the file before you edit it by hand: if it will not parse, the app starts empty and saves the unreadable copy as `data.json.corrupt.bak`.

Set `TASKX_DATA` to a path to run against a different file, which is how the tests stay off your real data.
