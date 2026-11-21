/* global document, window, navigator, fetch, AbortSignal, setTimeout, clearTimeout, setInterval, URLSearchParams */
import { updateEligibility, updatePaperEntries } from '/notification-state.js';

const preferenceKey = 'solemn.eligibility.preferences.v1';
const entryHistoryKey = 'solemn.paper-entry.history.v1';
let entryMemory = null;
let entrySnapshot;
let entriesConnected = false;
let entryRenderKey = '';
const historyKey = 'solemn.eligibility.history.v1';
let memory = {};
let preferences = { enabled: true, paperEntries: true, desktop: false };
let snapshot;
let connected = false;
let storageAvailable = true;
let renderKey = '';
let timer;
let stopped = false;
const element = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};
function readStorage(key, fallback) {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    storageAvailable = false;
    return fallback;
  }
}
function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    storageAvailable = false;
  }
}
function readPreferences() {
  const saved = readStorage(preferenceKey, {});
  preferences = {
    enabled: saved.enabled !== false,
    desktop: saved.desktop === true,
    paperEntries: saved.paperEntries !== false,
  };
}
readPreferences();
const utc = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  hourCycle: 'h23',
});
const clock = (value) => utc.format(new Date(value)) + ' UTC';
const tokenName = (token) =>
  token.symbol ||
  token.name ||
  token.mint.slice(0, 8) + '…' + token.mint.slice(-6);
const lifecycleLink = (mint) =>
  '/lifecycle?' + new URLSearchParams({ mint, context: 'discovery' });
const button = element('button', 'eligible-alert-button');
button.type = 'button';
button.setAttribute('aria-haspopup', 'dialog');
button.setAttribute('aria-controls', 'eligible-alert-dialog');
button.setAttribute('aria-expanded', 'false');
button.append(element('span', '', 'Alerts'));
const badge = element('span', 'eligible-alert-badge', '…');
button.append(badge);
document.querySelector('.top-status').prepend(button);
const dialog = element('dialog', 'eligible-alert-dialog');
dialog.id = 'eligible-alert-dialog';
dialog.setAttribute('aria-labelledby', 'eligible-alert-title');
const header = element('div', 'eligible-alert-heading');
const title = element('h2', '', 'Trading alerts');
title.id = 'eligible-alert-title';
const close = element('button', 'eligible-close', 'Close');
close.type = 'button';
header.append(title, close);
const note = element(
  'p',
  'eligible-alert-note',
  'Follow live risk eligibility and saved BUY-candidate decisions for paper accounts. Entry decisions and completed buys have separate statuses.',
);
const settings = element('div', 'eligible-alert-settings');
const enabledLabel = element('label', 'eligible-toggle');
const enabled = element('input');
enabled.type = 'checkbox';
enabled.checked = preferences.enabled;
enabledLabel.append(
  enabled,
  element('span', '', 'Notify about newly eligible tokens'),
);
const entryEnabledLabel = element('label', 'eligible-toggle');
const entryEnabled = element('input');
entryEnabled.type = 'checkbox';
entryEnabled.checked = preferences.paperEntries;
entryEnabledLabel.append(
  entryEnabled,
  element('span', '', 'Notify about paper entry decisions'),
);
const desktop = element('button', 'eligible-action');
desktop.type = 'button';
const desktopNote = element('p', 'eligible-alert-note');
const test = element('button', 'eligible-action', 'Test notification');
test.type = 'button';
const entryTest = element(
  'button',
  'eligible-action',
  'Test paper entry alert',
);
entryTest.type = 'button';
settings.append(
  entryEnabledLabel,
  enabledLabel,
  desktop,
  desktopNote,
  entryTest,
  test,
);
const status = element(
  'p',
  'eligible-alert-status',
  'Connecting to eligibility checks…',
);
status.setAttribute('role', 'status');
const list = element('ul', 'eligible-alert-list');
list.setAttribute('aria-label', 'Currently eligible live tokens');
const empty = element(
  'p',
  'eligible-alert-empty',
  'Checking saved risk assessments…',
);
const entryHeading = element(
  'h3',
  'eligible-section-title',
  'Paper entry decisions',
);
const entryStatus = element(
  'p',
  'eligible-alert-note',
  'Connecting to saved entry decisions…',
);
entryStatus.setAttribute('role', 'status');
const entryList = element('ul', 'eligible-alert-list');
entryList.setAttribute('aria-label', 'Recent paper entry decisions');
const entryEmpty = element('p', 'eligible-alert-empty');
const riskHeading = element(
  'h3',
  'eligible-section-title',
  'Eligible live tokens',
);
const setup = element('p', 'eligible-alert-note');
const footer = element(
  'p',
  'eligible-alert-note',
  'Checks about every 5 seconds while a dashboard page is open. Keep the dashboard server and relevant worker running. Paper replay and backtest entry alerts work independently of live risk eligibility. Browser background throttling can delay alerts.',
);
dialog.append(
  header,
  note,
  settings,
  entryHeading,
  entryStatus,
  entryList,
  entryEmpty,
  riskHeading,
  status,
  list,
  empty,
  setup,
  footer,
);
document.body.append(dialog);
const toastRegion = element('div', 'eligible-toast-region');
toastRegion.setAttribute('aria-live', 'polite');
toastRegion.setAttribute('aria-atomic', 'true');
document.body.append(toastRegion);
function openAlerts() {
  dialog.append(toastRegion);
  dialog.showModal();
  button.setAttribute('aria-expanded', 'true');
}
button.addEventListener('click', openAlerts);
close.addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  document.body.append(toastRegion);
  button.setAttribute('aria-expanded', 'false');
  button.focus();
});
function renderSettings() {
  enabled.checked = preferences.enabled;
  entryEnabled.checked = preferences.paperEntries;
  desktop.disabled =
    (!preferences.enabled && !preferences.paperEntries) ||
    !('Notification' in window);
  if (!('Notification' in window)) {
    desktop.textContent = 'Desktop alerts unavailable';
    desktopNote.textContent =
      'This browser does not support desktop notifications. In-app alerts remain available.';
  } else if (window.Notification.permission === 'denied') {
    desktop.textContent = 'Desktop alerts blocked';
    desktop.disabled = true;
    desktopNote.textContent =
      'Allow notifications in your browser’s settings for this site to use desktop alerts.';
  } else {
    desktop.textContent =
      preferences.desktop && window.Notification.permission === 'granted'
        ? 'Disable desktop alerts'
        : 'Enable desktop alerts';
    desktopNote.textContent =
      preferences.desktop && window.Notification.permission === 'granted'
        ? 'Desktop alerts are enabled in this browser. Delivery also depends on browser and operating system settings.'
        : 'Optional desktop alerts need your browser’s permission. In-app alerts work without it.';
  }
  if (!storageAvailable)
    desktopNote.textContent +=
      ' Browser storage is unavailable; alerts may repeat after a refresh.';
}
function showNotice({ heading, detail, linkText, href, tag, desktopTitle }) {
  const box = element('section', 'eligible-toast');
  const link = element(href ? 'a' : 'button', 'eligible-toast-link', linkText);
  if (href) link.href = href;
  else {
    link.type = 'button';
    link.addEventListener('click', () => {
      if (!dialog.open) openAlerts();
    });
  }
  const dismiss = element('button', 'eligible-toast-dismiss', 'Dismiss');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => box.remove());
  box.append(
    element('strong', '', heading),
    element('p', '', detail),
    link,
    dismiss,
  );
  toastRegion.append(box);
  while (toastRegion.children.length > 3)
    toastRegion.firstElementChild.remove();
  setTimeout(() => box.remove(), 15000);
  if (
    preferences.desktop &&
    'Notification' in window &&
    window.Notification.permission === 'granted'
  ) {
    try {
      const notification = new window.Notification(desktopTitle, {
        body: detail,
        tag,
      });
      notification.onclick = () => {
        window.focus();
        if (href) window.location.assign(href);
        else if (!dialog.open) openAlerts();
        notification.close();
      };
    } catch {
      desktopNote.textContent =
        'The browser could not show a desktop notification. In-app alerts remain active.';
    }
  }
}
function showToast(tokens, isTest = false) {
  showNotice({
    heading: isTest
      ? 'Test notification'
      : tokens.length === 1
        ? 'Token became eligible'
        : tokens.length + ' tokens became eligible',
    detail: isTest
      ? 'This is a sample alert. No token eligibility has changed.'
      : tokens.slice(0, 3).map(tokenName).join(', ') +
        (tokens.length > 3 ? ' and ' + (tokens.length - 3) + ' more' : ''),
    linkText:
      !isTest && tokens.length === 1
        ? 'View token lifecycle'
        : 'View eligible tokens',
    href: !isTest && tokens.length === 1 ? lifecycleLink(tokens[0].mint) : null,
    tag: isTest ? 'solemn-test' : 'solemn-eligible-' + tokens[0].mint,
    desktopTitle: isTest
      ? 'Solemn · Test notification'
      : 'Solemn · Token eligible',
  });
}
const entryStatuses = {
  AWAITING_MARKET_DATA: 'Waiting for a fresh trade',
  FILLED: 'Paper buy filled',
  QUEUED: 'Paper entry queued',
  CANDIDATE_ONLY: 'BUY candidate recorded',
  REJECTED: 'Entry rejected',
  FAILED: 'Entry attempt failed',
  EXPIRED: 'Entry expired',
  CANCELLED: 'Entry cancelled',
  UNFILLED: 'Entry unfilled',
  SUPERSEDED: 'Entry superseded',
  SETTLED: 'Intent settled',
  EXECUTION_UNCERTAIN: 'Fill unconfirmed',
};
const entryState = (entry) =>
  entryStatuses[entry.status] ?? 'Saved status · ' + entry.status;
function entryMode(entry) {
  if (entry.sourceKind === 'LIVE_PAPER_SPOT')
    return 'Live paper simulation · Free data';
  if (entry.sourceKind === 'LIVE_PAPER')
    return 'Live paper decisions · Free data';
  if (entry.sourceKind === 'HISTORICAL') return 'Historical backtest';
  if (entry.sourceKind === 'SYNTHETIC') return 'Synthetic backtest';
  return (
    {
      FIXTURE: 'Fixture paper replay',
      FORWARD_REPLAY: 'Synthetic forward replay',
      FORWARD_LIVE: 'Live paper account',
    }[entry.dataMode] ?? entry.dataMode
  );
}
const entryLink = (entry) =>
  entry.hasMetadata
    ? '/lifecycle?' +
      new URLSearchParams({
        mint: entry.mint,
        context: 'portfolio:' + entry.portfolioId,
      })
    : null;
function showEntryToast(entries, isTest = false) {
  const first = entries[0];
  showNotice({
    heading: isTest
      ? 'Test paper entry alert'
      : entries.length === 1
        ? 'Paper entry decided'
        : entries.length + ' paper entry decisions',
    detail: isTest
      ? 'This is a sample alert. No paper entry has been decided.'
      : entries
          .slice(0, 3)
          .map(
            (entry) =>
              tokenName(entry) +
              ' · ' +
              entry.accountName +
              ' · ' +
              entryMode(entry) +
              ' · ' +
              entryState(entry),
          )
          .join('\n'),
    linkText:
      !isTest && entries.length === 1 && first.hasMetadata
        ? 'View entry lifecycle'
        : 'View entry decisions',
    href: !isTest && entries.length === 1 ? entryLink(first) : null,
    tag: isTest ? 'solemn-entry-test' : 'solemn-entry-' + first.id,
    desktopTitle: isTest
      ? 'Solemn · Test paper entry alert'
      : 'Solemn · Paper entry decided',
  });
}
const entryDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
const entryUsd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  maximumSignificantDigits: 8,
});
function renderEntries() {
  const entries =
    entriesConnected && entrySnapshot ? entrySnapshot.entries : [];
  const key = JSON.stringify(entries);
  if (key !== entryRenderKey) {
    entryRenderKey = key;
    const focused = document.activeElement?.dataset?.entryId;
    entryList.replaceChildren(
      ...entries.map((entry) => {
        const row = element('li'),
          href = entryLink(entry);
        const title = element(
          href ? 'a' : 'strong',
          'eligible-token-link',
          tokenName(entry),
        );
        if (href) {
          title.href = href;
          title.dataset.entryId = entry.id;
        }
        row.append(
          title,
          element('p', 'entry-alert-state', entryState(entry)),
          element('p', '', entry.accountName + ' · ' + entryMode(entry)),
          element(
            'p',
            '',
            'Decided ' + entryDate.format(new Date(entry.decidedAt)) + ' UTC',
          ),
          element(
            'p',
            '',
            'Recorded ' + entryDate.format(new Date(entry.recordedAt)) + ' UTC',
          ),
        );
        if (entry.candleEnd)
          row.append(
            element(
              'p',
              '',
              'Data window ended ' +
                entryDate.format(new Date(entry.candleEnd)) +
                ' UTC',
            ),
          );
        if (entry.referencePriceUsd !== null)
          row.append(
            element(
              'p',
              '',
              'Reference price ' +
                entryUsd.format(Number(entry.referencePriceUsd)),
            ),
          );
        if (entry.fillPriceUsd !== null)
          row.append(
            element(
              'p',
              '',
              'Fill price ' +
                entryUsd.format(Number(entry.fillPriceUsd)) +
                ' · Quantity ' +
                entry.quantity +
                ' · Fees ' +
                entryUsd.format(Number(entry.feesUsd)),
            ),
          );
        const details = element('details', 'entry-alert-details');
        details.append(
          element('summary', '', 'Decision details'),
          element('p', '', entry.explanation),
        );
        if (entry.reasons.length)
          details.append(element('p', '', entry.reasons.join(', ')));
        details.append(
          element('p', 'eligible-token-mint', 'Mint · ' + entry.mint),
          element('p', 'eligible-token-mint', 'Decision · ' + entry.decisionId),
          element('p', 'eligible-token-mint', 'Account · ' + entry.portfolioId),
        );
        row.append(details);
        if (!href)
          row.append(
            element('p', '', 'Lifecycle metadata has not been saved yet.'),
          );
        return row;
      }),
    );
    if (focused)
      for (const link of entryList.querySelectorAll('a'))
        if (link.dataset.entryId === focused) link.focus();
  }
  entryEmpty.hidden = entries.length > 0;
  entryEmpty.textContent = entriesConnected
    ? 'No paper entry decisions recorded in the last 24 hours. Run a paper replay, backtest, or a worker configured for paper entries.'
    : 'Entry decisions are unavailable until the database connection recovers.';
  if (entriesConnected)
    entryStatus.textContent =
      (entrySnapshot.truncated
        ? 'Showing the latest 100 of ' +
          entrySnapshot.total +
          ' decisions. Alerts cover this displayed set. '
        : '') +
      'Last 24 hours by recording time · ' +
      (preferences.paperEntries ? 'Entry alerts on' : 'Entry alerts paused') +
      ' · Checked ' +
      clock(entrySnapshot.checkedAt);
}

function renderSnapshot() {
  const current =
    connected && snapshot
      ? snapshot.tokens.filter(
          (token) => Date.parse(token.validUntil) > Date.now(),
        )
      : [];
  renderEntries();
  const entries = entriesConnected ? entrySnapshot.entries.length : 0;
  badge.textContent =
    connected || entriesConnected
      ? String(current.length + entries) +
        (snapshot?.truncated || entrySnapshot?.truncated ? '+' : '')
      : '—';
  button.setAttribute(
    'aria-label',
    'Trading alerts, ' +
      current.length +
      ' eligible tokens and ' +
      entries +
      ' recent paper entry decisions',
  );
  const key = JSON.stringify(current);
  if (key !== renderKey) {
    renderKey = key;
    const focusedMint = document.activeElement?.dataset?.alertMint;
    list.replaceChildren(
      ...current.map((token) => {
        const row = element('li');
        const link = element('a', 'eligible-token-link', tokenName(token));
        link.href = lifecycleLink(token.mint);
        link.dataset.alertMint = token.mint;
        const mint = element('p', 'eligible-token-mint', token.mint);
        const source = element(
          'p',
          '',
          'Live · ' + token.source + ' · Assessed ' + clock(token.assessedAt),
        );
        const expiry = element(
          'p',
          '',
          'Valid until ' + clock(token.validUntil),
        );
        row.append(link, mint, source, expiry);
        return row;
      }),
    );
    if (focusedMint)
      for (const link of list.querySelectorAll('a'))
        if (link.dataset.alertMint === focusedMint) link.focus();
  }
  empty.hidden = current.length > 0;
  empty.textContent = !connected
    ? 'Eligibility is unavailable until the database connection recovers.'
    : 'No live tokens currently pass the configured risk policy with a valid assessment.';
  if (connected && snapshot) {
    status.textContent =
      (snapshot.truncated
        ? 'Showing up to 200 of ' +
          snapshot.total +
          ' eligible tokens. Alerts cover this displayed set. '
        : '') +
      'Last checked ' +
      clock(snapshot.checkedAt) +
      (preferences.enabled ? ' · Alerts on' : ' · Alerts paused');
    setup.textContent = snapshot.riskAnalysisConfigured
      ? 'Automatic risk analysis is enabled in the configured worker. This does not indicate whether that worker is running.'
      : 'Automatic risk analysis is disabled in the configured worker. Saved assessments are still monitored. Enable TOKEN_RISK_ANALYSIS_ENABLED in .env and start Configured worker to produce new checks, or run risk:assess for a token.';
  }
}
async function processSnapshots(eligibility, paper) {
  const update = () => {
    readPreferences();
    if (eligibility) {
      const saved = readStorage(historyKey, memory);
      const result = updateEligibility(
        saved && typeof saved === 'object' && !Array.isArray(saved)
          ? saved
          : {},
        eligibility,
      );
      memory = result.state;
      writeStorage(historyKey, memory);
      const arrivals = result.arrivals.filter(
        (token) => Date.parse(token.validUntil) > Date.now(),
      );
      if (preferences.enabled && arrivals.length) showToast(arrivals);
    }
    if (paper) {
      const saved = readStorage(entryHistoryKey, entryMemory);
      const result = updatePaperEntries(
        saved &&
          typeof saved === 'object' &&
          !Array.isArray(saved) &&
          saved.seen &&
          typeof saved.seen === 'object'
          ? saved
          : null,
        paper,
      );
      entryMemory = result.state;
      writeStorage(entryHistoryKey, entryMemory);
      if (preferences.paperEntries && result.arrivals.length)
        showEntryToast(result.arrivals);
    }
    renderSettings();
  };
  if (navigator.locks?.request)
    await navigator.locks.request('solemn-eligibility-alerts', update);
  else update();
}
async function readAlerts(path) {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(15000),
    cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok) throw new Error();
  return value;
}
async function poll() {
  try {
    const [risk, paper] = await Promise.allSettled([
      readAlerts('/api/notifications/eligible'),
      readAlerts('/api/notifications/entries'),
    ]);
    if (stopped) return;
    connected = risk.status === 'fulfilled';
    entriesConnected = paper.status === 'fulfilled';
    if (connected) snapshot = risk.value;
    else
      status.textContent =
        'Could not refresh eligibility. Check the database connection; monitoring will retry automatically.';
    if (entriesConnected) entrySnapshot = paper.value;
    else
      entryStatus.textContent =
        'Could not refresh paper entry decisions. Monitoring will retry automatically.';
    await processSnapshots(
      connected ? snapshot : null,
      entriesConnected ? entrySnapshot : null,
    );
    renderSnapshot();
  } catch {
    connected = false;
    entriesConnected = false;
    status.textContent =
      'Could not refresh alerts. Monitoring will retry automatically.';
    entryStatus.textContent = status.textContent;
    renderSnapshot();
  } finally {
    if (!stopped) timer = setTimeout(poll, 5000);
  }
}
entryEnabled.addEventListener('change', () => {
  preferences.paperEntries = entryEnabled.checked;
  writeStorage(preferenceKey, preferences);
  renderSettings();
  renderSnapshot();
});
entryTest.addEventListener('click', () => showEntryToast([], true));
enabled.addEventListener('change', () => {
  preferences.enabled = enabled.checked;
  writeStorage(preferenceKey, preferences);
  renderSettings();
  renderSnapshot();
});
desktop.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  if (preferences.desktop) {
    preferences.desktop = false;
    writeStorage(preferenceKey, preferences);
    renderSettings();
    return;
  }
  try {
    const permission = await window.Notification.requestPermission();
    preferences.desktop = permission === 'granted';
    writeStorage(preferenceKey, preferences);
    renderSettings();
  } catch {
    desktopNote.textContent =
      'Your browser could not request notification permission. In-app alerts remain active.';
  }
});
test.addEventListener('click', () => showToast([], true));
window.addEventListener('storage', (event) => {
  if (event.key === preferenceKey) {
    readPreferences();
    renderSettings();
    renderSnapshot();
  }
});
window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(timer);
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    stopped = false;
    void poll();
  }
});
setInterval(renderSnapshot, 1000);
renderSettings();
void poll();
