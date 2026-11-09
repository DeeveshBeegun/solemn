import { spawnSync } from 'node:child_process';
import console from 'node:console';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = manifest;
const output = join(root, 'reports', 'release');
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'verify-'));
const steps = [
  ['install', ['install', '--frozen-lockfile']],
  ['typecheck', ['typecheck']],
  ['lint', ['lint']],
  ['unit', ['test']],
  ['integration', ['test:integration']],
  ['build', ['build']],
  ['deployment-smoke', ['release:smoke']],
];
const summary = {
  version,
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  checks: [],
};
const save = () =>
  writeFileSync(
    join(directory, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );

for (const [name, args] of steps) {
  const command = ['pnpm', ...args];
  if (name !== 'install' && summary.checks[0].status !== 'PASS') {
    summary.checks.push({
      name,
      command,
      status: 'SKIPPED',
      reason: 'FROZEN_INSTALL_FAILED',
    });
    save();
    continue;
  }
  const log = join(directory, name + '.log');
  const fd = openSync(log, 'wx', 0o600);
  const start = performance.now();
  try {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      stdio: ['ignore', fd, fd],
      timeout: 600000,
    });
    const check = {
      name,
      command,
      status: result.status === 0 ? 'PASS' : 'FAIL',
      exitCode: result.status,
      signal: result.signal,
      launchError: result.error?.code ?? null,
      durationMs: Math.round(performance.now() - start),
      log: relative(root, log),
    };
    summary.checks.push(check);
    console.log(check.status, name, check.log);
  } finally {
    closeSync(fd);
  }
  save();
}
summary.status = summary.checks.every((check) => check.status === 'PASS')
  ? 'PASS'
  : 'FAIL';
summary.finishedAt = new Date().toISOString();
save();
console.log(summary.status, relative(root, join(directory, 'summary.json')));
if (summary.status !== 'PASS') process.exitCode = 1;
