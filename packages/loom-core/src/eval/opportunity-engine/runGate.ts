import { createDatabase } from '../../state/Database.js';
import { AuditLog } from '../../state/AuditLog.js';
import { OpportunityEngine, type OpportunityRecord } from '../../signals/OpportunityEngine.js';
import type { GateOutcome, GateDeps } from '../framework/types.js';
import type { OpportunityEngineCase } from './caseSchema.js';
import type { SignalRecord } from '../../signals/types.js';

/**
 * Drives the production OpportunityEngine over one eval case, observe-only (ADR-002).
 * Each call opens a fresh :memory: db — no operator state is touched (NFR-1).
 * The gateModel is already resolved upstream via deps — not read from env here.
 */
export async function runOpportunityEngineGate(
  c: OpportunityEngineCase,
  deps: GateDeps,
): Promise<GateOutcome<OpportunityRecord[]>> {
  try {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const now = new Date().toISOString();
    const signals: SignalRecord[] = c.signals.map((s, i) => ({
      ...s,
      id: i + 1,
      status: 'open',
      first_seen: now,
      last_seen: now,
    }));
    const engine = new OpportunityEngine({ db, llm: deps.llm, model: deps.gateModel, auditLog });
    const output = await engine.generate(signals);
    return { status: 'ok', output };
  } catch (e) {
    return { status: 'failed', detail: String(e) };
  }
}
