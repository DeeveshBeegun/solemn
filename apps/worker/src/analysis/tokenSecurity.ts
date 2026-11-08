import { parse } from 'lossless-json';
import { z } from 'zod';
import { address, isNone } from '@solana/kit';
import {
  getMintDecoder,
  getMintSize,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  ExtensionType,
  getExtensionDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { mintAddressSchema, mintSecuritySchema } from '@solemn/shared';
import type { MintSecurity } from '@solemn/shared';
import type { Config } from '../config/index.js';
import { HttpReader, ProviderError, providerError } from './httpReader.js';
import { emptySecurity } from './observations.js';

export const SPL_TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
export const TOKEN_2022_PROGRAM = String(TOKEN_2022_PROGRAM_ADDRESS);
const MINT_SIZE = getMintSize();
const accountSchema = z.object({
  owner: mintAddressSchema,
  executable: z.boolean(),
  lamports: z
    .string()
    .regex(/^\d{1,16}$/)
    .refine(
      (value) =>
        /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
    ),
  data: z.tuple([
    z
      .string()
      .max(1048576)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
    z.literal('base64'),
  ]),
});
const rpcResult = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.literal('solemn-risk'),
  result: z.object({
    context: z.object({ slot: z.string().regex(/^\d{1,20}$/) }),
    value: z.array(accountSchema.nullable()).max(100),
  }),
});
type RpcAccount = z.infer<typeof accountSchema>;
const forbidden = new Set<number>([
  ExtensionType.PermanentDelegate,
  ExtensionType.TransferHook,
  ExtensionType.TransferFeeConfig,
  ExtensionType.NonTransferable,
  ExtensionType.DefaultAccountState,
  ExtensionType.PausableConfig,
  ExtensionType.PermissionedBurn,
]);

/** Decode the official SPL mint layout; extension presence is a screening policy, not a fraud claim. */
export function inspectMint(
  mint: string,
  account: RpcAccount | null,
  checkedAt: string,
  contextSlot: string,
): MintSecurity {
  const result = emptySecurity(mint, checkedAt);
  result.contextSlot = contextSlot;
  if (account === null) return result;
  result.state = 'OK';
  result.tokenProgram = account.owner;
  result.accountDataBase64 = account.data[0];
  if (![SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(account.owner)) {
    result.validMint = false;
    result.issues = ['UNSUPPORTED_TOKEN_PROGRAM'];
    return result;
  }
  try {
    const data = Buffer.from(account.data[0], 'base64');
    if (
      account.executable ||
      data.length < MINT_SIZE ||
      data[45] !== 1 ||
      ![0, 1].includes(data.readUInt32LE(0)) ||
      ![0, 1].includes(data.readUInt32LE(46)) ||
      (account.owner === SPL_TOKEN_PROGRAM && data.length !== MINT_SIZE)
    )
      throw new Error('Invalid mint layout');
    address(mint);
    address(account.owner);
    if (
      data.length > MINT_SIZE &&
      (data.length < 166 ||
        data[165] !== 1 ||
        data.subarray(82, 165).some((value) => value !== 0))
    )
      throw new Error('Invalid extended mint prefix');
    const decoded = getMintDecoder().decode(data.subarray(0, MINT_SIZE));
    result.validMint = decoded.isInitialized;
    result.decimals = decoded.decimals;
    result.supplyBaseUnits = decoded.supply.toString();
    result.mintAuthorityDisabled = isNone(decoded.mintAuthority);
    result.freezeAuthorityDisabled = isNone(decoded.freezeAuthority);
    result.supportedExtensions = true;
    const seen = new Set<number>();
    const tlvData =
      data.length > MINT_SIZE ? data.subarray(166) : Buffer.alloc(0);
    for (let offset = 0; offset < tlvData.length;) {
      const remainder = tlvData.subarray(offset);
      if (remainder.every((value) => value === 0)) break; // Official allocation padding, not a capability.
      if (remainder.length < 4) throw new Error('Truncated extension header');
      const type = remainder.readUInt16LE(0),
        length = remainder.readUInt16LE(2);
      if (
        length + 4 > remainder.length ||
        seen.has(type) ||
        type === ExtensionType.Uninitialized
      )
        throw new Error('Invalid TLV framing');
      seen.add(type);
      const name = ExtensionType[type] ?? `Unknown_${type}`;
      const policy =
        type === ExtensionType.MetadataPointer
          ? 'ALLOW'
          : forbidden.has(type)
            ? 'REJECT'
            : 'UNKNOWN';
      if (policy !== 'UNKNOWN') {
        const [extension, consumed] = getExtensionDecoder().read(
          remainder.subarray(0, 4 + length),
          0,
        );
        if (consumed !== length + 4 || extension.__kind !== name)
          throw new Error('Invalid extension size');
      }
      result.extensions.push({ type, name, policy });
      offset += 4 + length;
    }
    result.supportedExtensions = result.extensions.some(
      (extension) => extension.policy === 'REJECT',
    )
      ? false
      : result.extensions.some((extension) => extension.policy === 'UNKNOWN')
        ? null
        : true;
  } catch {
    // A malformed extension cannot become an assertion that authorities were revoked.
    result.validMint = result.validMint === true ? null : false;
    result.mintAuthorityDisabled = null;
    result.freezeAuthorityDisabled = null;
    result.supportedExtensions = null;
    result.issues.push('INVALID_MINT_DATA');
  }
  return mintSecuritySchema.parse(result);
}

export interface SecurityClient {
  getMany(
    mints: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, MintSecurity>>;
}
export class TokenSecurityClient implements SecurityClient {
  private readonly reader: HttpReader;
  constructor(
    private readonly config: Config,
    fetcher: typeof fetch = fetch,
    onRateLimit: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.reader = new HttpReader(
      config,
      config.RISK_RPC_REQUEST_INTERVAL_MS,
      fetcher,
      onRateLimit,
      now,
    );
  }
  async getMany(
    input: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, MintSecurity>> {
    const mints = [
      ...new Set(input.map((mint) => mintAddressSchema.parse(mint))),
    ];
    if (mints.length > 1000)
      throw new Error('RPC batch admission exceeds 1000 mints');
    const output = new Map<string, MintSecurity>();
    for (let offset = 0; offset < mints.length; offset += 100) {
      const batch = mints.slice(offset, offset + 100);
      try {
        const response = await this.reader.request(
          this.config.SOLANA_RPC_URL,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'solemn-risk',
              method: 'getMultipleAccounts',
              params: [batch, { encoding: 'base64', commitment: 'confirmed' }],
            }),
          },
          signal,
        );
        let raw: unknown;
        try {
          raw = parse(response.body, undefined, (value) => value);
        } catch {
          throw new ProviderError({
            code: 'INVALID_RESPONSE',
            httpStatus: 200,
            retryAt: null,
          });
        }
        if (raw && typeof raw === 'object' && 'error' in raw)
          throw new ProviderError({
            code: 'RPC_ERROR',
            httpStatus: 200,
            retryAt: null,
          });
        const parsed = rpcResult.safeParse(raw);
        if (!parsed.success || parsed.data.result.value.length !== batch.length)
          throw new ProviderError({
            code: 'INVALID_RESPONSE',
            httpStatus: 200,
            retryAt: null,
          });
        batch.forEach((mint, index) =>
          output.set(
            mint,
            inspectMint(
              mint,
              parsed.data.result.value[index] ?? null,
              response.receivedAt,
              parsed.data.result.context.slot,
            ),
          ),
        );
      } catch (error) {
        for (const mint of batch)
          output.set(mint, {
            ...emptySecurity(mint, new Date(this.now()).toISOString()),
            state: 'ERROR',
            error: providerError(error),
          });
      }
    }
    return output;
  }
}
