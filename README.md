# chrome-tab-merger

Merge every scattered Chrome window into one — **without losing anything**.

Chrome has no "Merge All Windows" (Safari does). When your tabs end up strewn
across half a dozen windows on three monitors, your only options are dragging tabs
one at a time or right-clicking *Move Tab to Another Window* over and over.

This extension moves them all at once, into the window nearest the middle of your
display arrangement, after showing you exactly what it's about to do.

**Nothing reloads and nothing is lost.** Back/forward history, scroll position,
half-typed form input, pinned tabs and tab groups all survive, because the tabs are
*moved* rather than re-opened.

---

## Why an extension and not a menu-bar app

On macOS the obvious approach is AppleScript. It cannot work. Chrome's scripting
dictionary gives the `tab` class only `close`, `reload`, `execute`, `go back` and
friends — there is no `move` and no `duplicate`.

So an external app can only read a tab's URL, open a new tab in the target window,
and close the original. That silently destroys the tab's history, scroll position
and typed input, drops it out of any group, unpins it, and forces every merged tab
to reload at once — a network and memory stampede on top of the data loss.

`chrome.tabs.move()` relocates the live tab. That's only reachable from inside the
browser, which is why this is an extension.

---

## Install

Not on the Chrome Web Store — load it unpacked, once per Chrome profile:

1. `git clone https://github.com/kyle-lesinger/chrome-tab-merger.git` (keep the
   clone somewhere permanent — Chrome loads the extension live from that folder)
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the cloned folder
5. Pin the toolbar button via the puzzle-piece menu
6. Open `chrome://extensions/shortcuts` and confirm **⌘⇧K** / **Ctrl+Shift+K** —
   Chrome ignores a suggested shortcut until you've seen it on that page

Requires Chrome 99+. No build step, no dependencies, no network access.

---

## Use

Click the toolbar button or press the shortcut. A popup states the plan:

> Move 37 tabs from 5 windows into the window on Built-in Retina Display — 12 tabs
> already there.

Nothing moves until you press **Merge**.

---

## How it works

1. `chrome.system.display.getInfo()` gives every display's bounds. Their union is
   the display arrangement; its centre is the target point.
2. Candidates are windows of type `normal` that aren't incognito or minimized. The
   one whose centre is nearest the target point wins. Ties break on tab count, then
   window id, so the result is deterministic.
3. Tab groups move first and whole, via `chrome.tabGroups.move()` — moving their
   tabs individually would dissolve the group.
4. Pinned tabs move next, to an explicit index at the end of the target's pinned
   strip, then get re-pinned (see below).
5. Everything else moves per source window in one `chrome.tabs.move()` call, which
   preserves relative order.

Windows are never explicitly closed — Chrome disposes a window itself once its last
tab leaves.

The merge runs in the service worker, not the popup. The popup belongs to the
focused window, so if that window is one of the sources it is destroyed the instant
its last tab leaves, which would abort an in-flight merge halfway.

---

## Two Chrome behaviours this works around

Both were found by testing, and both are load-bearing:

- **Chrome clears a tab's `pinned` flag when it crosses a window boundary.** Each
  pinned tab is re-pinned after the move. Without that, merging silently unpins
  everything you had pinned.
- **Moving a grouped tab individually removes it from its group.** Groups are
  therefore moved whole, and grouped tabs are excluded from the ordinary move.

---

## Permissions

`"permissions": ["tabGroups", "system.display"]` — that's the entire list. No
`tabs` permission, no host permissions, no network access.

Moving tabs requires no permission, and `windowId` / `index` / `pinned` / `groupId`
are readable without `tabs`. The practical consequence: **this extension cannot
read the URL or title of any tab.** It counts and moves them blind.

---

## What it deliberately leaves alone

| Skipped | Why |
|---|---|
| Incognito windows | Chrome forbids moving tabs across the incognito boundary. |
| App / PWA windows, popups, DevTools | `tabs.move()` and `tabGroups.move()` only accept `type === "normal"`. Merging a PWA window into a browser window would break it. |
| Other Chrome profiles | An extension only sees the windows of the profile it's installed in. A merge in one profile can't move, close or even count another's. |

The popup names what it skipped, so a window left behind is never a mystery.

Install it separately in each profile you want it in — extensions, toolbar pins and
keyboard shortcuts are all per-profile.

There is no icon file, so Chrome renders its default monogram button. It is still
clickable and pinnable.

---

## Development

No dependencies and no build step — the tests are plain Node, nothing to install.

```sh
npm run lint        # node --check on both scripts
npm test            # unit suite, no browser needed
npm run test:e2e    # drives a real headless Chrome
npm run test:all    # all three
```

`test/merge.test.js` runs `background.js` inside a `vm` against a mocked `chrome`
API and a synthetic two-display layout, asserting target selection, the skip
rules, group handling and pinned-tab handling.

`test/e2e.js` launches its own throwaway headless Chrome and cleans up after
itself. Chrome has ignored the `--load-extension` switch since Chrome 137, so the
extension goes in via the DevTools protocol's `Extensions.loadUnpacked` (which
needs `--enable-unsafe-extension-debugging`); the suite then attaches to the
service-worker target and drives `buildPlan()` / `mergeInto()` with
`Runtime.evaluate` against real windows.

The assertion that matters: **every tab keeps its original tab id** across a merge.
A re-created tab gets a new id, so identical ids before and after prove the tabs
were genuinely moved — which is the entire premise of the extension.

The pinned-tab workaround above exists because this suite caught it: the tab was
pinned before the merge and unpinned after. The E2E suite asserts pinned state on
both sides of the merge for that reason.

---

## License

MIT — see [LICENSE](LICENSE).
