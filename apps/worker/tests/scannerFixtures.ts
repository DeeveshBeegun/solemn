import { LATER, MINT, NOW, OTHER_MINT } from '../../../tests/fixtures.js';

// Sanitized shapes of observed creation and migration messages; addresses and labels
// are replaced with deterministic fixtures. Optional poolAddress is a synthetic extension.
export const launch = {
  txType: 'create',
  mint: MINT,
  signature: '1'.repeat(64),
  name: 'Fixture token',
  symbol: 'FIX',
  bondingCurveKey: OTHER_MINT,
  traderPublicKey: OTHER_MINT,
  pool: 'pump',
  initialBuy: 0.1,
  additionalProviderField: { preserved: true },
};
export const observedMigration = {
  txType: 'migrate',
  mint: MINT,
  signature: '1'.repeat(64),
  pool: 'pump-amm',
};
export const migration = {
  ...observedMigration,
  poolAddress: OTHER_MINT,
};
export const launchRaw = JSON.stringify(launch);
export const migrationRaw = JSON.stringify(migration);
export const creationAck = JSON.stringify({
  message: 'Successfully subscribed to token creation events.',
});
export const migrationAck = JSON.stringify({
  message: "Subscribed to 'migration' events.",
});
export { NOW, LATER, MINT, OTHER_MINT };
