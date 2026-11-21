/* global document, window, fetch, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, ResizeObserver */
const get = (id) => document.getElementById(id);
const text = (id, value) => {
  get(id).textContent = value;
};
const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  maximumSignificantDigits: 8,
});
const amounts = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 10,
});
const utc = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
const initial = new URLSearchParams(window.location.search);
let mint = initial.get('mint') ?? '';
let context = initial.get('context') ?? '';
let pool = initial.get('pool') ?? '';
let range = initial.get('range') ?? 'all';
let side = initial.get('side') ?? '';
let nextTrade = null;
let nextToken = null;
let displayedFills = [];
let foundTokens = [];
let tradingRequest;
let searchRequest;
let searchTimer;
let searchValue = '';
let loaded;
function countLabel(value, noun) {
  return value + ' ' + noun + (Number(value) === 1 ? '' : 's');
}
function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function money(value) {
  return value == null ? 'Unavailable' : usd.format(Number(value));
}
function date(value) {
  return value ? utc.format(new Date(value)) + ' UTC' : 'Not recorded';
}
function error(message) {
  text('trading-error', message);
  get('trading-error').hidden = !message;
}
function modeName(ctx) {
  if (ctx.sourceKind === 'HISTORICAL') return 'Historical backtest';
  if (ctx.sourceKind === 'SYNTHETIC') return 'Synthetic backtest';
  return (
    {
      FORWARD_REPLAY: 'Synthetic forward replay',
      FIXTURE: 'Fixture paper replay',
      FORWARD_LIVE: 'Live read-only collection',
      LIVE_NOT_READY: 'Live strategy evidence',
    }[ctx.dataMode] ?? ctx.dataMode
  );
}
async function read(path, params, signal) {
  const response = await fetch(path + '?' + new URLSearchParams(params), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? 'Could not load saved trading data.');
  return data;
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
        pool = '';
        range = 'all';
        side = '';
        void loadTrading();
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

function options(id, values, value) {
  get(id).replaceChildren(
    ...values.map(([key, title]) => {
      const option = element('option', '', title);
      option.value = key;
      return option;
    }),
  );
  get(id).value = value;
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
  options(
    'trading-context',
    data.contexts.map((ctx) => [
      ctx.key,
      ctx.name + ' · ' + modeName(ctx) + ' · ' + ctx.key.slice(-8),
    ]),
    context,
  );
  options(
    'trading-pool',
    data.pools.length
      ? data.pools.map((p) => [
          p.pool,
          p.pool === 'unknown'
            ? 'Unspecified pool'
            : p.pool.slice(0, 6) + '…' + p.pool.slice(-6),
        ])
      : [['', 'No market history']],
    pool,
  );
  get('trading-pool').title = pool;
  get('trading-context').title = data.context.name + ' · ' + data.context.key;
  get('trading-range').value = range;
  get('trade-side').value = side;
  text(
    'context-note',
    modeName(data.context) +
      ' · ' +
      data.context.status +
      ' · ' +
      data.context.key +
      (data.contextsTruncated ? ' · Latest 200 contexts shown.' : '') +
      ' · Realized P&L and positions cover the full context. Other metrics cover the selected time range.',
  );
  get('view-lifecycle').href =
    '/lifecycle?' + new URLSearchParams({ mint, context });
}
function metric(title, value, detail, color = '') {
  const node = element('article', 'trading-metric');
  node.append(
    element('span', '', title),
    element('strong', color, value),
    element('small', '', detail),
  );
  return node;
}
function renderMetrics(data) {
  const known = data.candles.filter((point) => point.close !== null);
  const first = known[0];
  const latest = known.at(-1);
  const change =
    first && latest
      ? (Number(latest.close) / Number(first.open) - 1) * 100
      : null;
  const volumeKnown =
    data.candles.length && data.candles.every((p) => p.volumeUsd !== null);
  const volume = volumeKnown
    ? data.candles.reduce((total, p) => total + Number(p.volumeUsd), 0)
    : null;
  const totals = data.totals;
  get('trading-metrics').replaceChildren(
    metric(
      'Last reliable market close',
      money(latest?.close),
      latest ? date(latest.at) : 'No reliable USD market price saved.',
    ),
    metric(
      'Recorded price change',
      change === null
        ? 'Unavailable'
        : (change > 0 ? '+' : '') + change.toFixed(2) + '%',
      'First reliable open to last reliable close in this window.',
      change === null ? '' : change >= 0 ? 'positive' : 'negative',
    ),
    metric(
      'Observed market volume',
      money(volume),
      'Selected pool and time range. Unknown intervals make the total unavailable.',
    ),
    metric(
      'Paper fills',
      totals.fills,
      countLabel(totals.buys, 'buy fill') +
        ' / ' +
        countLabel(totals.sells, 'sell fill') +
        ' · Bought ' +
        money(totals.buyNotionalUsd) +
        ' / sold ' +
        money(totals.sellNotionalUsd),
    ),
    metric(
      'Paper fill fees',
      money(totals.feesUsd),
      'All token fills in this account and time range.',
    ),
    metric(
      'Realized paper P&L',
      money(data.positions.realizedPnlUsd),
      data.positions.open +
        ' open / ' +
        countLabel(data.positions.total, 'position') +
        ' · ' +
        countLabel(data.positions.blocked, 'exit') +
        ' blocked · Full context',
      data.positions.realizedPnlUsd == null
        ? ''
        : Number(data.positions.realizedPnlUsd) >= 0
          ? 'positive'
          : 'negative',
    ),
  );
}
const ns = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, value) {
  const node = document.createElementNS(ns, tag);
  for (const [key, val] of Object.entries(attrs))
    node.setAttribute(key, String(val));
  if (value !== undefined) node.textContent = value;
  return node;
}
function inspect(node, description) {
  node.classList.add('chart-target');
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', description);
  node.append(svg('title', {}, description));
  for (const event of ['pointerenter', 'focus', 'click'])
    node.addEventListener(event, () => text('chart-detail', description));
}
function renderCharts(data) {
  get('price-chart').replaceChildren();
  get('volume-chart').replaceChildren();
  text(
    'chart-detail',
    'Hover or focus a candle or trade marker to inspect its values.',
  );
  const source = {
    candles: 'Saved candles',
    observations: 'Saved market observations',
    none: 'No market observations saved',
  }[data.source];
  text(
    'chart-note',
    source +
      ' · ' +
      countLabel(data.window.bucketSeconds / 60, 'minute') +
      ' per chart interval · ' +
      (data.window.from
        ? date(data.window.from) + ' to ' + date(data.window.through)
        : 'No saved time window') +
      (data.markersTruncated
        ? ' · Latest 500 matching fills shown as chart markers.'
        : '') +
      (data.source === 'none'
        ? ' · Any markers show paper execution prices only.'
        : ''),
  );
  const points = data.candles.map((c) => ({ ...c, time: Date.parse(c.at) }));
  const known = points.filter((p) => p.close !== null);
  const markers = data.markers.map((f) => ({ ...f, time: Date.parse(f.at) }));
  const prices = [
    ...known.flatMap((p) => [Number(p.low), Number(p.high)]),
    ...markers.map((m) => Number(m.priceUsd)),
  ];
  get('chart-empty').hidden = prices.length > 0;
  text(
    'chart-empty',
    'No reliable USD market prices or paper execution prices are saved for this selection. Read-only discovery can contain token metadata without trading history.',
  );
  if (!prices.length && !points.some((p) => p.volumeUsd !== null)) return;
  const width = Math.max(280, Math.round(get('price-chart').clientWidth));
  const left = Math.min(105, width * 0.28),
    right = width - 18,
    top = 22,
    bottom = 286;
  const from = Date.parse(data.window.from),
    through = Date.parse(data.window.through);
  const span = through - from;
  const x = (time) =>
    span ? left + ((right - left) * (time - from)) / span : (right + left) / 2;
  const minValue = prices.length ? Math.min(...prices) : 0,
    maxValue = prices.length ? Math.max(...prices) : 1;
  const pad = Math.max(
    (maxValue - minValue) * 0.08,
    maxValue * 0.015,
    Number.MIN_VALUE,
  );
  const low = Math.max(0, minValue - pad),
    high = maxValue + pad;
  const y = (price) => bottom - ((bottom - top) * (price - low)) / (high - low);
  const chart = svg('svg', {
    viewBox: '0 0 ' + width + ' 332',
    role: 'group',
    'aria-label': 'Saved USD market prices and paper buy and sell executions',
  });
  for (const value of [high, (high + low) / 2, low]) {
    chart.append(
      svg('line', {
        x1: left,
        x2: right,
        y1: y(value),
        y2: y(value),
        class: 'chart-grid',
      }),
      svg(
        'text',
        {
          x: left - 9,
          y: y(value) + 5,
          'text-anchor': 'end',
          class: 'chart-text',
        },
        priceLabel(value),
      ),
    );
  }
  const timeLabel = (timestamp) =>
    new Date(timestamp).toISOString().slice(5, 16).replace('T', ' ');
  const labels = [
    [from, 'start'],
    [through, 'end'],
  ];
  for (const [time, anchor] of labels)
    chart.append(
      svg(
        'text',
        { x: x(time), y: 315, 'text-anchor': anchor, class: 'chart-text' },
        timeLabel(time),
      ),
    );
  const band = Math.max(
    2,
    Math.min(
      14,
      (((right - left) * data.window.bucketSeconds * 1000) /
        Math.max(span, data.window.bucketSeconds * 1000)) *
        0.65,
    ),
  );
  const candleText = (p) =>
    date(p.at) +
    ' · Open ' +
    money(p.open) +
    ' · High ' +
    money(p.high) +
    ' · Low ' +
    money(p.low) +
    ' · Close ' +
    money(p.close) +
    ' · Market volume ' +
    money(p.volumeUsd) +
    ' · ' +
    countLabel(p.samples, 'market trade');
  if (get('chart-style').value === 'line') {
    let path = '',
      previous;
    for (const p of points) {
      if (p.close === null) {
        previous = null;
        continue;
      }
      path +=
        (previous && p.time - previous.time <= data.window.bucketSeconds * 1600
          ? 'L'
          : 'M') +
        x(p.time) +
        ',' +
        y(Number(p.close));
      previous = p;
      const dot = svg('circle', {
        cx: x(p.time),
        cy: y(Number(p.close)),
        r: 3,
        fill: '#a6c6ff',
      });
      inspect(dot, candleText(p));
      chart.append(dot);
    }
    chart.prepend(svg('path', { d: path, class: 'market-line' }));
  } else {
    for (const p of known) {
      const cls =
        Number(p.close) >= Number(p.open) ? 'candle-up' : 'candle-down';
      const group = svg('g', {});
      group.append(
        svg('line', {
          x1: x(p.time),
          x2: x(p.time),
          y1: y(Number(p.high)),
          y2: y(Number(p.low)),
          class: cls,
        }),
        svg('rect', {
          x: Math.max(left, x(p.time) - band / 2),
          y: Math.min(y(Number(p.open)), y(Number(p.close))),
          width: Math.min(band, right - x(p.time) + band / 2),
          height: Math.max(
            1.5,
            Math.abs(y(Number(p.open)) - y(Number(p.close))),
          ),
          class: cls,
        }),
      );
      inspect(group, candleText(p));
      chart.append(group);
    }
  }
  for (const fill of [...markers].reverse()) {
    const px = x(fill.time),
      py = y(Number(fill.priceUsd));
    const node =
      fill.side === 'BUY'
        ? svg('circle', { cx: px, cy: py, r: 6, class: 'fill-buy' })
        : svg('path', {
            d: `M${px},${py - 7}l7,7 -7,7 -7,-7Z`,
            class: 'fill-sell',
          });
    inspect(
      node,
      fill.side +
        ' paper fill · ' +
        date(fill.at) +
        ' · ' +
        amounts.format(Number(fill.quantity)) +
        ' tokens at ' +
        money(fill.priceUsd) +
        ' · Notional ' +
        money(fill.notionalUsd) +
        ' · Fees ' +
        money(fill.feesUsd),
    );
    chart.append(node);
  }
  if (prices.length) get('price-chart').append(chart);
  const volumes = points.filter((p) => p.volumeUsd !== null);
  if (!volumes.length) {
    get('volume-chart').append(
      element('p', 'chart-empty', 'No reliable USD market volume saved.'),
    );
    return;
  }
  const volumeChart = svg('svg', {
    viewBox: '0 0 ' + width + ' 125',
    role: 'group',
    'aria-label': 'Saved USD market volume per chart interval',
  });
  const peak = Math.max(...volumes.map((p) => Number(p.volumeUsd)), 1);
  volumeChart.append(
    svg(
      'text',
      { x: left - 9, y: 22, 'text-anchor': 'end', class: 'chart-text' },
      priceLabel(peak),
    ),
    svg('line', { x1: left, x2: right, y1: 105, y2: 105, class: 'chart-grid' }),
  );
  for (const p of volumes) {
    const height = (Number(p.volumeUsd) / peak) * 85;
    const bar = svg('rect', {
      x: Math.max(left, x(p.time) - band / 2),
      y: 105 - height,
      width: band,
      height: Math.max(height, 1),
      class: 'market-volume',
    });
    inspect(bar, date(p.at) + ' · Market volume ' + money(p.volumeUsd));
    volumeChart.append(bar);
  }
  get('volume-chart').append(volumeChart);
}
function priceLabel(value) {
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.001 || Math.abs(value) >= 1e7)
    return '$' + value.toExponential(2);
  return (
    '$' +
    new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(
      value,
    )
  );
}
function renderFills() {
  get('trade-rows').replaceChildren(
    ...displayedFills.map((fill) => {
      const row = element('tr');
      for (const value of [
        date(fill.at),
        fill.side,
        money(fill.priceUsd),
        amounts.format(Number(fill.quantity)),
        money(fill.notionalUsd),
        money(fill.feesUsd),
      ]) {
        const td = element('td');
        td.append(
          element(
            'span',
            value === fill.side
              ? 'trade-side ' + (fill.side === 'BUY' ? 'positive' : 'negative')
              : '',
            value,
          ),
        );
        row.append(td);
      }
      const td = element('td'),
        details = element('details');
      details.append(element('summary', '', 'View IDs'));
      for (const [name, value] of [
        ['Fill', fill.id],
        ['Order', fill.orderId],
        ['Position', fill.positionId],
      ])
        if (value) details.append(element('p', '', name + ' · ' + value));
      td.append(details);
      row.append(td);
      return row;
    }),
  );
  get('fills-empty').hidden = displayedFills.length > 0;
  text(
    'trade-count',
    countLabel(displayedFills.length, 'paper fill') + ' shown · Newest first',
  );
  get('more-trades').hidden = !nextTrade;
}
function busy(value) {
  get('trading-view').setAttribute('aria-busy', String(value));
  for (const id of [
    'trading-context',
    'trading-range',
    'trading-pool',
    'trade-side',
    'refresh-token',
    'more-trades',
  ])
    get(id).disabled = value;
}
async function loadTrading(append = false) {
  if (!mint) return;
  tradingRequest?.abort();
  const controller = new AbortController();
  tradingRequest = controller;
  const sameToken = loaded?.token.mint === mint;
  busy(true);
  error('');
  text('load-state', 'Loading saved trading data…');
  if (!sameToken) {
    get('trading-view').hidden = true;
    get('welcome').hidden = false;
    get('welcome').querySelector('h2').textContent = 'Loading trading data';
    get('welcome').querySelector('p').textContent =
      'Reading saved market history and paper executions…';
  }
  try {
    const params = { mint, range, side };
    if (context) params.context = context;
    if (pool) params.pool = pool;
    if (append && nextTrade) params.cursor = nextTrade;
    const data = await read('/api/trading/token', params, controller.signal);
    if (controller.signal.aborted) return;
    // Paging may occur while a collector is writing. Keep the chart and summary
    // from this response together; deduplicate any reloaded table records by ID.
    context = data.context.key;
    pool = data.pool;
    range = data.range;
    loaded = data;
    displayedFills = append
      ? [
          ...new Map(
            [...displayedFills, ...data.fills].map((fill) => [fill.id, fill]),
          ).values(),
        ]
      : data.fills;
    nextTrade = data.next;
    get('trading-view').hidden = false;
    get('welcome').hidden = true;
    renderHeader(data);
    renderMetrics(data);
    renderCharts(data);
    renderFills();
    text(
      'load-state',
      'Saved data · ' +
        (data.window.through
          ? 'Latest recorded event ' + date(data.window.through)
          : 'No market observations or paper fills in this context.') +
        ' · Refresh to read updates.',
    );
    const query = new URLSearchParams({ mint, context, range });
    if (pool) query.set('pool', pool);
    if (side) query.set('side', side);
    window.history.replaceState(null, '', '/trading?' + query);
  } catch (cause) {
    if (controller.signal.aborted) return;
    error(cause.message);
    if (sameToken && loaded) {
      context = loaded.context.key;
      pool = loaded.pool;
      range = loaded.range;
      side = loaded.side ?? '';
      renderHeader(loaded);
      text('load-state', 'Showing previously loaded trading data.');
    } else {
      get('welcome').querySelector('h2').textContent =
        'Trading data could not be loaded';
      get('welcome').querySelector('p').textContent =
        'Choose a saved token to try again.';
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
get('more-tokens').addEventListener(
  'click',
  () => void searchTokens(searchValue === get('token-search').value.trim()),
);
get('trading-context').addEventListener('change', () => {
  context = get('trading-context').value;
  pool = '';
  void loadTrading();
});
get('trading-pool').addEventListener('change', () => {
  pool = get('trading-pool').value;
  void loadTrading();
});
get('trading-range').addEventListener('change', () => {
  range = get('trading-range').value;
  void loadTrading();
});
get('trade-side').addEventListener('change', () => {
  side = get('trade-side').value;
  void loadTrading();
});
get('chart-style').addEventListener('change', () => {
  if (loaded) renderCharts(loaded);
});
get('refresh-token').addEventListener('click', () => void loadTrading());
get('more-trades').addEventListener('click', () => void loadTrading(true));
let chartWidth = 0;
new ResizeObserver((entries) => {
  const width = Math.round(entries[0].contentRect.width);
  if (width !== chartWidth) {
    chartWidth = width;
    if (loaded && !get('trading-view').hidden) renderCharts(loaded);
  }
}).observe(get('price-chart'));
void searchTokens();
if (mint) void loadTrading();
