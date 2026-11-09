import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import {
  assertSafeTestDatabase,
  createDatabase,
} from '../packages/database/dist/index.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const testUrl = assertSafeTestDatabase(
  process.env.TEST_DATABASE_URL,
  process.env.DATABASE_URL,
);
const directory = mkdtempSync(join(tmpdir(), 'solemn-release-smoke-'));
const nonce = randomUUID().replaceAll('-', '');
const account = 'release-' + nonce.slice(0, 18);
const scratch = 'solemn_release_' + nonce;
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = '/' + scratch;
const control = createDatabase(testUrl);
const env = {
  PATH: process.env.PATH,
  DATABASE_URL: scratchUrl.href,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  TRADING_MODE: 'PAPER',
  ENABLE_LIVE_TRADING: 'false',
  ENABLE_METERED_MARKET_DATA: 'false',
  ENABLE_PAID_TRADE_STREAM: 'false',
  FORWARD_PAPER_ENABLED: 'true',
  FORWARD_MARKET_DATA_MODE: 'REPLAY',
  FORWARD_ACCOUNT: account,
};
const path = (name) => fileURLToPath(new URL('../' + name, import.meta.url));
const worker = 'apps/worker/dist/index.js';
const cli = 'apps/worker/dist/operations/cli.js';

function run(file, args = [], override = {}) {
  return spawnSync(process.execPath, [path(file), ...args], {
    cwd: directory,
    env: { ...env, ...override },
    timeout: 120000,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function expectExit(file, args, status, override) {
  const result = run(file, args, override);
  assert.equal(result.status, status, file + ' unexpected exit');
  return result.stdout;
}
function report(action, ...args) {
  return JSON.parse(expectExit(cli, [action, ...args], 0));
}

async function verifyIdleLifecycle() {
  const processHandle = spawn(process.execPath, [path(worker)], {
    cwd: directory,
    env: { ...env, FORWARD_PAPER_ENABLED: 'false', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => processHandle.kill('SIGKILL'), 15000);
  let log = '';
  let ready = false;
  try {
    await new Promise((resolve, reject) => {
      processHandle.stderr.resume();
      processHandle.stdout.on('data', (data) => {
        log += data.toString();
        if (!ready && log.includes('Solemn worker ready')) {
          ready = true;
          processHandle.kill('SIGTERM');
        }
      });
      processHandle.once('error', reject);
      processHandle.once('close', (code) => {
        try {
          assert.equal(code, 0);
          assert.ok(ready && log.includes('PostgreSQL connection established'));
          assert.ok(log.includes('"tradingMode":"PAPER"'));
          assert.ok(log.includes('Solemn worker stopped'));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

let created = false;
let summary;
try {
  // The name contains only generated lowercase hexadecimal characters and a fixed prefix.
  await control.pool.query('CREATE DATABASE "' + scratch + '"');
  created = true;
  expectExit('packages/database/dist/migrate.js', [], 0);
  await verifyIdleLifecycle();
  for (const unsafe of [
    { ENABLE_LIVE_TRADING: 'true' },
    { ENABLE_TRANSACTION_SIGNING: 'true' },
    { JUPITER_EXECUTE_URL: 'https://api.jup.ag/swap/v2/execute' },
  ])
    expectExit(worker, [], 1, unsafe);
  expectExit(worker, [], 0);
  const before = report('reconcile');
  const initial = report('health');
  assert.equal(initial.status, 'STOPPED');
  assert.equal(initial.tradingMode, 'PAPER');
  assert.equal(initial.database.status, 'HEALTHY');
  assert.ok(initial.gaps > 0);
  assert.equal(before.reconciliation, 'PASS');
  assert.equal(before.fills, 4);
  assert.equal(before.state.availableCashUsd, '101.098514');
  assert.equal(before.state.reservedCashUsd, '0');
  assert.equal(before.state.investedCostBasisUsd, '0');
  assert.equal(before.state.positions.length, 1);
  assert.ok(
    before.state.positions.every(
      (position) => position.status === 'CLOSED' && position.quantity === '0',
    ),
  );
  assert.equal(report('pause').state, 'PAUSED');
  const halted = report('halt', '--reason', 'Release smoke drill');
  assert.equal(halted.state, 'HALTED');
  assert.deepEqual(report('halt', '--reason', 'Release smoke drill'), halted);
  expectExit(cli, ['resume'], 1);
  expectExit(worker, [], 0);
  const final = report('health');
  assert.equal(final.status, 'HALTED');
  assert.equal(final.newEntries, false);
  assert.deepEqual(report('reconcile'), before);
  summary = {
    status: 'PASS',
    account,
    portfolioId: before.portfolioId,
    database: final.database.status,
    mode: final.tradingMode,
    operationalState: final.status,
    gaps: final.gaps,
    orders: before.orders,
    fills: before.fills,
    ledgerEvents: before.eventCount,
    availableCashUsd: before.state.availableCashUsd,
  };
} finally {
  try {
    if (created) await control.pool.query('DROP DATABASE "' + scratch + '"');
  } finally {
    await control.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(summary, null, 2));
