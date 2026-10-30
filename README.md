# TaskX

## What it is

One screen listing your projects in the priority order you set, each showing what you did last and what's next.

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

Copy the file before you edit it by hand: if it will not parse, the app starts empty and saves the unreadable copy as `data.json.corrupt.bak`.
