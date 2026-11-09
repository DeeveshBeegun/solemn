import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { createDatabase, createSwapAuditRepository } from '@solemn/database';
import { idSchema } from '@solemn/shared';
import { z } from 'zod';
import { loadConfig } from '../../config/index.js';
import { createLogger, safeError } from '../../services/logger.js';
import { ExecutionReadinessService } from '../executionReadiness.js';
import { routerSchema, swapRequestSchema, toBaseUnits } from './amounts.js';
import { JupiterSwapClient } from './jupiterClient.js';
import { inspectTransaction } from './transactionInspector.js';
import { TransactionSimulator } from './transactionSimulator.js';

const usage = [
  'pnpm swap:quote --input-mint MINT --output-mint MINT --input-decimals N --output-decimals N',
  '  (--amount DECIMAL | --base-units INTEGER) [--slippage-bps N] [--exclude-router ROUTER] [--request-id UUID]',
  'pnpm swap:inspect --file PATH',
  'pnpm swap:simulate --file PATH',
  'pnpm swap:readiness --assessment UUID',
].join('\n');
const numberFlag = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,3})$/)
  .transform(Number);
const storedValidity = z.object({
  quote: z
    .object({
      applicationValidUntil: z.iso.datetime(),
      expireAt: z.iso.datetime().nullish(),
    })
    .nullable(),
});

async function readFixture(path: string) {
  const file = await open(path);
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Expected a transaction fixture file');
    const buffer = Buffer.alloc(1700);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead === buffer.length)
      throw new Error('Transaction fixture exceeds size limit');
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await file.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      'input-mint': { type: 'string' },
      'output-mint': { type: 'string' },
      'input-decimals': { type: 'string' },
      'output-decimals': { type: 'string' },
      amount: { type: 'string' },
      'base-units': { type: 'string' },
      'slippage-bps': { type: 'string' },
      'exclude-router': { type: 'string', multiple: true },
      'request-id': { type: 'string' },
      file: { type: 'string' },
      assessment: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(usage + '\n');
    return;
  }
  const action = z
    .enum(['quote', 'inspect', 'simulate', 'readiness'])
    .parse(command);
  const allowed =
    action === 'quote'
      ? [
          'input-mint',
          'output-mint',
          'input-decimals',
          'output-decimals',
          'amount',
          'base-units',
          'slippage-bps',
          'exclude-router',
          'request-id',
        ]
      : action === 'readiness'
        ? ['assessment']
        : ['file'];
  if (Object.keys(values).some((key) => !allowed.includes(key)))
    throw new Error('Option does not apply to this command');
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const print = (value: unknown) =>
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (action === 'inspect' || action === 'simulate') {
    const transaction = await readFixture(z.string().min(1).parse(values.file));
    if (action === 'inspect')
      print(inspectTransaction(transaction, config.JUPITER_TAKER_PUBLIC_KEY));
    else
      print(
        await new TransactionSimulator(config).simulate(
          transaction,
          config.JUPITER_TAKER_PUBLIC_KEY,
        ),
      );
    return;
  }
  const db = createDatabase(config.DATABASE_URL);
  try {
    const repository = createSwapAuditRepository(db.db);
    if (action === 'readiness') {
      const row = await repository.find(idSchema.parse(values.assessment));
      if (!row) {
        print({ status: 'INSUFFICIENT_DATA', reason: 'ASSESSMENT_NOT_FOUND' });
        return;
      }
      const stored = storedValidity.safeParse(row.payload);
      const quote = stored.success ? stored.data.quote : null;
      const expired =
        quote &&
        Date.now() >=
          Math.min(
            Date.parse(quote.applicationValidUntil),
            quote.expireAt ? Date.parse(quote.expireAt) : Infinity,
          );
      const current =
        row.status === 'READY_FOR_DRY_RUN'
          ? expired
            ? { status: 'EXPIRED', reason: 'STORED_QUOTE_EXPIRED' }
            : {
                status: 'INSUFFICIENT_DATA',
                reason: 'HISTORICAL_ASSESSMENT_REQUIRES_FRESH_EVIDENCE',
              }
          : { status: row.status, reason: 'RECORDED_ASSESSMENT' };
      print({ ...current, assessment: row });
      return;
    }
    if ((values.amount === undefined) === (values['base-units'] === undefined))
      throw new Error('Specify exactly one amount representation');
    const inputDecimals = numberFlag.parse(values['input-decimals']);
    const request = swapRequestSchema.parse({
      inputMint: values['input-mint'],
      outputMint: values['output-mint'],
      inputDecimals,
      outputDecimals: numberFlag.parse(values['output-decimals']),
      amount:
        values.amount === undefined
          ? values['base-units']
          : toBaseUnits(values.amount, inputDecimals),
      slippageBps:
        values['slippage-bps'] === undefined
          ? undefined
          : numberFlag.parse(values['slippage-bps']),
      excludeRouters: values['exclude-router']?.map((router) =>
        routerSchema.parse(router),
      ),
    });
    logger.info(
      { source: 'JUPITER_V2', enabled: config.JUPITER_SWAP_ENABLED },
      'Jupiter quote client started',
    );
    const service = new ExecutionReadinessService(
      config,
      new JupiterSwapClient(config),
      repository,
      config.JUPITER_RPC_SIMULATION_ENABLED
        ? new TransactionSimulator(config)
        : undefined,
      Date.now,
      logger,
    );
    print(await service.observe(request, values['request-id'] ?? randomUUID()));
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('/execution/jupiter/cli.js')) {
  dotenv({ quiet: true });
  void main().catch((error: unknown) => {
    createLogger('info').error(
      safeError(error),
      'Swap command failed. Check arguments, configuration and migrations. Use --help for usage.',
    );
    process.exitCode = 1;
  });
}
