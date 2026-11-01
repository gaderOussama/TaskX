# TaskX

## What it is

A piece of translucent glass attached to the left edge of the desktop. It sits there as a thin lit strip, opens when you move towards it, and shows your projects in the priority order you set. Each project keeps a log of what you did on it — every entry stays, dated, forever — plus the one line saying what's next.

## Run it

```bash
npm install
npm run dev     # build and run
npm run build   # installer in src-tauri/target/release/bundle
```

Requires the Rust toolchain and the MSVC build tools; WebView2 ships with Windows.

`npm test` runs the Rust tests: the storage layer (18 cases, ported from the earlier Electron build) and the easing curve the panel animates on.

## Using it

- Move the pointer onto the strip on the left edge: the panel opens after 80 ms.
- Move away: it closes after 450 ms. Come back while it is closing and it reverses from where it is.
- It never closes under you while you are typing or while a half-typed log line is uncommitted.
- The pin in the header keeps it open. The chevron closes it.
- `Alt+X` toggles it from anywhere. The notification-area icon does the same, and offers Quit.
- `Ctrl+N` adds a project, `Enter` commits a log line, `Escape` drops a half-typed one and closes the panel.

The panel keeps a single instance running; starting it again just opens it. It is always above other windows and never appears in the taskbar. The expanded width, collapsed width and the left margin are constants at the top of `src-tauri/src/panel.rs`.

## Where your data lives

Windows:

```
%APPDATA%\taskx\data.json
```

which is `C:\Users\<you>\AppData\Roaming\taskx\data.json`. The Tauri build reads and writes the same file the Electron build did, so nothing was migrated or moved.

It is plain JSON — open it in any editor, copy it to back it up. Deleting the file resets the app to its empty state.

Each project holds `entries` (a dated log, oldest first; nothing is ever removed) and `next`. Each entry also keeps the `next` line as it stood at that moment, so the history shows what you meant to do next at the time. The app keeps the previous version of the file as `data.json.bak` on every write, and an unreadable one as `data.json.corrupt.bak`.

Copy the file before you edit it by hand: if it will not parse, the app starts empty and saves the unreadable copy as `data.json.corrupt.bak`.

Set `TASKX_DATA` to a path to run against a different file, which is how the tests stay off your real data.
