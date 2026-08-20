'use strict';
// End-to-end suite: launches a throwaway headless Chrome, loads this extension
// into it, and drives the real buildPlan() / mergeInto() against real windows.
//
//   node test/e2e.js
//
// Chrome has ignored the --load-extension switch since Chrome 137, so the
// extension goes in via the DevTools protocol's Extensions.loadUnpacked, which
// needs --enable-unsafe-extension-debugging.
//
// The load-bearing assertion is that every tab keeps its ORIGINAL tab id across
// the merge. A re-created tab gets a new id, so identical ids before and after
// prove the tabs were genuinely moved — the entire premise of this extension.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium']) {
    try { return execSync(`command -v ${name}`, { encoding: 'utf8' }).trim(); } catch {}
  }
  return null;
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  const ready = new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', no); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { ws, ready, send };
}

(async () => {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Could not find Chrome. Set CHROME_PATH to the browser binary.');
    process.exit(1);
  }
  console.log('chrome:', chromePath);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-merger-e2e-'));
  const child = spawn(chromePath, [
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  // Chrome writes the port it actually bound to here.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 60 && !port; i += 1) {
    await sleep(500);
    if (fs.existsSync(portFile)) {
      const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (first) port = first;
    }
  }
  if (!port) { console.error('Chrome never reported a debugging port'); cleanup(); process.exit(1); }

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  console.log('version:', version.Browser, '\n');

  const { ws, ready, send } = cdp(version.webSocketDebuggerUrl);
  await ready;
  await send('Target.setDiscoverTargets', { discover: true });

  const { id: EXT } = await send('Extensions.loadUnpacked', { path: ROOT });
  console.log('extension id:', EXT);

  // An MV3 service worker only exists while it has work; opening the popup page
  // fires the 'plan' message, which starts it.
  const waker = await send('Target.createTarget', { url: `chrome-extension://${EXT}/popup.html` });
  await sleep(1500);
  let worker;
  for (let i = 0; i < 20 && !worker; i += 1) {
    const { targetInfos } = await send('Target.getTargets');
    worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(EXT));
    if (!worker) await sleep(500);
  }
  if (!worker) { console.error('extension service worker never started'); ws.close(); cleanup(); process.exit(1); }

  const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  };

  const snapshot = `(async () => (await chrome.windows.getAll({populate:true}))
      .filter(w => w.type === 'normal')
      .map(w => ({ id: w.id, left: w.left, top: w.top, width: w.width, height: w.height,
                   tabs: w.tabs.map(t => ({ id: t.id, pinned: t.pinned, groupId: t.groupId })) })))()`;

  console.log('\n--- setup ---');
  const setup = await run(`(async () => {
    const W = 300, H = 250;
    const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(v, hi)));
    const d = (await chrome.system.display.getInfo())[0].workArea;
    const cx = d.left + d.width / 2, cy = d.top + d.height / 2;

    // Drop every pre-existing window but one, and park it in the top-left corner.
    const existing = (await chrome.windows.getAll({ populate: true })).filter(w => w.type === 'normal');
    for (const w of existing.slice(1)) await chrome.windows.remove(w.id);
    const corner = existing[0];
    await chrome.windows.update(corner.id, { state: 'normal', left: d.left, top: d.top, width: W, height: H });

    // Chrome rejects window bounds less than 50% on screen, so clamp into the work area.
    const centre = await chrome.windows.create({ url: ['about:blank','about:blank'],
      left: clamp(cx - W/2, d.left, d.left + d.width - W),
      top: clamp(cy - H/2, d.top, d.top + d.height - H), width: W, height: H, focused: false });
    const far = await chrome.windows.create({ url: ['about:blank','about:blank','about:blank'],
      left: clamp(d.left + d.width - W, d.left, d.left + d.width - W),
      top: clamp(d.top + d.height - H, d.top, d.top + d.height - H), width: W, height: H, focused: false });

    const cornerTabs = (await chrome.windows.get(corner.id, { populate: true })).tabs;
    await chrome.tabs.update(cornerTabs[0].id, { pinned: true });
    const gid = await chrome.tabs.group({ tabIds: [far.tabs[1].id, far.tabs[2].id] });
    await chrome.tabGroups.update(gid, { title: 'research', color: 'blue' });

    return { arrangementCentre: { cx, cy }, roles: { corner: corner.id, centre: centre.id, far: far.id },
             pinnedTabId: cornerTabs[0].id, groupId: gid };
  })()`);

  const before = await run(snapshot);
  for (const w of before) {
    const role = Object.entries(setup.roles).find(([, id]) => id === w.id)?.[0] || '?';
    console.log(`  ${role.padEnd(7)} win ${w.id} at (${w.left},${w.top}) ${w.width}x${w.height} tabs=${w.tabs.length}`);
  }

  // Prove the setup is sound before drawing any conclusion from the merge.
  const pinnedBefore = before.flatMap((w) => w.tabs).filter((t) => t.pinned);
  check('SETUP: exactly one pinned tab exists before merging', pinnedBefore.length, 1);
  check('SETUP: it is the tab we pinned', pinnedBefore[0]?.id, setup.pinnedTabId);

  const { cx, cy } = setup.arrangementCentre;
  const nearest = before
    .map((w) => ({ id: w.id, d: Math.round((w.left + w.width / 2 - cx) ** 2 + (w.top + w.height / 2 - cy) ** 2) }))
    .sort((a, b) => a.d - b.d);
  check('SETUP: the centre window is unambiguously nearest',
    [nearest[0].id, nearest[0].d < nearest[1].d], [setup.roles.centre, true]);

  const idsBefore = before.flatMap((w) => w.tabs.map((t) => t.id)).sort((a, b) => a - b);

  console.log('\n--- buildPlan ---');
  const plan = await run('buildPlan()');
  console.log(JSON.stringify(plan));
  check('plan targets the geometrically central window', plan.targetWindowId, setup.roles.centre);

  console.log('\n--- mergeInto ---');
  console.log('result:', JSON.stringify(await run(`mergeInto(${plan.targetWindowId})`)));
  const after = await run(snapshot);

  check('exactly one normal window remains', after.length, 1);
  check('the survivor is the central window', after[0].id, setup.roles.centre);
  check('every tab kept its ORIGINAL id (moved, not recreated)',
    after.flatMap((w) => w.tabs.map((t) => t.id)).sort((a, b) => a - b), idsBefore);
  check('the pinned tab is STILL pinned', after[0].tabs.filter((t) => t.pinned).map((t) => t.id), [setup.pinnedTabId]);
  check('the pinned tab sits at the head of the strip', after[0].tabs[0].id, setup.pinnedTabId);

  const groups = await run(`(async () => (await chrome.tabGroups.query({}))
      .map(g => ({id:g.id,title:g.title,color:g.color,windowId:g.windowId})))()`);
  check('the group survived intact in the target',
    groups, [{ id: setup.groupId, title: 'research', color: 'blue', windowId: setup.roles.centre }]);

  await send('Target.closeTarget', { targetId: waker.targetId }).catch(() => {});
  console.log(`\n${failures === 0 ? 'ALL E2E CHECKS PASSED' : failures + ' E2E CHECK(S) FAILED'}`);
  ws.close();
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
