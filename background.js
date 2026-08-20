'use strict';

// Tab Merger — service worker.
//
// All window/tab logic lives here rather than in the popup: the popup is anchored
// to the focused window, so if that window happens to be a source it is destroyed
// the moment its last tab leaves, taking an in-flight merge down with it. The
// service worker is bound to no window and survives the whole operation.

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// chrome.windows and chrome.system.display report in the same screen coordinate
// space (origin = top-left of the primary display), so window and display rects
// are directly comparable — no conversion needed.

function hasGeometry(rect) {
  return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite);
}

function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function unionOf(rects) {
  const usable = rects.filter(hasGeometry);
  if (!usable.length) return null;
  const left = Math.min(...usable.map((r) => r.left));
  const top = Math.min(...usable.map((r) => r.top));
  const right = Math.max(...usable.map((r) => r.left + r.width));
  const bottom = Math.max(...usable.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

function squaredDistance(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

async function getDisplays() {
  try {
    return await chrome.system.display.getInfo();
  } catch (err) {
    // Not fatal — we fall back to the windows' own bounds for the arrangement.
    console.warn('[tab-merger] system.display unavailable:', err);
    return [];
  }
}

function displayContaining(rect, displays) {
  if (!hasGeometry(rect)) return null;
  const point = centerOf(rect);
  return (
    displays.find(
      (d) =>
        point.x >= d.bounds.left &&
        point.x < d.bounds.left + d.bounds.width &&
        point.y >= d.bounds.top &&
        point.y < d.bounds.top + d.bounds.height
    ) || null
  );
}

// ---------------------------------------------------------------------------
// Which windows take part
// ---------------------------------------------------------------------------

// tabs.move and tabGroups.move both reject anything that isn't type "normal",
// and Chrome forbids crossing the incognito boundary. Skipping PWA/--app
// windows, popups and DevTools is correct behavior, not a shortcoming: merging
// a PWA window into a browser window would break it.
function isMergeable(win) {
  return win.type === 'normal' && !win.incognito;
}

// Minimized windows still donate their tabs, but making one the target would
// dump everything into a window you cannot see.
function canHostMerge(win) {
  return win.state !== 'minimized' && hasGeometry(win);
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// Smallest distance from the arrangement centre wins. Ties break on tab count
// (the bigger window moves fewer tabs) and then on id, so the choice is stable.
function pickTarget(candidates, center) {
  let best = null;
  let bestScore = null;
  for (const win of candidates) {
    const distance = center && hasGeometry(win) ? squaredDistance(centerOf(win), center) : Infinity;
    const score = [distance, -win.tabs.length, win.id];
    if (!best || lexLess(score, bestScore)) {
      best = win;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Plan (what the popup shows before anything moves)
// ---------------------------------------------------------------------------

async function buildPlan() {
  const windows = await chrome.windows.getAll({ populate: true });
  const displays = await getDisplays();

  const mergeable = windows.filter(isMergeable);
  const skippedIncognito = windows.filter((w) => w.incognito).length;
  const skippedOtherType = windows.filter((w) => !w.incognito && w.type !== 'normal').length;

  // Fall back to the full mergeable set if every window is minimized, so the
  // merge still works rather than reporting nothing to do.
  const hosts = mergeable.filter(canHostMerge);
  const candidates = hosts.length ? hosts : mergeable;

  const arrangement = unionOf(displays.length ? displays.map((d) => d.bounds) : mergeable);
  const target = pickTarget(candidates, arrangement ? centerOf(arrangement) : null);

  if (!target) {
    return { targetWindowId: null, sourceWindowCount: 0, movingTabCount: 0, skippedIncognito, skippedOtherType };
  }

  const sources = mergeable.filter((w) => w.id !== target.id);
  const display = displayContaining(target, displays);

  return {
    targetWindowId: target.id,
    targetTabCount: target.tabs.length,
    targetDisplayName: display ? display.name : null,
    sourceWindowCount: sources.length,
    movingTabCount: sources.reduce((n, w) => n + w.tabs.length, 0),
    skippedIncognito,
    skippedOtherType,
  };
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

async function mergeInto(targetWindowId) {
  const windows = await chrome.windows.getAll({ populate: true });
  const target = windows.find((w) => w.id === targetWindowId);
  if (!target) throw new Error(`target window ${targetWindowId} no longer exists`);

  const sources = windows.filter((w) => isMergeable(w) && w.id !== targetWindowId);
  const sourceIds = new Set(sources.map((w) => w.id));

  // Groups move as groups. Moving their tabs individually would dissolve the
  // group, so grouped tabs are excluded from the per-window tabs.move below.
  let movedGroups = 0;
  for (const group of await chrome.tabGroups.query({})) {
    if (!sourceIds.has(group.windowId)) continue;
    await chrome.tabGroups.move(group.id, { windowId: targetWindowId, index: -1 });
    movedGroups += 1;
  }

  // Pinned tabs belong in the pinned strip — the leading run of the tab strip —
  // so they get an explicit index instead of -1, which aims past it. Chrome also
  // drops the pinned flag outright when a tab crosses a window boundary, so each
  // one has to be re-pinned after the move; verified against Chrome 151.
  let pinnedSlot = target.tabs.filter((t) => t.pinned).length;
  let movedTabs = 0;

  for (const win of sources) {
    const loose = win.tabs
      .filter((t) => t.groupId === undefined || t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
      .sort((a, b) => a.index - b.index);

    for (const tab of loose.filter((t) => t.pinned)) {
      await chrome.tabs.move(tab.id, { windowId: targetWindowId, index: pinnedSlot });
      await chrome.tabs.update(tab.id, { pinned: true });
      pinnedSlot += 1;
      movedTabs += 1;
    }

    // The array form preserves relative order in one call.
    const unpinned = loose.filter((t) => !t.pinned).map((t) => t.id);
    if (unpinned.length) {
      await chrome.tabs.move(unpinned, { windowId: targetWindowId, index: -1 });
      movedTabs += unpinned.length;
    }
  }

  // Emptied source windows close themselves — Chrome disposes a window once its
  // last tab leaves. Nothing here closes a window, and nothing reloads.
  const restore = target.state === 'minimized' ? { state: 'normal' } : {};
  await chrome.windows.update(targetWindowId, { focused: true, ...restore });
  return { movedTabs, movedGroups };
}

// ---------------------------------------------------------------------------
// Error surfacing
// ---------------------------------------------------------------------------

// A failed merge must be visible. The badge is cleared when the popup next asks
// for a plan rather than on a timer: a service worker can be torn down before a
// setTimeout fires, which would strand the badge forever.

async function flagError() {
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: '!' });
}

async function clearError() {
  await chrome.action.setBadgeText({ text: '' });
}

// ---------------------------------------------------------------------------
// Messages from the popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'plan') {
    clearError();
    buildPlan()
      .then(sendResponse)
      .catch((err) => {
        console.error('[tab-merger] could not build a plan:', err);
        sendResponse({ error: String(err) });
      });
    return true; // response is async
  }

  if (message && message.type === 'merge') {
    // Deliberately not awaited and deliberately not answered: the popup has
    // already closed itself, and holding the message port open for a closed
    // popup logs a spurious error on the extension card.
    mergeInto(message.targetWindowId)
      .then(({ movedTabs, movedGroups }) => {
        console.log(`[tab-merger] moved ${movedTabs} tabs and ${movedGroups} groups`);
      })
      .catch((err) => {
        console.error('[tab-merger] merge failed:', err);
        flagError();
      });
    return false;
  }

  return false;
});
