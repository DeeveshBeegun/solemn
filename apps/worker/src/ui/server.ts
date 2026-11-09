import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { desc, eq } from 'drizzle-orm';
import { createDatabase, forwardRuntimeEvents } from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { forwardStatus } from '../forward/monitor.js';
import { scenarioNames } from '../execution/simulation/executionScenarios.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
dotenv({ path: resolve(root, '.env'), quiet: true });
const port = Number(process.env.SOLEMN_UI_PORT ?? '4173');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('SOLEMN_UI_PORT must be a port number from 1 to 65535');

const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const token = randomUUID();
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
]);
const accountPattern = /^[a-zA-Z0-9_-]{1,50}$/;
const configuredAccount = process.env.FORWARD_ACCOUNT ?? 'week8';
const defaultAccount = accountPattern.test(configuredAccount)
  ? configuredAccount
  : 'week8';

type Log = {
  at: string;
  level: string;
  message: string;
  facts?: Record<string, string | number>;
};
type Step = {
  file: string;
  args: string[];
  label: string;
  capture?: boolean;
};
type Forward = { mode: 'replay' | 'discovery'; account: string };
type Plan = {
  mode: string;
  label: string;
  env: NodeJS.ProcessEnv;
  steps: Step[];
  forward?: Forward;
};
type Job = {
  mode: string;
  label: string;
  status: 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';
  startedAt: string;
  finishedAt?: string;
  logs: Log[];
  forward?: Forward;
};
let job: Job | undefined;
let child: ChildProcess | undefined;
let deadline: NodeJS.Timeout | undefined;
let closing = false;

function nodeStep(script: string, args: string[], label: string): Step {
  return {
    file: process.execPath,
    args: [script, ...args],
    label,
    capture: true,
  };
}

function forwardEnv(forward: Forward): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ENABLE_METERED_MARKET_DATA: 'false',
    FORWARD_PAPER_ENABLED: 'true',
    FORWARD_MARKET_DATA_MODE:
      forward.mode === 'replay' ? 'REPLAY' : 'LIVE_READ_ONLY',
    FORWARD_ACCOUNT: forward.account,
    SCANNER_ENABLED: 'false',
    PAPER_TRADING_ENABLED: 'false',
    STRATEGY_ENABLED: 'false',
  };
}

class InputError extends Error {}

function readForward(mode: string | null, account: string | null): Forward {
  if (mode === 'discovery') return { mode, account: 'live' };
  if (mode === 'replay' && accountPattern.test(account ?? ''))
    return { mode, account: account! };
  throw new InputError(
    'Use 1–50 letters, numbers, hyphens or underscores for the replay account.',
  );
}

function planLaunch(input: Record<string, unknown>): Plan {
  const env = {
    ...process.env,
    ENABLE_METERED_MARKET_DATA: 'false',
    FORWARD_PAPER_ENABLED: 'false',
    LOG_LEVEL: 'info',
  };
  const mode = input.mode;
  if (mode === 'database')
    return {
      mode,
      label: 'Database setup',
      env,
      steps: [
        {
          file: 'docker',
          args: ['compose', 'up', '-d', '--wait', 'postgres'],
          label: 'Start PostgreSQL with Docker Compose',
        },
        nodeStep(
          'packages/database/dist/migrate.js',
          [],
          'Apply database migrations',
        ),
      ],
    };
  if (mode === 'worker')
    return {
      mode,
      label: 'Configured worker',
      env,
      steps: [
        nodeStep(
          'apps/worker/dist/index.js',
          [],
          'Start configured worker services',
        ),
      ],
    };
  if (mode === 'replay' || mode === 'discovery') {
    const forward = readForward(
      mode,
      typeof input.account === 'string' ? input.account : null,
    );
    const args = ['run'];
    if (mode === 'discovery' && input.duration !== 'continuous') {
      if (
        typeof input.duration !== 'number' ||
        !Number.isInteger(input.duration) ||
        input.duration < 1 ||
        input.duration > 300
      )
        throw new InputError(
          'Choose continuous discovery or a duration from 1 to 300 seconds.',
        );
      args.push('--smoke-seconds', String(input.duration));
    }
    const label =
      mode === 'replay' ? 'Forward paper replay' : 'Read-only discovery';
    return {
      mode,
      label,
      forward,
      env: { ...forwardEnv(forward), LOG_LEVEL: 'info' },
      steps: [nodeStep('apps/worker/dist/forward/cli.js', args, label)],
    };
  }
  if (mode === 'backtest') {
    const dataset = input.dataset;
    if (
      typeof dataset !== 'string' ||
      ![
        'fixtures',
        'fixtures-analytics',
        'fixtures-winner',
        'fixtures-zero-trade',
      ].includes(dataset)
    )
      throw new InputError('Select a bundled fixture dataset.');
    const label = 'Fixture backtest';
    return {
      mode,
      label,
      env,
      steps: [
        nodeStep(
          'apps/worker/dist/backtesting/cli.js',
          ['--dataset', dataset],
          label,
        ),
      ],
    };
  }
  if (mode === 'stress') {
    const scenario = input.scenario;
    const seed = input.seed;
    if (
      typeof scenario !== 'string' ||
      ![...scenarioNames, 'all', 'week6-reference'].includes(scenario)
    )
      throw new InputError('Select a supported execution scenario.');
    if (
      typeof seed !== 'number' ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 2147483647
    )
      throw new InputError('Use an integer seed from 0 to 2147483647.');
    const label = 'Execution stress test';
    return {
      mode,
      label,
      env,
      steps: [
        nodeStep(
          'apps/worker/dist/backtesting/stressCli.js',
          [
            '--dataset',
            'fixtures',
            '--scenario',
            scenario,
            '--seed',
            String(seed),
          ],
          label,
        ),
      ],
    };
  }
  throw new InputError('Select a supported launch mode.');
}

function log(run: Job, message: string, level = 'info', facts?: Log['facts']) {
  run.logs.push({
    at: new Date().toISOString(),
    message,
    level,
    ...(facts ? { facts } : {}),
  });
  if (run.logs.length > 150) run.logs.shift();
}

function capture(run: Job, line: string) {
  // Expose the worker's structured messages and a limited set of progress fields.
  // Drop raw process output, driver details, arbitrary JSON fields and stack traces.
  if (line === 'Solemn database migrations applied') {
    log(run, line);
    return;
  }
  try {
    const event = JSON.parse(line);
    if (event?.name !== 'solemn-worker' || typeof event.msg !== 'string')
      return;
    const facts: NonNullable<Log['facts']> = {};
    for (const key of [
      'code',
      'mint',
      'runId',
      'experimentId',
      'status',
      'reason',
      'outcome',
      'readiness',
      'sourceKind',
      'mode',
      'cursor',
      'trackedTokens',
      'closedPositions',
      'openPositions',
      'realizedNetPnlUsd',
      'endingReliableEquityUsd',
      'processed',
      'received',
      'queueDepth',
      'scenario',
      'subscription',
    ]) {
      const value: unknown = event[key];
      if (
        typeof value === 'number' ||
        (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value))
      )
        facts[key] = value;
    }
    if (typeof event.directory === 'string') {
      const directory = resolve(root, event.directory);
      const reports = resolve(root, 'reports');
      if (
        directory.startsWith(reports + '/') &&
        /^[a-zA-Z0-9_./-]+$/.test(directory.slice(root.length))
      )
        facts.directory = directory.slice(root.length);
    }
    const message = /^[a-zA-Z0-9 .:;,()_–-]{1,300}$/.test(event.msg)
      ? event.msg
      : 'Worker reported an event';
    log(
      run,
      message,
      event.level >= 50 ? 'error' : event.level >= 40 ? 'warning' : 'info',
      facts,
    );
  } catch {
    // Non-structured CLI output is intentionally excluded.
  }
}

function stop() {
  if (job?.status !== 'running') return;
  const run = job;
  run.status = 'stopping';
  log(run, 'Stop requested. Waiting for the process to shut down.');
  child?.kill('SIGTERM');
  if (child)
    deadline = setTimeout(() => {
      log(
        run,
        'Shutdown deadline exceeded. Terminating the process.',
        'warning',
      );
      child?.kill('SIGKILL');
    }, 240_000);
}

async function runStep(run: Job, step: Step, env: NodeJS.ProcessEnv) {
  log(run, step.label);
  const process = spawn(step.file, step.args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = process;
  for (const stream of [process.stdout, process.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8').on('data', (chunk: string) => {
      if (!step.capture) return;
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop() ?? '';
      if (buffer.length > 16_384) buffer = '';
      for (const line of lines)
        if (line.length <= 16_384) capture(run, line.trim());
    });
    stream.once('end', () => {
      if (step.capture && buffer) capture(run, buffer.trim());
    });
  }
  try {
    await new Promise<void>((done, fail) => {
      process.once('error', () =>
        fail(
          new Error(
            `Could not start ${step.label}. Check the installation and PATH.`,
          ),
        ),
      );
      process.once('close', (code, signal) => {
        if (code === 0 || (signal === 'SIGTERM' && run.status === 'stopping'))
          done();
        else
          fail(
            new Error(`${step.label} exited with ${signal ?? `code ${code}`}.`),
          );
      });
    });
  } finally {
    child = undefined;
    clearTimeout(deadline);
  }
}

async function inspect(forward: Forward) {
  const config = loadConfig(forwardEnv(forward));
  const db = createDatabase(config.DATABASE_URL);
  try {
    const status = await forwardStatus(db.db, config);
    const base = {
      ...forward,
      portfolioId: status.portfolioId,
      status: status.status,
    };
    if (!('ownershipVerified' in status)) return { ...base, events: [] };
    const events = await db.db
      .select({
        id: forwardRuntimeEvents.id,
        kind: forwardRuntimeEvents.kind,
        at: forwardRuntimeEvents.at,
      })
      .from(forwardRuntimeEvents)
      .where(eq(forwardRuntimeEvents.portfolioId, status.portfolioId))
      .orderBy(desc(forwardRuntimeEvents.at), desc(forwardRuntimeEvents.id))
      .limit(14);
    return {
      ...base,
      feedHealth: status.feedHealth,
      ownershipVerified: status.ownershipVerified,
      workerHeartbeatFresh: status.workerHeartbeatFresh,
      lastObservationAt: status.lastObservationAt,
      trackedTokens: status.trackedTokens,
      cursor: 'cursor' in status ? status.cursor : undefined,
      openPositions: status.openPositions,
      markedEquityUsd: status.markedEquityUsd,
      valuationQuality: status.valuationQuality,
      fills:
        'fills' in status.activity && typeof status.activity.fills === 'string'
          ? status.activity.fills
          : undefined,
      events: events.map((event) => ({
        ...event,
        at: new Date(event.at).toISOString(),
      })),
    };
  } finally {
    await db.close();
  }
}

async function runPlan(run: Job, plan: Plan) {
  try {
    if (plan.mode !== 'database') {
      try {
        loadConfig(plan.env);
      } catch {
        throw new Error(
          'Solemn configuration is invalid. Check .env against .env.example.',
        );
      }
    }
    if (plan.forward) {
      log(run, 'Check the forward account and its worker ownership');
      let status;
      try {
        status = await inspect(plan.forward);
      } catch {
        throw new Error(
          'Could not read the forward account. Check DATABASE_URL and run Database setup.',
        );
      }
      if ('ownershipVerified' in status && status.ownershipVerified)
        throw new Error(
          'Another worker owns this forward account. Stop it before launching here.',
        );
    }
    for (const step of plan.steps) {
      if (run.status === 'stopping') break;
      await runStep(run, step, plan.env);
    }
    run.status = run.status === 'stopping' ? 'stopped' : 'completed';
    log(run, run.status === 'stopped' ? 'Process stopped' : 'Run completed');
  } catch (error) {
    run.status = 'failed';
    log(run, error instanceof Error ? error.message : 'Run failed', 'error');
    if (plan.mode === 'database')
      log(
        run,
        'Check Docker and .env, or run pnpm db:migrate in the terminal for diagnostics.',
        'warning',
      );
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let input = '';
  for await (const chunk of req) {
    input += chunk.toString();
    if (input.length > 4096) throw new InputError('Request is too large.');
  }
  try {
    const data = JSON.parse(input);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Report malformed payloads without including their contents.
  }
  throw new InputError('Expected a JSON object.');
}

let lastSnapshot:
  { key: string; until: number; result: Promise<unknown> } | undefined;
function snapshot(forward: Forward) {
  const key = `${forward.mode}:${forward.account}`;
  if (lastSnapshot?.key === key && lastSnapshot.until > Date.now())
    return lastSnapshot.result;
  const result = inspect(forward).then(
    (account) => ({ database: 'ready', account }),
    () => ({ database: 'unavailable', account: null }),
  );
  lastSnapshot = { key, until: Date.now() + 4000, result };
  return result;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  if (
    req.headers.host !== host ||
    (req.headers.origin && req.headers.origin !== origin)
  )
    return json(res, 403, {
      error: 'Open the dashboard using its printed localhost URL.',
    });

  const url = new URL(req.url ?? '/', origin);
  if (req.method === 'GET') {
    const asset = assets.get(url.pathname);
    if (asset) {
      const [file, type] = asset;
      const bytes = await readFile(resolve(root, 'apps/worker/ui', file!));
      res.writeHead(200, { 'Content-Type': type! });
      res.end(bytes);
      return;
    }
    if (url.pathname === '/api/state')
      return json(res, 200, { token, defaultAccount, job });
    if (url.pathname === '/api/account') {
      const forward = readForward(
        url.searchParams.get('mode'),
        url.searchParams.get('account'),
      );
      return json(res, 200, await snapshot(forward));
    }
  }
  if (
    req.method === 'POST' &&
    ['/api/launch', '/api/stop'].includes(url.pathname)
  ) {
    if (
      req.headers.origin !== origin ||
      req.headers['x-solemn-token'] !== token ||
      req.headers['content-type'] !== 'application/json'
    )
      return json(res, 403, { error: 'Reload the dashboard and try again.' });
    if (url.pathname === '/api/stop') {
      stop();
      return json(res, 200, { job });
    }
    const plan = planLaunch(await body(req));
    if (closing || job?.status === 'running' || job?.status === 'stopping')
      return json(res, 409, {
        error: 'Wait for the current process to finish or stop it first.',
      });
    job = {
      mode: plan.mode,
      label: plan.label,
      status: 'running',
      startedAt: new Date().toISOString(),
      ...(plan.forward ? { forward: plan.forward } : {}),
      logs: [],
    };
    void runPlan(job, plan);
    return json(res, 202, { job });
  }
  return json(res, 404, { error: 'Page not found.' });
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    if (!res.headersSent)
      json(res, error instanceof InputError ? 400 : 500, {
        error:
          error instanceof InputError
            ? error.message
            : 'Dashboard request failed.',
      });
    else res.end();
  });
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    `Could not open the Solemn dashboard (${error.code ?? 'UNKNOWN'}). Set SOLEMN_UI_PORT to use a different port.`,
  );
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () =>
  console.info(`Solemn dashboard: ${origin}`),
);
function close() {
  closing = true;
  stop();
  server.close();
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
