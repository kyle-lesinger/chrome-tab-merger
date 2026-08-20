'use strict';
// Unit suite: runs the real background.js inside a vm with a mocked chrome API,
// so buildPlan() and mergeInto() are exercised against a synthetic multi-display
// layout without needing a browser.
//
//   node test/merge.test.js

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

function tab(id, index, opts = {}) {
  return { id, index, pinned: false, groupId: -1, ...opts };
}

// Two displays side by side. Union = 0..3360 x 0..1080, so the arrangement
// centre is (1680, 540).
const displays = [
  { name: 'Left Display', bounds: { left: 0, top: 0, width: 1920, height: 1080 } },
  { name: 'Right Display', bounds: { left: 1920, top: 0, width: 1440, height: 900 } },
];

const windows = [
  // Far left — a loose window with a pinned tab and a grouped tab.
  { id: 1, type: 'normal', incognito: false, state: 'normal', left: 0, top: 0, width: 800, height: 600,
    tabs: [tab(11, 0, { pinned: true }), tab(12, 1), tab(13, 2), tab(14, 3, { groupId: 100 })] },
  // Nearest the arrangement centre of the *eligible* windows — should win.
  { id: 2, type: 'normal', incognito: false, state: 'normal', left: 1500, top: 300, width: 700, height: 500,
    tabs: [tab(21, 0, { pinned: true }), tab(22, 1), tab(23, 2)] },
  // Far right.
  { id: 3, type: 'normal', incognito: false, state: 'normal', left: 2600, top: 500, width: 600, height: 400,
    tabs: [tab(31, 0), tab(32, 1)] },
  // Centre is EXACTLY the arrangement centre — but minimized, so it must donate
  // its tabs and never be chosen as the target.
  { id: 4, type: 'normal', incognito: false, state: 'minimized', left: 1330, top: 290, width: 700, height: 500,
    tabs: [tab(41, 0), tab(42, 1)] },
  // Must be left completely alone.
  { id: 5, type: 'normal', incognito: true, state: 'normal', left: 200, top: 200, width: 800, height: 600,
    tabs: [tab(51, 0), tab(52, 1), tab(53, 2)] },
  { id: 6, type: 'popup', incognito: false, state: 'normal', left: 300, top: 300, width: 400, height: 300,
    tabs: [tab(61, 0)] },
];

const groups = [{ id: 100, windowId: 1, title: 'research', color: 'blue' }];

const calls = [];
const chrome = {
  windows: {
    getAll: async () => JSON.parse(JSON.stringify(windows)),
    update: async (id, props) => calls.push(['windows.update', id, props]),
  },
  tabs: {
    move: async (ids, props) => calls.push(['tabs.move', ids, props]),
    update: async (id, props) => calls.push(['tabs.update', id, props]),
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    query: async () => JSON.parse(JSON.stringify(groups)),
    move: async (id, props) => calls.push(['tabGroups.move', id, props]),
  },
  system: { display: { getInfo: async () => JSON.parse(JSON.stringify(displays)) } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  runtime: { onMessage: { addListener: () => {} } },
};

const ctx = vm.createContext({ chrome, console });
vm.runInContext(SRC, ctx);

(async () => {
  console.log('--- buildPlan ---');
  const plan = await ctx.buildPlan();
  console.log(JSON.stringify(plan, null, 2));

  check('target is the central non-minimized window', plan.targetWindowId, 2);
  check('minimized window is NOT the target', plan.targetWindowId !== 4, true);
  check('target tab count', plan.targetTabCount, 3);
  check('target display named', plan.targetDisplayName, 'Left Display');
  check('source windows (excl. incognito + popup)', plan.sourceWindowCount, 3);
  check('tabs to move (4 + 2 + 2)', plan.movingTabCount, 8);
  check('incognito windows skipped', plan.skippedIncognito, 1);
  check('non-normal windows skipped', plan.skippedOtherType, 1);

  console.log('\n--- mergeInto ---');
  const result = await ctx.mergeInto(2);
  for (const c of calls) console.log(' ', JSON.stringify(c));

  const groupMoves = calls.filter((c) => c[0] === 'tabGroups.move');
  check('the group moved as a group', groupMoves, [['tabGroups.move', 100, { windowId: 2, index: -1 }]]);

  const tabMoves = calls.filter((c) => c[0] === 'tabs.move');
  check('grouped tab 14 never moved individually',
    tabMoves.some((c) => JSON.stringify(c[1]).includes('14')), false);
  check("pinned tab 11 lands after the target's 1 existing pinned tab",
    tabMoves.find((c) => c[1] === 11), ['tabs.move', 11, { windowId: 2, index: 1 }]);
  check('window 1 unpinned tabs move together, in order',
    tabMoves.find((c) => Array.isArray(c[1]) && c[1][0] === 12), ['tabs.move', [12, 13], { windowId: 2, index: -1 }]);
  check('window 3 tabs move together',
    tabMoves.find((c) => Array.isArray(c[1]) && c[1][0] === 31), ['tabs.move', [31, 32], { windowId: 2, index: -1 }]);
  check('minimized window 4 still donates its tabs',
    tabMoves.find((c) => Array.isArray(c[1]) && c[1][0] === 41), ['tabs.move', [41, 42], { windowId: 2, index: -1 }]);
  check('no incognito tab touched',
    tabMoves.some((c) => JSON.stringify(c[1]).match(/5[123]/)), false);
  check('totals reported', result, { movedTabs: 7, movedGroups: 1 });
  check('target focused at the end', calls[calls.length - 1], ['windows.update', 2, { focused: true }]);
  check('the moved pinned tab is re-pinned (Chrome drops the flag across windows)',
    calls.filter((c) => c[0] === 'tabs.update'), [['tabs.update', 11, { pinned: true }]]);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
