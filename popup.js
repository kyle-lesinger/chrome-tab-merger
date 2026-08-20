'use strict';

// Pure UI. Every window/tab operation happens in background.js — see the comment
// at the top of that file for why the popup must not do the merging itself.

const summary = document.getElementById('summary');
const note = document.getElementById('note');
const mergeButton = document.getElementById('merge');
const cancelButton = document.getElementById('cancel');

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function joinPhrases(phrases) {
  if (phrases.length < 2) return phrases[0] || '';
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

function describeSkipped(plan) {
  const phrases = [];
  if (plan.skippedIncognito) phrases.push(count(plan.skippedIncognito, 'incognito window'));
  if (plan.skippedOtherType) phrases.push(count(plan.skippedOtherType, 'app window'));
  return phrases.length ? `Leaving ${joinPhrases(phrases)} alone.` : '';
}

function render(plan) {
  note.textContent = describeSkipped(plan);

  if (!plan.targetWindowId || plan.sourceWindowCount === 0) {
    summary.textContent = 'Nothing to merge — everything is already in one window.';
    return;
  }

  const where = plan.targetDisplayName
    ? `the window on ${plan.targetDisplayName}`
    : 'the middle window';
  summary.textContent =
    `Move ${count(plan.movingTabCount, 'tab')} from ${count(plan.sourceWindowCount, 'window')} ` +
    `into ${where} — ${count(plan.targetTabCount, 'tab')} already there.`;

  mergeButton.disabled = false;
  mergeButton.focus();
  mergeButton.addEventListener('click', () => {
    // Fire and forget, then close immediately. Awaiting would keep the popup
    // alive during the merge, and the popup dies with its window if that window
    // turns out to be a source.
    chrome.runtime.sendMessage({ type: 'merge', targetWindowId: plan.targetWindowId });
    window.close();
  });
}

cancelButton.addEventListener('click', () => window.close());

chrome.runtime
  .sendMessage({ type: 'plan' })
  .then((plan) => {
    if (!plan) throw new Error('no response from the extension service worker');
    if (plan.error) throw new Error(plan.error);
    render(plan);
  })
  .catch((err) => {
    summary.textContent = `Could not read your windows: ${err.message}`;
  });
