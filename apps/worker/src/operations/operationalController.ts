import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  forwardAccounts,
  operationalAuditEvents,
  operationalIncidents,
} from '@solemn/database';
import type {
  Database,
  OperationalHealth,
  OperationalState,
} from '@solemn/database';
import { stableId } from '@solemn/shared';

export type OperationAccount = typeof forwardAccounts.$inferSelect;
export type Severity = typeof operationalAuditEvents.$inferSelect.severity;
const transitions: Record<OperationalState, readonly OperationalState[]> = {
  STARTING: ['RECOVERING', 'PAUSED', 'HALTED', 'STOPPING'],
  RECOVERING: ['RUNNING', 'DEGRADED', 'PAUSED', 'HALTED', 'STOPPING'],
  RUNNING: ['RECOVERING', 'DEGRADED', 'PAUSED', 'HALTED', 'STOPPING'],
  DEGRADED: ['RECOVERING', 'RUNNING', 'PAUSED', 'HALTED', 'STOPPING'],
  PAUSED: ['RECOVERING', 'HALTED'],
  HALTED: ['RECOVERING'],
  STOPPING: ['RECOVERING', 'STOPPED', 'PAUSED', 'HALTED'],
  STOPPED: ['RECOVERING', 'PAUSED', 'HALTED'],
};

export function runtimeState(
  current: OperationalState,
  proposed: OperationalState,
) {
  return current === 'HALTED' || current === 'PAUSED' ? current : proposed;
}

export async function auditOperation(
  db: Database,
  row: OperationAccount,
  event: {
    kind: string;
    reason: string;
    key: string;
    at: string;
    severity: Severity;
    actor: string;
    source: string;
    details?: Record<string, unknown>;
  },
) {
  const id = stableId([
    'operational-audit-v1',
    row.portfolioId,
    event.kind,
    event.key,
  ]);
  await db
    .insert(operationalAuditEvents)
    .values({
      id,
      portfolioId: row.portfolioId,
      sessionId: row.sessionId,
      kind: event.kind,
      reason: event.reason,
      at: event.at,
      severity: event.severity,
      actor: event.actor,
      source: event.source,
      details: event.details ?? {},
    })
    .onConflictDoNothing();
  return id;
}

/** Caller holds the forward account row lock throughout the enclosing transaction. */
export async function transitionOperations(
  db: Database,
  row: OperationAccount,
  status: OperationalState,
  reason: string,
  actor: string,
  source: 'WORKER' | 'ADMIN' | 'OWNERSHIP',
) {
  if (row.status === status) return row;
  if (
    !transitions[row.status].includes(status) ||
    (row.status === 'HALTED' && source !== 'ADMIN')
  )
    throw new Error('Invalid operational state transition');
  const at = new Date().toISOString(),
    version = row.opsVersion + 1;
  const [updated] = await db
    .update(forwardAccounts)
    .set({
      status,
      paused: status === 'PAUSED',
      opsReason: reason,
      opsActor: actor,
      opsUpdatedAt: at,
      opsVersion: version,
    })
    .where(
      and(
        eq(forwardAccounts.portfolioId, row.portfolioId),
        eq(forwardAccounts.opsVersion, row.opsVersion),
      ),
    )
    .returning();
  if (!updated) throw new Error('Operational state version changed');
  await auditOperation(db, updated, {
    kind: status === 'HALTED' ? 'EMERGENCY_HALT' : 'STATE_CHANGED',
    key: String(version),
    reason,
    at,
    actor,
    source,
    severity:
      status === 'HALTED'
        ? 'CRITICAL'
        : status === 'DEGRADED'
          ? 'WARNING'
          : 'INFO',
    details: { previous: row.status, status, version },
  });
  return updated;
}

export async function setOperationalHealth(
  db: Database,
  row: OperationAccount,
  health: OperationalHealth,
) {
  const [updated] = await db
    .update(forwardAccounts)
    .set({ health, heartbeatAt: health.checkedAt })
    .where(eq(forwardAccounts.portfolioId, row.portfolioId))
    .returning();
  if (!updated) throw new Error('Missing operational account');
  return updated;
}

/** One alert per active category. Its immutable audit event is also the durable local alert. */
export async function openIncident(
  db: Database,
  row: OperationAccount,
  category: string,
  severity: Severity,
  actor = 'worker',
  source = 'WORKER',
) {
  const [active] = await db
    .select()
    .from(operationalIncidents)
    .where(
      and(
        eq(operationalIncidents.portfolioId, row.portfolioId),
        eq(operationalIncidents.category, category),
        isNull(operationalIncidents.resolvedAt),
      ),
    )
    .limit(1);
  if (active) return active.id;
  const at = new Date().toISOString();
  const id = randomUUID();
  await db.insert(operationalIncidents).values({
    id,
    portfolioId: row.portfolioId,
    category,
    severity,
    openedAt: at,
  });
  await auditOperation(db, row, {
    kind: 'ALERT_RAISED',
    key: id,
    reason: category,
    at,
    severity,
    actor,
    source,
    details: { incidentId: id },
  });
  return id;
}

export async function resolveIncidents(
  db: Database,
  row: OperationAccount,
  resolution: string,
  actor: string,
  category?: string,
) {
  const at = new Date().toISOString();
  const resolved = await db
    .update(operationalIncidents)
    .set({ resolvedAt: at, resolution })
    .where(
      and(
        eq(operationalIncidents.portfolioId, row.portfolioId),
        isNull(operationalIncidents.resolvedAt),
        category ? eq(operationalIncidents.category, category) : undefined,
      ),
    )
    .returning({
      id: operationalIncidents.id,
      category: operationalIncidents.category,
    });
  for (const incident of resolved)
    await auditOperation(db, row, {
      kind: 'INCIDENT_RESOLVED',
      key: incident.id,
      reason: incident.category,
      at,
      severity: 'INFO',
      actor,
      source: category ? 'WORKER' : 'ADMIN',
      details: { incidentId: incident.id, resolution },
    });
}
