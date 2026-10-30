# TaskX

## What it is

One screen listing your projects in the priority order you set. Each project keeps a log of what you did on it — every entry stays, dated, forever — plus the one line saying what's next.

## Run it

```bash
npm install
npm start
```

`npm test` runs the storage tests (`node --test`). It covers the storage layer only — the window and its interactions are not tested.

Closing the window hides TaskX to the notification area; it keeps running. Click the T icon there to bring it back, or right-click it and choose Quit to really exit.

It also starts on its own at login, hidden in the notification area. To stop that, remove the `TaskX` entry from Settings → Apps → Startup.

## Where your data lives

Windows:

```
%APPDATA%\taskx\data.json
```

which is `C:\Users\<you>\AppData\Roaming\taskx\data.json`.

It is plain JSON — open it in any editor, copy it to back it up. Deleting the file resets the app to its empty state.

Each project holds `entries` (a dated log, oldest first; nothing is ever removed) and `next`. The app keeps the previous version of the file as `data.json.bak` on every write, and an unreadable one as `data.json.corrupt.bak`.

Copy the file before you edit it by hand: if it will not parse, the app starts empty and saves the unreadable copy as `data.json.corrupt.bak`.
