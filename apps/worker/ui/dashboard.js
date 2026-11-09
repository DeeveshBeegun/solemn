/* global document, fetch, URLSearchParams, AbortSignal, setTimeout, clearTimeout */
const modes = {
  replay: {
    icon: 'replay',
    kicker: 'Simulation',
    title: 'Forward paper replay',
    description:
      'Run the forward strategy against a bundled market replay. Orders, fills, and balances are simulated.',
    button: 'Launch replay',
    note: 'Synthetic market data',
  },
  discovery: {
    icon: 'radar',
    kicker: 'Market collection',
    title: 'Read-only discovery',
    description:
      'Connect to PumpPortal for live token launches and migrations. Solemn records observations and blocks orders in this mode.',
    button: 'Start discovery',
    note: 'Live public feed',
  },
  backtest: {
    icon: 'chart',
    kicker: 'Research',
    title: 'Fixture backtest',
    description:
      'Replay a synthetic dataset through the strategy and paper ledger. Compare simulated fills, returns, and drawdown in the generated report.',
    button: 'Run backtest',
    note: 'Isolated paper portfolio',
  },
  stress: {
    icon: 'flask',
    kicker: 'Research',
    title: 'Execution stress test',
    description:
      'Test how execution conditions such as delays, fees, and outages affect simulated outcomes on a bundled fixture.',
    button: 'Run stress test',
    note: 'Repeatable simulation',
  },
  worker: {
    icon: 'layers',
    kicker: 'Worker services',
    title: 'Configured worker',
    description:
      'Start the main worker with the standalone services selected in your .env file. It can scan, assess token risk, generate signals, or run fixture paper trading when enabled.',
    button: 'Start worker',
    note: 'Reads local configuration',
  },
  database: {
    icon: 'db',
    kicker: 'Workspace setup',
    title: 'Database setup',
    description:
      'Start the local PostgreSQL service with Docker Compose and apply Solemn’s database migrations. Open Docker Desktop and make sure .env exists first.',
    button: 'Set up database',
    note: 'Preserves existing database records',
  },
};
const get = (id) => document.getElementById(id);
const set = (id, value) => {
  const el = get(id);
  if (el.textContent !== value) el.textContent = value;
};
const navItems = [...document.querySelectorAll('[data-mode]')];
const fields = [...document.querySelectorAll('[data-fields]')];
const localTime = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const shortDate = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});
const humanize = (value) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
const time = (value) => localTime.format(new Date(value));

let mode = 'replay';
let view = 'logs';
let token;
let job;
let account;
let database;
let pending = false;
let processVersion = 0;
let loaded = false;
let accountRequest = 0;
let accountTimer;
let accountKey;
let activityKey;

function busy() {
  return ['running', 'stopping'].includes(job?.status);
}

function stateBadge(id, label, tone) {
  const badge = get(id);
  badge.dataset.tone = tone;
  const text = badge.querySelector('span');
  if (text.textContent !== label) text.textContent = label;
}

function error(message) {
  set('form-error', message);
  get('form-error').hidden = !message;
}

function selectMode(next) {
  mode = next;
  const selected = modes[mode];
  navItems.forEach((item) =>
    item.setAttribute('aria-current', String(item.dataset.mode === mode)),
  );
  fields.forEach((group) => {
    group.hidden = group.dataset.fields !== mode;
    for (const control of group.querySelectorAll('input, select'))
      control.disabled = group.hidden;
  });
  get('mode-icon').setAttribute('href', '#' + selected.icon);
  set('mode-kicker', selected.kicker);
  set('mode-title', selected.title);
  set('mode-description', selected.description);
  set('mode-note', selected.note);
  get('launch-button').querySelector('span').textContent = selected.button;
  error('');
  void refreshAccount();
}

function renderProcess() {
  const status = job?.status;
  const tone = {
    running: 'good',
    stopping: 'warning',
    completed: 'good',
    failed: 'error',
  };
  stateBadge(
    'process-state',
    status ? humanize(status) : 'Idle',
    tone[status] ?? 'muted',
  );
  set('run-name', job?.label ?? 'No process started');
  set(
    'run-time',
    job
      ? 'Started ' +
          time(job.startedAt) +
          (job.finishedAt ? ' · Ended ' + time(job.finishedAt) : '')
      : 'Choose a mode to begin',
  );
  get('stop-button').disabled = !token || pending || status !== 'running';
  get('launch-button').disabled = !token || pending || busy();
  set(
    'update-note',
    token
      ? 'Updates automatically · local connection'
      : 'Connecting to local launcher',
  );
  renderActivity();
}

function accountSelection() {
  if (mode === 'discovery') return { mode, account: 'live' };
  if (mode === 'replay') return { mode, account: get('account').value.trim() };
  return (
    job?.forward ?? { mode: 'replay', account: get('account').value.trim() }
  );
}

function renderAccount(selection) {
  const initialized = account && account.status !== 'NOT_INITIALIZED';
  set('account-label', selection.account || 'Replay account');
  const label = selection.mode === 'discovery' ? 'Discovery' : 'Replay';
  let summary = 'Looking up account…';
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(selection.account))
    summary = 'Enter a valid account name to see its status.';
  else if (database === 'unavailable')
    summary =
      'Account data is unavailable. Run Database setup or check DATABASE_URL in .env.';
  else if (account)
    summary =
      label +
      ' · ' +
      (initialized
        ? humanize(account.status) +
          (account.workerHeartbeatFresh
            ? ' · Worker online'
            : ' · No fresh worker heartbeat')
        : 'This account has no saved session yet');
  set('account-summary', summary);
  set(
    'equity',
    account?.markedEquityUsd == null
      ? '—'
      : usd.format(Number(account.markedEquityUsd)),
  );
  set('tracked', String(account?.trackedTokens ?? '—'));
  set('positions', String(account?.openPositions ?? '—'));
  set('fills', String(account?.fills ?? '—'));
  set(
    'account-feed',
    account?.feedHealth ? 'Feed · ' + humanize(account.feedHealth) : 'Feed —',
  );
  set(
    'account-detail',
    account?.valuationQuality === 'UNCERTAIN'
      ? 'Valuation uncertain'
      : account?.cursor != null
        ? 'Replay cursor ' + account.cursor
        : account?.lastObservationAt
          ? 'Last observed ' +
            shortDate.format(new Date(account.lastObservationAt))
          : 'No observation shown',
  );
  renderActivity();
}

function renderActivity() {
  const events = view === 'events';
  get('events-tab').setAttribute('aria-pressed', String(events));
  get('logs-tab').setAttribute('aria-pressed', String(!events));
  const items = events
    ? (account?.events ?? [])
    : [...(job?.logs ?? [])].reverse();
  const key = JSON.stringify([view, items]);
  if (activityKey === key) return;
  activityKey = key;
  const empty = get('activity-empty');
  const entries = get('entries');
  empty.hidden = items.length > 0;
  entries.hidden = !empty.hidden;
  empty.querySelector('strong').textContent = events
    ? 'No account events to show'
    : 'Waiting for a process';
  empty.querySelector('p').textContent = events
    ? 'Recorded events appear here for the forward account shown on the panel.'
    : 'Startup, progress, and shutdown messages appear here after launch.';
  entries.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      const stamp = document.createElement('time');
      stamp.dateTime = item.at;
      stamp.textContent = time(item.at);
      stamp.title = shortDate.format(new Date(item.at));
      const message = document.createElement('span');
      message.dataset.tone = item.level === 'info' ? '' : (item.level ?? '');
      message.textContent = events ? humanize(item.kind) : item.message;
      li.append(stamp, message);
      const facts = Object.entries(item.facts ?? {});
      if (facts.length) {
        const detail = document.createElement('span');
        detail.className = 'entry-facts';
        detail.textContent = facts
          .map(
            ([key, value]) =>
              key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() +
              ' ' +
              value,
          )
          .join(' · ');
        li.append(detail);
      }
      return li;
    }),
  );
}

async function api(path, options) {
  const res = await fetch(path, {
    signal: AbortSignal.timeout(25_000),
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

async function refreshAccount() {
  clearTimeout(accountTimer);
  const request = ++accountRequest;
  const selection = accountSelection();
  const key = selection.mode + ':' + selection.account;
  if (key !== accountKey) {
    accountKey = key;
    account = undefined;
  }
  renderAccount(selection);
  if (/^[a-zA-Z0-9_-]{1,50}$/.test(selection.account)) {
    try {
      const params = new URLSearchParams(selection);
      const result = await api('/api/account?' + params);
      if (request !== accountRequest) return;
      database = result.database;
      account = result.account;
      stateBadge(
        'database-status',
        database === 'ready' ? 'Database ready' : 'Database unavailable',
        database === 'ready' ? 'good' : 'warning',
      );
    } catch {
      if (request !== accountRequest) return;
      account = undefined;
      database = 'unavailable';
      stateBadge('database-status', 'Database unavailable', 'warning');
    }
    renderAccount(selection);
  }
  accountTimer = setTimeout(refreshAccount, 4500);
}

async function refreshProcess() {
  if (!pending) {
    const version = processVersion;
    try {
      const data = await api('/api/state');
      if (version === processVersion) {
        if (!loaded && get('account').value === 'week8')
          get('account').value =
            data.job?.forward?.mode === 'replay'
              ? data.job.forward.account
              : data.defaultAccount;
        loaded = true;
        token = data.token;
        job = data.job;
        if (accountTimer === undefined) void refreshAccount();
      }
    } catch {
      if (version === processVersion) token = undefined;
    }
    renderProcess();
    if (!token) set('update-note', 'Launcher unavailable · retrying');
  }
  setTimeout(refreshProcess, 1000);
}

async function act(path, payload) {
  processVersion++;
  pending = true;
  error('');
  renderProcess();
  try {
    const result = await api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Solemn-Token': token },
      body: JSON.stringify(payload),
    });
    job = result.job;
    view = 'logs';
    void refreshAccount();
  } catch (cause) {
    error(cause.message);
  } finally {
    pending = false;
    renderProcess();
  }
}

navItems.forEach((item) =>
  item.addEventListener('click', () => selectMode(item.dataset.mode)),
);
get('account').addEventListener('input', () => {
  clearTimeout(accountTimer);
  accountRequest++;
  accountTimer = setTimeout(refreshAccount, 350);
});
get('logs-tab').addEventListener('click', () => {
  view = 'logs';
  renderActivity();
});
get('events-tab').addEventListener('click', () => {
  view = 'events';
  renderActivity();
});
get('stop-button').addEventListener('click', () => {
  if (token && !pending && job?.status === 'running') void act('/api/stop', {});
});
get('launch-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!token || pending || busy()) return;
  const duration = get('duration').value;
  void act('/api/launch', {
    mode,
    account: get('account').value.trim(),
    duration: duration === 'continuous' ? duration : Number(duration),
    dataset: get('dataset').value,
    scenario: get('scenario').value,
    seed: get('seed').valueAsNumber,
  });
});
void refreshProcess();
