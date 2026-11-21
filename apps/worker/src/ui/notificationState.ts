export type EligibilityItem = {
  mint: string;
  assessedAt: string;
  validUntil: string;
};
export type EligibilityMemory = Record<
  string,
  {
    active: boolean;
    validUntil: string;
    seenAt: number;
  }
>;

/** Detect transitions, including re-entry, while keeping continuous renewals quiet. */
export function updateEligibility<T extends EligibilityItem>(
  previous: EligibilityMemory,
  snapshot: { checkedAt: string; truncated: boolean; tokens: T[] },
) {
  const now = Date.parse(snapshot.checkedAt);
  const current = new Set(snapshot.tokens.map((token) => token.mint));
  const state: EligibilityMemory = {};
  for (const [mint, item] of Object.entries(previous)) {
    if (!item || !Number.isFinite(item.seenAt) || now - item.seenAt > 172800000)
      continue;
    state[mint] = {
      ...item,
      active:
        item.active &&
        (current.has(mint) ||
          (snapshot.truncated && Date.parse(item.validUntil) > now)),
    };
  }
  const arrivals: T[] = [];
  for (const token of snapshot.tokens) {
    if (
      Date.parse(token.validUntil) <= now ||
      Date.parse(token.assessedAt) > now
    )
      continue;
    const prior = previous[token.mint];
    const continuous =
      prior?.active &&
      Date.parse(token.assessedAt) <= Date.parse(prior.validUntil);
    if (!continuous) arrivals.push(token);
    state[token.mint] = {
      active: true,
      validUntil: token.validUntil,
      seenAt: now,
    };
  }
  // Bound browser storage independently of database retention.
  const entries = Object.entries(state)
    .sort((a, b) => b[1].seenAt - a[1].seenAt)
    .slice(0, 2000);
  return { state: Object.fromEntries(entries), arrivals };
}

export type PaperEntryMemory = { seen: Record<string, number> };

/** Baseline existing history once, then notify once per account/candidate identity. */
export function updatePaperEntries<T extends { id: string }>(
  previous: PaperEntryMemory | null,
  snapshot: { checkedAt: string; entries: T[] },
) {
  const now = Date.parse(snapshot.checkedAt);
  const seen = Object.fromEntries(
    Object.entries(previous?.seen ?? {}).filter(
      ([, at]) => Number.isFinite(at) && now - at < 172800000,
    ),
  );
  const arrivals = previous
    ? snapshot.entries.filter((entry) => !Object.hasOwn(seen, entry.id))
    : [];
  for (const entry of snapshot.entries) seen[entry.id] = now;
  return {
    state: {
      seen: Object.fromEntries(
        Object.entries(seen)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3000),
      ),
    },
    arrivals,
  };
}
