/* global document, window, fetch, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout */
const get = (id) => document.getElementById(id);
const label = (value) =>
  String(value)
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
const utc = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});
const stages = {
  discovery: 'Discovery',
  risk: 'Risk',
  strategy: 'Strategy',
  execution: 'Paper execution',
  position: 'Positions',
};
const modes = {
  FORWARD_REPLAY: 'Synthetic forward replay',
  FIXTURE: 'Fixture paper replay',
  FORWARD_LIVE: 'Live read-only collection',
  LIVE_NOT_READY: 'Live strategy evidence',
};
function modeName(context) {
  if (context.sourceKind === 'HISTORICAL') return 'Historical backtest';
  if (context.sourceKind === 'SYNTHETIC') return 'Synthetic backtest';
  return modes[context.dataMode] ?? context.dataMode;
}
const initial = new URLSearchParams(window.location.search);
let mint = initial.get('mint') ?? '';
let context = initial.get('context') ?? '';
let stage = initial.get('stage') ?? '';
let nextEvent = null;
let nextToken = null;
let displayedEvents = [];
let foundTokens = [];
let journeyRequest;
let searchRequest;
let searchTimer;
let searchValue = '';
let loadedView;

const text = (id, value) => {
  get(id).textContent = value;
};
function error(message) {
  text('lifecycle-error', message);
  get('lifecycle-error').hidden = !message;
}
async function read(path, params, signal) {
  const res = await fetch(path + '?' + new URLSearchParams(params), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error ?? 'Could not load saved records.');
  return value;
}
function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function countLabel(value, noun) {
  return value + ' ' + noun + (Number(value) === 1 ? '' : 's');
}
function formatDate(value) {
  return value ? utc.format(new Date(value)) + ' UTC' : 'Not recorded';
}
function money(value) {
  return value == null ? 'Unavailable' : usd.format(Number(value));
}
function busy(value) {
  get('journey').setAttribute('aria-busy', String(value));
  for (const id of [
    'refresh-token',
    'lifecycle-context',
    'history-stage',
    'more-events',
  ])
    get(id).disabled = value;
}
function renderTokens() {
  get('token-list').replaceChildren(
    ...foundTokens.map((token) => {
      const li = element('li');
      const button = element('button', 'token-choice');
      button.type = 'button';
      button.setAttribute('aria-current', String(token.mint === mint));
      button.append(
        element('strong', '', token.symbol || token.name || 'Unnamed token'),
        element(
          'span',
          '',
          token.name && token.symbol ? token.name : token.source,
        ),
        element(
          'span',
          '',
          token.mint.slice(0, 8) + '…' + token.mint.slice(-6),
        ),
      );
      if (token.hasPaperActivity)
        button.append(
          element('span', 'paper-activity-tag', 'Paper activity recorded'),
        );
      button.title = token.mint;
      button.addEventListener('click', () => {
        mint = token.mint;
        context = '';
        stage = '';
        void loadJourney();
        renderTokens();
      });
      li.append(button);
      return li;
    }),
  );
}
async function searchTokens(append = false) {
  searchRequest?.abort();
  const controller = new AbortController();
  searchRequest = controller;
  const search = get('token-search').value.trim();
  const params = { search, traded: String(get('paper-activity').checked) };
  if (append && nextToken) params.after = nextToken;
  get('more-tokens').disabled = true;
  text('search-status', 'Searching saved tokens…');
  try {
    const result = await read(
      '/api/lifecycle/tokens',
      params,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    searchValue = search;
    foundTokens = append ? [...foundTokens, ...result.tokens] : result.tokens;
    nextToken = result.next;
    renderTokens();
    text(
      'search-status',
      foundTokens.length
        ? countLabel(foundTokens.length, 'token') +
            ' shown' +
            (nextToken ? ' · More available' : '')
        : 'No saved tokens match this search.',
    );
    get('more-tokens').hidden = !nextToken;
  } catch (cause) {
    if (controller.signal.aborted) return;
    text('search-status', cause.message);
    get('more-tokens').hidden = true;
  } finally {
    if (!controller.signal.aborted) get('more-tokens').disabled = false;
  }
}

function renderStages(data) {
  get('stage-cards').replaceChildren(
    ...Object.entries(stages).map(([key, name]) => {
      const saved = data.stages.find((item) => item.stage === key);
      const button = element('button', 'stage-card');
      button.type = 'button';
      button.setAttribute(
        'aria-label',
        'Show ' + name.toLowerCase() + ' events',
      );
      button.setAttribute('aria-pressed', String(stage === key));
      const latest =
        key === 'risk' && saved?.details.status
          ? saved.details.status
          : saved?.title;
      button.append(
        element('span', 'stage-label', name),
        element('strong', '', latest ? label(latest) : 'No saved step'),
        element('small', '', countLabel(saved?.count ?? '0', 'event')),
      );
      button.addEventListener('click', () => {
        stage = stage === key ? '' : key;
        void loadJourney();
      });
      return button;
    }),
  );
}

function renderOutcome(data) {
  const positions = data.positions;
  let title = 'No paper position recorded';
  let detail =
    'The saved evidence has not reached a paper position in this context.';
  if (Number(positions.blocked) > 0) {
    title = 'Paper exit blocked';
    detail =
      countLabel(positions.blocked, 'position') +
      ' with a recorded blocked exit.';
  } else if (Number(positions.open) > 0) {
    title = 'Paper position open';
    detail =
      countLabel(positions.open, 'position') +
      ' currently open in this account.';
  } else if (Number(positions.total) > 0) {
    title = 'Paper positions closed';
    detail =
      countLabel(positions.total, 'position') + ' closed in this account.';
  } else if (data.context.key === 'discovery') {
    title = 'Discovery history recorded';
    detail =
      'Select an account or strategy run, when available, to follow decisions and paper execution.';
  } else {
    const risk = data.stages.find((item) => item.stage === 'risk');
    if (risk?.details.status === 'REJECTED') {
      title = 'Risk rejection recorded';
      detail = 'The latest saved risk evidence in this context is rejected.';
    }
  }
  text('outcome-title', title);
  text('outcome-detail', detail);
  text('realized-pnl', money(positions.realizedPnlUsd));
}

function renderHeader(data) {
  const token = data.token;
  text(
    'token-title',
    token.name
      ? token.name + (token.symbol ? ' · ' + token.symbol : '')
      : token.symbol || 'Unnamed token',
  );
  text('token-mint', token.mint);
  get('token-meta').replaceChildren(
    element('span', '', 'Metadata source · ' + token.source),
    element(
      'span',
      '',
      'Metadata discovered · ' + formatDate(token.discoveredAt),
    ),
    element('span', '', 'Latest token risk · ' + label(token.risk)),
    element('span', '', 'Migration · ' + label(token.migrationStatus)),
  );
  if (token.createdAt)
    get('token-meta').append(
      element('span', '', 'Creation time · ' + formatDate(token.createdAt)),
    );
  if (token.migratedAt)
    get('token-meta').append(
      element('span', '', 'Migration time · ' + formatDate(token.migratedAt)),
    );
  get('lifecycle-context').replaceChildren(
    ...data.contexts.map((item) => {
      const option = element('option', '', item.name + ' · ' + modeName(item));
      option.value = item.key;
      return option;
    }),
  );
  get('lifecycle-context').value = data.context.key;
  text('context-mode', modeName(data.context));
  const scope = data.context.portfolioId
    ? 'Account ' + data.context.portfolioId
    : data.context.runId
      ? 'Strategy run ' + data.context.runId
      : 'Discovery and risk records for this mint';
  text(
    'context-note',
    scope +
      ' · ' +
      label(data.context.status) +
      (data.contextsTruncated
        ? ' · Showing the latest 200 contexts; account links can open older contexts.'
        : ''),
  );
  get('history-stage').value = stage;
}

function renderEvent(event) {
  const li = element('li', 'history-event');
  const time = element('time', '', formatDate(event.at));
  time.dateTime = event.at;
  const body = element('div');
  body.append(
    element('span', 'event-stage', stages[event.stage]),
    element('h3', '', label(event.title)),
  );
  if (
    typeof event.details.explanation === 'string' &&
    event.details.explanation
  )
    body.append(element('p', 'event-reasons', event.details.explanation));
  if (Array.isArray(event.details.reasons) && event.details.reasons.length)
    body.append(
      element(
        'p',
        'event-reasons',
        event.details.reasons.map(label).join(' · '),
      ),
    );
  const facts = Object.entries(event.details).filter(
    ([, value]) => value !== null && value !== '' && value !== undefined,
  );
  if (facts.length) {
    const details = element('details', 'event-details');
    const summary = element('summary', '', 'View recorded evidence');
    const list = element('dl');
    for (const [key, value] of facts) {
      const name = key.replace(/([a-z])([A-Z])/g, '$1 $2');
      const formatted =
        typeof value === 'object'
          ? JSON.stringify(value, null, 2)
          : String(value);
      list.append(element('dt', '', label(name)), element('dd', '', formatted));
    }
    details.append(summary, list);
    body.append(details);
  }
  li.append(time, body);
  return li;
}
function renderPositions(data) {
  get('position-panel').hidden = !data.positionRows.length;
  get('position-list').replaceChildren(
    ...data.positionRows.map((position) => {
      const item = element('div', 'position-item');
      item.append(
        element('strong', '', label(position.paperState ?? position.status)),
        element('p', '', 'Position ' + position.id),
        element('p', '', 'Opened ' + formatDate(position.openedAt)),
        element(
          'p',
          '',
          position.closedAt
            ? 'Closed ' + formatDate(position.closedAt)
            : 'Remaining quantity ' + position.quantity,
        ),
        element(
          'p',
          '',
          'Realized paper P&L ' + money(position.realizedPnlUsd),
        ),
      );
      if (position.blockedReason || position.pendingExitReason)
        item.append(
          element(
            'p',
            '',
            position.blockedReason ?? position.pendingExitReason,
          ),
        );
      return item;
    }),
  );
  if (Number(data.positions.total) > 50)
    get('position-list').append(
      element(
        'p',
        'history-note',
        'Showing the latest 50 positions. The outcome summary includes all recorded positions.',
      ),
    );
}

async function loadJourney(append = false) {
  if (!mint) return;
  journeyRequest?.abort();
  const controller = new AbortController();
  journeyRequest = controller;
  busy(true);
  error('');
  const params = { mint };
  if (context) params.context = context;
  if (stage) params.stage = stage;
  if (append && nextEvent) params.cursor = nextEvent;
  if (!append && (loadedView?.mint !== mint || get('journey').hidden)) {
    get('journey').hidden = true;
    get('welcome').hidden = false;
    get('welcome').querySelector('h2').textContent = 'Loading token history';
    get('welcome').querySelector('p').textContent =
      'Reading the saved lifecycle evidence…';
  }
  if (!append && !get('journey').hidden) {
    text('history-state', 'Updating saved history…');
    get('history-state').hidden = false;
  }
  try {
    const data = await read('/api/lifecycle/token', params, controller.signal);
    if (controller.signal.aborted) return;
    context = data.context.key;
    loadedView = { mint, context, stage };
    displayedEvents = append
      ? [...displayedEvents, ...data.events]
      : data.events;
    nextEvent = data.next;
    renderHeader(data);
    renderStages(data);
    renderOutcome(data);
    renderPositions(data);
    get('history-list').replaceChildren(...displayedEvents.map(renderEvent));
    text(
      'history-state',
      displayedEvents.length
        ? ''
        : 'No saved events for this stage in the selected context.',
    );
    get('history-state').hidden = displayedEvents.length > 0;
    text(
      'history-count',
      countLabel(displayedEvents.length, 'saved event') +
        ' shown · Oldest first',
    );
    get('more-events').hidden = !nextEvent;
    get('journey').hidden = false;
    get('welcome').hidden = true;
    const query = new URLSearchParams({ mint, context });
    if (stage) query.set('stage', stage);
    window.history.replaceState(null, '', '/lifecycle?' + query);
  } catch (cause) {
    if (controller.signal.aborted) return;
    error(cause.message);
    if (loadedView?.mint === mint && !get('journey').hidden) {
      context = loadedView.context;
      stage = loadedView.stage;
      get('lifecycle-context').value = context;
      get('history-stage').value = stage;
      text('history-state', 'Showing the previously loaded history.');
      get('history-state').hidden = false;
    } else if (!append) {
      get('welcome').querySelector('h2').textContent =
        'History could not be loaded';
      get('welcome').querySelector('p').textContent =
        'Select a saved token to try again.';
    }
  } finally {
    if (!controller.signal.aborted) busy(false);
  }
}

get('token-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  void searchTokens();
});
get('token-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchRequest?.abort();
  searchTimer = setTimeout(() => void searchTokens(), 300);
});
get('paper-activity').addEventListener('change', () => {
  clearTimeout(searchTimer);
  void searchTokens();
});
get('more-tokens').addEventListener('click', () => {
  if (searchValue === get('token-search').value.trim()) void searchTokens(true);
  else void searchTokens();
});
get('lifecycle-context').addEventListener('change', () => {
  context = get('lifecycle-context').value;
  stage = '';
  void loadJourney();
});
get('history-stage').addEventListener('change', () => {
  stage = get('history-stage').value;
  void loadJourney();
});
get('refresh-token').addEventListener('click', () => void loadJourney());
get('more-events').addEventListener('click', () => void loadJourney(true));
void searchTokens();
if (mint) void loadJourney();
