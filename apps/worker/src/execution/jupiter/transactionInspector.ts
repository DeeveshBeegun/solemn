import { createHash } from 'node:crypto';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { mintAddressSchema } from '@solemn/shared';

export const computeBudgetProgram =
  'ComputeBudget111111111111111111111111111111';
export const jupiterV6Program = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
// SharedAccountsRoute and SharedAccountsRouteV2 have the same leading account layout.
const sharedRouteDiscriminators = new Set([
  '79eea60b6e928189',
  '7b8dd273f1e50f65',
]);
const tokenPrograms = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const directPrograms = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]);
const result = (
  status: 'INSPECTED' | 'REJECTED' | 'UNSUPPORTED',
  reason: string,
) => ({
  status,
  reason,
  version: null as 0 | 'legacy' | null,
  messageHash: null as string | null,
  transactionHash: null as string | null,
  feePayer: null as string | null,
  blockhash: null as string | null,
  requiredSigners: [] as string[],
  writableAccounts: [] as string[],
  programs: [] as string[],
  routeAccounts: null as {
    inputMint: string;
    outputMint: string;
    sourceTokenAccount: string;
    destinationTokenAccount: string;
  } | null,
  diagnosticSimulationAllowed: false,
});

/** Reports static structure. A recognized Jupiter program does not prove its CPI accounts or token movements. */
export function inspectTransaction(
  base64: string,
  taker: string,
  expectedVersion?: number | null,
  expectedPair?: { inputMint: string; outputMint: string },
) {
  if (!mintAddressSchema.safeParse(taker).success)
    return result('REJECTED', 'INVALID_PUBLIC_TAKER');
  if (expectedVersion != null && expectedVersion !== 0)
    return result('UNSUPPORTED', 'UNSUPPORTED_TRANSACTION_VERSION');
  if (base64.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    return result('REJECTED', 'INVALID_TRANSACTION_ENCODING');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 1232 || bytes.toString('base64') !== base64)
    return result('REJECTED', 'INVALID_TRANSACTION_ENCODING');
  // A one-byte count of one is the only signer envelope this policy accepts.
  if (bytes[0] !== 1)
    return result('REJECTED', 'EXPECTED_SINGLE_SIGNATURE_SLOT');
  if (bytes.length <= 65) return result('REJECTED', 'TRUNCATED_TRANSACTION');
  if (bytes.subarray(1, 65).some((byte) => byte !== 0))
    return result('REJECTED', 'NONZERO_SIGNATURE');
  if ((bytes[65]! & 0x80) !== 0 && bytes[65] !== 0x80)
    return result('UNSUPPORTED', 'UNSUPPORTED_TRANSACTION_VERSION');
  try {
    const [tx, wireEnd] = getTransactionDecoder().read(bytes, 0);
    const [message, messageEnd] = getCompiledTransactionMessageDecoder().read(
      tx.messageBytes,
      0,
    );
    if (
      wireEnd !== bytes.length ||
      messageEnd !== tx.messageBytes.length ||
      (message.version !== 0 && message.version !== 'legacy')
    )
      return result('REJECTED', 'INVALID_TRANSACTION_LENGTH_OR_VERSION');
    const keys = message.staticAccounts;
    const header = message.header;
    const firstReadonly = keys.length - header.numReadonlyNonSignerAccounts;
    if (
      header.numSignerAccounts !== 1 ||
      header.numReadonlySignerAccounts !== 0 ||
      firstReadonly < 1 ||
      new Set(keys).size !== keys.length
    )
      return result('REJECTED', 'INVALID_SIGNER_OR_ACCOUNT_LAYOUT');
    const details = {
      version: message.version,
      messageHash: createHash('sha256')
        .update(Buffer.from(tx.messageBytes))
        .digest('hex'),
      transactionHash: createHash('sha256').update(bytes).digest('hex'),
      feePayer: keys[0] ?? null,
      blockhash: message.lifetimeToken,
      requiredSigners: keys.slice(0, 1),
      writableAccounts: keys.slice(0, firstReadonly),
      programs: [
        ...new Set(
          message.instructions
            .map((instruction) => keys[instruction.programAddressIndex])
            .filter((program) => program !== undefined),
        ),
      ],
    };
    const fail = (status: 'REJECTED' | 'UNSUPPORTED', reason: string) => ({
      ...result(status, reason),
      ...details,
    });
    if (expectedVersion === 0 && message.version !== 0)
      return fail('REJECTED', 'TRANSACTION_VERSION_MISMATCH');
    if (keys[0] !== taker)
      return fail('REJECTED', 'UNEXPECTED_FEE_PAYER_OR_SIGNER');
    if (message.version === 0 && message.addressTableLookups?.length)
      return fail('UNSUPPORTED', 'ADDRESS_LOOKUP_TABLES_UNRESOLVED');
    if (
      !message.lifetimeToken ||
      message.lifetimeToken === '11111111111111111111111111111111'
    )
      return fail('REJECTED', 'MISSING_RECENT_BLOCKHASH');
    let routeAccounts: ReturnType<typeof result>['routeAccounts'] = null;
    const budgetKinds = new Set<number>();
    if (!message.instructions.length)
      return fail('REJECTED', 'NO_INSTRUCTIONS');
    for (const instruction of message.instructions) {
      const program = keys[instruction.programAddressIndex];
      const accounts = instruction.accountIndices ?? [];
      const data = Buffer.from(instruction.data ?? []);
      if (
        !program ||
        instruction.programAddressIndex < firstReadonly ||
        accounts.some((index) => index >= keys.length)
      )
        return fail('REJECTED', 'INVALID_INSTRUCTION_ACCOUNTS');
      if (program === computeBudgetProgram) {
        const kind = data[0];
        if (
          routeAccounts ||
          accounts.length ||
          kind === undefined ||
          budgetKinds.has(kind) ||
          !(
            (kind === 2 &&
              data.length === 5 &&
              data.readUInt32LE(1) > 0 &&
              data.readUInt32LE(1) <= 1400000) ||
            (kind === 3 && data.length === 9)
          )
        )
          return fail('UNSUPPORTED', 'UNVERIFIED_COMPUTE_BUDGET');
        budgetKinds.add(kind);
      } else if (program === jupiterV6Program) {
        if (
          routeAccounts ||
          accounts.length < 11 ||
          accounts[2] !== 0 ||
          !sharedRouteDiscriminators.has(data.subarray(0, 8).toString('hex'))
        )
          return fail('UNSUPPORTED', 'UNVERIFIED_JUPITER_ROUTE_SHAPE');
        const source = accounts[3]!,
          destination = accounts[6]!;
        const inputMint = keys[accounts[7]!],
          outputMint = keys[accounts[8]!];
        if (
          !inputMint ||
          !outputMint ||
          inputMint === outputMint ||
          accounts[7]! < firstReadonly ||
          accounts[8]! < firstReadonly ||
          accounts[0]! < firstReadonly ||
          !tokenPrograms.has(keys[accounts[0]!] ?? '') ||
          source === 0 ||
          destination === 0 ||
          source === destination ||
          source >= firstReadonly ||
          destination >= firstReadonly
        )
          return fail('REJECTED', 'INVALID_SWAP_ACCOUNT_ROLES');
        if (
          expectedPair &&
          (inputMint !== expectedPair.inputMint ||
            outputMint !== expectedPair.outputMint)
        )
          return fail('REJECTED', 'TRANSACTION_MINTS_DO_NOT_MATCH_QUOTE');
        routeAccounts = {
          inputMint,
          outputMint,
          sourceTokenAccount: keys[source]!,
          destinationTokenAccount: keys[destination]!,
        };
      } else if (directPrograms.has(program))
        return fail(
          'UNSUPPORTED',
          'DIRECT_TOKEN_SOL_OR_ATA_INSTRUCTION_UNVERIFIED',
        );
      else return fail('UNSUPPORTED', 'UNKNOWN_PROGRAM');
    }
    if (routeAccounts)
      return {
        ...fail('UNSUPPORTED', 'JUPITER_CPI_AND_TOKEN_ACCOUNTS_UNVERIFIED'),
        routeAccounts,
        diagnosticSimulationAllowed: true,
      };
    return {
      ...result('INSPECTED', 'COMPUTE_BUDGET_ONLY_NO_SWAP'),
      ...details,
      diagnosticSimulationAllowed: true,
    };
  } catch {
    return result('REJECTED', 'TRANSACTION_DECODE_FAILED');
  }
}

export type Inspection = ReturnType<typeof inspectTransaction>;
