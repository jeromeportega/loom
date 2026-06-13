import Database from 'better-sqlite3';
import { SignalStore } from './SignalStore.js';
import { OpportunityEngine } from './OpportunityEngine.js';
import { OpportunityStore } from './OpportunityStore.js';
import { defaultScanners } from './scanners/index.js';
import type { SignalScanner } from './SignalScanner.js';
import type { OpportunityRecord } from './OpportunityEngine.js';
import type { LLMClient } from '../llm/LLMClient.js';
import type { AuditLog } from '../state/AuditLog.js';

export interface ScanResult {
  signalsObserved: number;
  signalsStaled: number;
  opportunities: OpportunityRecord[];
}

/** Orchestrates one full scan: run scanners → persist signals → one LLM clustering call → persist opportunities. */
export async function runScan(deps: {
  db: Database.Database;
  projectRoot: string;
  llm: LLMClient;
  model: string;
  auditLog: AuditLog;
  scanners?: SignalScanner[];
}): Promise<ScanResult> {
  const { db, projectRoot, llm, model, auditLog } = deps;
  const scanners = deps.scanners ?? defaultScanners();

  const signalStore = new SignalStore(db);
  const opportunityStore = new OpportunityStore(db);
  const engine = new OpportunityEngine({ db, llm, model, auditLog });

  // Run all scanners concurrently; each MUST NOT throw (SignalScanner contract)
  const allSignals = (
    await Promise.all(scanners.map((s) => s.scan({ db, projectRoot, auditLog })))
  ).flat();

  // Persist signals with UPSERT-on-key dedup semantics
  const { inserted, refreshed } = signalStore.upsertMany(allSignals);

  // Mark open signals not observed this scan as stale
  const observedKeys = allSignals.map((s) => s.key);
  const signalsStaled = signalStore.reconcile(observedKeys);

  // Get capped open set for clustering
  const openSignals = signalStore.listOpen();

  // Exactly ONE batched LLM call over the capped open-signal set (ADR-002)
  const generatedOpportunities = await engine.generate(openSignals);

  // Persist: refresh open keys, insert new keys, leave scoped/dismissed untouched (ADR-004)
  opportunityStore.upsertRanked(generatedOpportunities);

  // One audit row for the whole scan
  auditLog.record({
    action: 'signal_scan',
    detail: {
      signalsObserved: allSignals.length,
      inserted,
      refreshed,
      signalsStaled,
      opportunitiesGenerated: generatedOpportunities.length,
      sources: [...new Set(allSignals.map((s) => s.source))],
    },
  });

  // Return persisted opportunities (with real db ids from the upsert)
  const opportunities = opportunityStore.listRanked();

  return {
    signalsObserved: allSignals.length,
    signalsStaled,
    opportunities,
  };
}
