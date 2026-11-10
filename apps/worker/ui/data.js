/* global document, fetch, URLSearchParams, AbortSignal, AbortController */
const get = (id) => document.getElementById(id);
const set = (id, value) => {
  get(id).textContent = value;
};
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
const shortDay = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const counts = new Intl.NumberFormat();
const dollars = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});
const svgNs = 'http://www.w3.org/2000/svg';
let catalog = [];
let dataset;
let applied;
let pages = [null];
let next;
let timeline;
let request;
let equityRequest;
let chartView = 'counts';

async function api(path, signal) {
  const response = await fetch(path, {
    signal: AbortSignal.any([AbortSignal.timeout(25_000), signal]),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Could not load the data.');
  return data;
}

function error(message) {
  set('data-error', message);
  get('data-error').hidden = !message;
}

function svg(tag, attributes, value) {
  const element = document.createElementNS(svgNs, tag);
  for (const [key, attribute] of Object.entries(attributes))
    element.setAttribute(key, String(attribute));
  if (value !== undefined) element.textContent = value;
  return element;
}

function chartBounds() {
  const width = Math.max(
    230,
    Math.min(960, get('chart').parentElement.clientWidth - 32),
  );
  return { left: 78, right: width - 16, top: 24, bottom: 164, width };
}

function canvas(label, width) {
  return svg('svg', {
    viewBox: '0 0 ' + width + ' 200',
    role: 'img',
    'aria-label': label,
  });
}

function caption(emptyMessage) {
  set('chart-empty', emptyMessage);
  get('chart-empty').hidden = !emptyMessage;
}

function horizontal(chart, bounds, y, label) {
  const { left, right } = bounds;
  chart.append(
    svg('line', { x1: left, x2: right, y1: y, y2: y, class: 'chart-axis' }),
    svg(
      'text',
      { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'chart-text' },
      label,
    ),
  );
}

function xLabel(chart, x, label, anchor = 'middle') {
  chart.append(
    svg(
      'text',
      { x, y: 187, 'text-anchor': anchor, class: 'chart-text' },
      label,
    ),
  );
}

function renderTimeline() {
  chartView = 'counts';
  get('back-to-counts').hidden = true;
  set('chart-kicker', 'Recorded activity');
  set('chart-heading', 'Records by day');
  set('chart-caption', 'Latest 14 days with matching records. Dates use UTC.');
  get('chart').replaceChildren();
  caption(timeline ? 'No matching records to chart.' : 'Loading chart…');
  if (!timeline?.length) return;

  const bounds = chartBounds();
  const chart = canvas(
    timeline.map((point) => point.day + ': ' + point.count).join(', '),
    bounds.width,
  );
  const { left, right, top, bottom } = bounds;
  const peak = Math.max(...timeline.map((point) => point.count));
  const band = (right - left) / timeline.length;
  const width = Math.min(band * 0.62, 78);
  const labelStep = Math.max(1, Math.ceil(36 / band));
  horizontal(chart, bounds, top, counts.format(peak));
  if (peak > 1)
    horizontal(chart, bounds, (bottom + top) / 2, counts.format(peak / 2));
  horizontal(chart, bounds, bottom, '0');
  timeline.forEach((point, index) => {
    const x = left + band * (index + 0.5);
    const height = (bottom - top) * (point.count / peak);
    const bar = svg('rect', {
      x: x - width / 2,
      y: bottom - height,
      width,
      height,
      rx: 3,
      class: 'chart-bar',
    });
    bar.append(
      svg(
        'title',
        {},
        point.day + ' · ' + counts.format(point.count) + ' records',
      ),
    );
    chart.append(bar);
    if (index % labelStep === 0) xLabel(chart, x, point.day.slice(5));
  });
  caption('');
  get('chart').append(chart);
}

function renderEquity(runId, points, truncated) {
  const series = points.map(({ at, equity }) => ({
    at,
    date: Date.parse(at),
    value: equity === null ? null : Number(equity),
    raw: equity,
  }));
  const known = series.filter(
    ({ value }) => value !== null && Number.isFinite(value),
  );
  if (!known.length) {
    caption(
      series.length
        ? 'Saved snapshots have no reliable equity values.'
        : 'This run has no saved equity snapshots.',
    );
    return;
  }

  const bounds = chartBounds();
  const { left, right, top, bottom } = bounds;
  const start = series[0].date;
  const end = series.at(-1).date;
  const low = Math.min(...known.map(({ value }) => value));
  const high = Math.max(...known.map(({ value }) => value));
  const pad = Math.max((high - low) * 0.08, 0.01);
  const min = low - pad;
  const max = high + pad;
  const x = (date) =>
    start === end
      ? (left + right) / 2
      : left + ((right - left) * (date - start)) / (end - start);
  const y = (value) => bottom - ((bottom - top) * (value - min)) / (max - min);
  const latest = known.at(-1);
  const summary =
    counts.format(series.length) +
    ' snapshots · Last reliable value ' +
    dollars.format(latest.value) +
    ' at ' +
    dateTime.format(latest.date) +
    ' UTC.';
  set(
    'chart-caption',
    'Run ' +
      runId +
      ' · ' +
      summary +
      ' Gaps mark unavailable equity.' +
      (truncated ? ' Showing the latest 250 snapshots.' : ''),
  );
  const chart = canvas('Saved paper equity. ' + summary, bounds.width);
  for (const value of [max, (min + max) / 2, min])
    horizontal(chart, bounds, y(value), dollars.format(value));

  let path = '';
  let gap = true;
  for (const point of series) {
    if (point.value === null || !Number.isFinite(point.value)) {
      gap = true;
      continue;
    }
    path += (gap ? 'M' : 'L') + x(point.date) + ',' + y(point.value);
    gap = false;
  }
  chart.append(svg('path', { d: path, class: 'chart-line' }));
  for (const point of known) {
    const dot = svg('circle', {
      cx: x(point.date),
      cy: y(point.value),
      r: 2.7,
      class: 'chart-dot',
    });
    dot.append(
      svg('title', {}, dateTime.format(point.date) + ' UTC · USD ' + point.raw),
    );
    chart.append(dot);
  }
  const timeLabel = (date) =>
    end - start < 86400000
      ? new Intl.DateTimeFormat(undefined, {
          timeStyle: 'medium',
          timeZone: 'UTC',
        }).format(date)
      : shortDay.format(date);
  xLabel(chart, x(start), timeLabel(start), start === end ? 'middle' : 'start');
  if (start !== end) xLabel(chart, x(end), timeLabel(end), 'end');
  caption('');
  get('chart').append(chart);
}

async function showEquity(runId) {
  equityRequest?.abort();
  const controller = new AbortController();
  equityRequest = controller;
  chartView = 'equity';
  get('back-to-counts').hidden = false;
  set('chart-kicker', 'Saved backtest equity');
  set('chart-heading', 'Paper equity over time');
  set('chart-caption', 'Run ' + runId);
  get('chart').replaceChildren();
  caption('Loading equity snapshots…');
  get('chart-heading').scrollIntoView({ block: 'nearest' });
  get('back-to-counts').focus({ preventScroll: true });
  try {
    const { points, truncated } = await api(
      '/api/data/equity?' + new URLSearchParams({ run: runId }),
      controller.signal,
    );
    if (!controller.signal.aborted) renderEquity(runId, points, truncated);
  } catch (cause) {
    if (!controller.signal.aborted) caption(cause.message);
  }
}

function columnLabel(key) {
  const explicit = { mint: 'Token mint', signature: 'Transaction signature' };
  return (
    explicit[key] ??
    key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b(?:Id|Usd)\b/g, (part) => part.toUpperCase())
      .replace(/^./, (part) => part.toUpperCase())
  );
}

function renderRows(rows) {
  const table = get('records');
  const chartable = dataset.key === 'backtests';
  const header = document.createElement('tr');
  for (const column of [
    ...dataset.columns,
    ...(chartable ? ['equity chart'] : []),
  ]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = columnLabel(column);
    header.append(th);
  }
  table.tHead.replaceChildren(header);
  table.tBodies[0].replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr');
      for (const column of dataset.columns) {
        const td = document.createElement('td');
        const value = row[column];
        td.dataset.muted = String(value === null || value === '');
        if (value === null || value === '') td.textContent = '—';
        else if (
          column.endsWith('At') ||
          column === 'timestamp' ||
          column === 'validUntil'
        ) {
          const stamp = document.createElement('time');
          stamp.dateTime = value;
          stamp.textContent = dateTime.format(new Date(value));
          td.append(stamp);
        } else td.textContent = value;
        tr.append(td);
      }
      if (chartable) {
        const td = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'record-action';
        button.textContent = 'View equity';
        button.setAttribute('aria-label', 'View equity for run ' + row.runId);
        button.addEventListener('click', () => void showEquity(row.runId));
        td.append(button);
        tr.append(td);
      }
      return tr;
    }),
  );
  get('record-scroll').hidden = !rows.length;
  get('records-empty').hidden = Boolean(rows.length);
  if (!rows.length) set('records-empty', 'No records match these filters.');
  const offset = (pages.length - 1) * 50;
  set(
    'result-label',
    rows.length
      ? 'Rows ' + (offset + 1) + '–' + (offset + rows.length)
      : '0 records',
  );
}

async function loadPage(page) {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const params = new URLSearchParams(applied);
  if (page.at(-1)) params.set('cursor', page.at(-1));
  get('previous').disabled = true;
  get('next').disabled = true;
  set('result-label', 'Loading');
  error('');
  try {
    const result = await api('/api/data/records?' + params, controller.signal);
    if (controller.signal.aborted) return;
    pages = page;
    next = result.next;
    if (result.timeline) {
      timeline = result.timeline;
      if (chartView === 'counts') renderTimeline();
    }
    renderRows(result.rows);
    get('previous').disabled = pages.length === 1;
    get('next').disabled = !next;
  } catch (cause) {
    if (controller.signal.aborted) return;
    error(cause.message);
    set('result-label', 'Unavailable');
    get('record-scroll').hidden = true;
    get('records-empty').hidden = false;
    set('records-empty', 'Records could not be loaded.');
    if (chartView === 'counts') {
      get('chart').replaceChildren();
      caption('Chart unavailable.');
    }
  }
}

function apply() {
  equityRequest?.abort();
  applied = {
    dataset: dataset.key,
    from: get('from').value,
    through: get('through').value,
  };
  if (dataset.filterLabel) applied.filter = get('filter').value;
  timeline = undefined;
  renderTimeline();
  get('record-scroll').hidden = true;
  get('records-empty').hidden = false;
  set('records-empty', 'Loading records…');
  void loadPage([null]);
}

function selectDataset() {
  dataset = catalog.find((entry) => entry.key === get('dataset').value);
  get('id-filter').hidden = !dataset.filterLabel;
  get('filter').value = '';
  if (dataset.filterLabel) set('filter-label', dataset.filterLabel);
  set('dataset-description', dataset.description);
  set('records-heading', dataset.label);
  apply();
}

get('filters').addEventListener('submit', (event) => {
  event.preventDefault();
  if (dataset) apply();
});
get('dataset').addEventListener('change', selectDataset);
get('reset').addEventListener('click', () => {
  for (const field of ['filter', 'from', 'through']) get(field).value = '';
  apply();
});
get('previous').addEventListener(
  'click',
  () => void loadPage(pages.slice(0, -1)),
);
get('next').addEventListener('click', () => void loadPage([...pages, next]));
get('back-to-counts').addEventListener('click', () => {
  equityRequest?.abort();
  renderTimeline();
  get('chart').focus({ preventScroll: true });
});

try {
  catalog = await api('/api/data/catalog', new AbortController().signal);
  for (const entry of catalog) {
    const option = document.createElement('option');
    option.value = entry.key;
    option.textContent = entry.label;
    get('dataset').append(option);
  }
  for (const control of ['dataset', 'apply', 'reset'])
    get(control).disabled = false;
  selectDataset();
} catch (cause) {
  error(cause.message);
  set(
    'dataset-description',
    'Could not load the dataset list. Reload the page to try again.',
  );
  set('result-label', 'Unavailable');
  set('records-empty', 'Records could not be loaded.');
  caption('Chart unavailable.');
}
