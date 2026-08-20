# Project Guide

## Overview
Unpacked MV3 Chrome extension (no build step, no dependencies). Also vendored as
a reference copy in `kyle-lesinger/mac-migration` under
`chrome-extension/tab-merger/`; this repo is the canonical source. Moves every tab
from every scattered Chrome window into the window nearest the centre of the
display arrangement, after a confirmation popup. Triggered by the toolbar button
or ⌘⇧K.

## Key files
- `manifest.json` — MV3, `minimum_chrome_version` 99, permissions, action popup,
  `_execute_action` command
- `background.js` — the whole implementation: `buildPlan()`, `mergeInto()`, the
  `onMessage` router, error badge
- `popup.html` / `popup.js` — confirmation UI only; no window or tab logic

## Install
Not scriptable — Chrome has blocked command-line sideloading of unpacked
extensions since Chrome 137 (`--load-extension` is ignored). It is
`chrome://extensions` → Developer mode → **Load unpacked**, once per profile,
then confirm ⌘⇧K at `chrome://extensions/shortcuts`. Chrome loads the extension
live from the clone, so the checkout has to stay put.

## Critical constraints
- **The merge must run in `background.js`, never in the popup.** The popup is
  anchored to the focused window; if that window is a merge source, Chrome
  destroys it — and the popup with it — the moment its last tab leaves, aborting
  the merge partway. `popup.js` sends a message and calls `window.close()`.
- **Chrome clears a tab's `pinned` flag when it moves between windows.** Every
  pinned tab must be re-pinned with `chrome.tabs.update(id, {pinned: true})`
  after the move. This is not theoretical — it was caught by the end-to-end test,
  which asserts the flag both before and after.
- **Tab groups must move via `chrome.tabGroups.move()`, whole.** Moving a grouped
  tab with `chrome.tabs.move()` silently removes it from its group, so grouped
  tabs are excluded from the per-window `tabs.move()` call.
- **Only `type === "normal"`, non-incognito windows may take part.** Both move
  APIs reject anything else, and Chrome forbids crossing the incognito boundary.
- **Don't add the `tabs` permission.** Nothing here needs it: `tabs.move()`
  requires no permission, and `windowId` / `index` / `pinned` / `groupId` are all
  readable without it. Adding it would hand the extension every URL and title for
  no gain.
- **Keep `background.js` a classic (non-module) service worker** with no imports
  shared with `popup.js`. That is what keeps `node --check` a real syntax gate —
  it parses `.js` as CommonJS and rejects top-level `import`.

## Non-obvious gotchas
- **An MV3 service worker only exists while it has work.** It will not appear as a
  debug target until something wakes it, which is why the popup opening (the
  `plan` message) is what starts it.
- **The error badge is cleared on the next `plan` request, not on a timer.** A
  service worker can be torn down before a `setTimeout` fires, which would strand
  the badge forever.
- **Chrome refuses window bounds that are less than 50% on screen** — relevant
  only to the test harness, which must place windows inside real display work
  areas rather than at the corners of the bounding box.
- **Extension id is derived from the directory path** for unpacked extensions, so
  moving the checkout resets the keyboard shortcut and toolbar pin.
- **No icon files.** The manifest ships no `default_icon`, so Chrome falls back
  to a monogram button — still clickable and pinnable. Adding real icons is a
  fine enhancement; they must be raster (PNG), as Chrome rejects SVG here.

## Verify
```sh
npm run test:all     # lint + unit suite + end-to-end
```
- `test/merge.test.js` — no browser; runs `background.js` in a `vm` against a
  mocked `chrome` API and a synthetic two-display layout.
- `test/e2e.js` — launches its own headless Chrome, loads the extension via the
  DevTools protocol (`Extensions.loadUnpacked`) and drives the real service
  worker.

The load-bearing assertion is that **tab ids survive the merge unchanged** — same
id means the tab was moved, not re-created, which is the whole point of this
extension existing rather than an AppleScript one. Both suites also assert pinned
state on each side of the merge, because that is how the cross-window unpin bug
was found. CI (`.github/workflows/ci.yml`) runs all of it on every push and PR.
