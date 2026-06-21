import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { SignalRecord } from './types.js';
import type { LLMClient } from '../llm/LLMClient.js';
import type { AuditLog } from '../state/AuditLog.js';

export function scoreOf(impact: number, confidence: number, effort: number): number {
  return (impact * confidence) / Math.max(effort, 0.1);
}

export function opportunityKey(memberKeys: string[]): string {
  const sorted = [...memberKeys].sort();
  // \0 separator avoids hash collisions between ['a','bc'] and ['ab','c']
  return crypto.createHash('sha1').update(sorted.join('\0')).digest('hex');
}

export interface OpportunityRecord {
  id: number;
  key: string;
  title: string;
  rationale: string;
  impact: number;
  effort: number;
  confidence: number;
  score: number;
  rank: number;
  status: 'open' | 'scoped' | 'dismissed';
  signal_count: number;
  member_keys: string[];
  evidence: { title: string; url: string }[];
  scoped_epic_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClusterProposal {
  title: string;
  signal_ids: number[];
  impact: number;
  effort: number;
  confidence: number;
  rationale: string;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const CLUSTER_SYSTEM_PROMPT = `You are a software engineering opportunity analyst. Cluster the given signals into opportunities for improvement.

Return ONLY a JSON array. Each element must have:
- title: string
- signal_ids: number[] (ids from the input list, must be non-empty)
- impact: number in [0,1]
- effort: number in [0,1]
- confidence: number in [0,1]
- rationale: string

Return [] if no meaningful clusters exist. Return ONLY the JSON array, no other text.`;

function parseClusterProposals(text: string): ClusterProposal[] {
  // Strip markdown code fences if present
  const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
  return parsed as ClusterProposal[];
}

export class OpportunityEngine {
  private db: Database.Database;
  private llm: LLMClient;
  private model: string;
  private auditLog: AuditLog;

  constructor(opts: {
    db: Database.Database;
    llm: LLMClient;
    model: string;
    auditLog: AuditLog;
  }) {
    this.db = opts.db;
    this.llm = opts.llm;
    this.model = opts.model;
    this.auditLog = opts.auditLog;
  }

  async generate(openSignals: SignalRecord[]): Promise<OpportunityRecord[]> {
    if (openSignals.length === 0) return [];

    // Build batch-local id → durable signal.key map (ADR-005)
    const idToKey = new Map<number, string>(openSignals.map((s) => [s.id, s.key]));
    const idToRecord = new Map<number, SignalRecord>(openSignals.map((s) => [s.id, s]));

    const signalList = openSignals
      .map(
        (s) =>
          `id=${s.id} key="${s.key}" title="${s.title}"${s.detail ? ` detail="${s.detail}"` : ''}`
      )
      .join('\n');

    const userPrompt = `Cluster these ${openSignals.length} signals into opportunities:\n\n${signalList}`;

    // Exactly ONE batched LLM call over the capped open-signal set (ADR-002)
    const resp1 = await this.llm.complete({
      model: this.model,
      system: [{ text: CLUSTER_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 4096,
      nonAgentic: { excludeDynamicSections: true },
    });

    let proposals: ClusterProposal[] | null = null;
    try {
      proposals = parseClusterProposals(resp1.text);
    } catch {
      // Malformed JSON — exactly one repair re-prompt, then skip without failing (FR-10)
      const resp2 = await this.llm.complete({
        model: this.model,
        system: [{ text: CLUSTER_SYSTEM_PROMPT, cache: true }],
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: resp1.text },
          {
            role: 'user',
            content:
              'Your previous response was not valid JSON. Return ONLY the JSON array of cluster objects, no other text.',
          },
        ],
        maxTokens: 4096,
        nonAgentic: { excludeDynamicSections: true },
      });
      try {
        proposals = parseClusterProposals(resp2.text);
      } catch {
        // Both attempts failed — skip opportunity generation, scan continues (FR-10)
        return [];
      }
    }

    const raw: Array<Omit<OpportunityRecord, 'id'>> = [];
    for (const p of proposals) {
      // Drop unknown signal_ids (FR-10)
      const validIds = p.signal_ids.filter((id) => idToKey.has(id));
      // Skip empty clusters (FR-10)
      if (validIds.length === 0) continue;

      // Resolve batch-local ids to durable signal.key values before hashing (ADR-005)
      const memberKeys = validIds.map((id) => idToKey.get(id)!);
      const key = opportunityKey(memberKeys);

      // Clamp all scores to [0,1] (FR-10)
      const impact = clamp01(p.impact);
      const effort = clamp01(p.effort);
      const confidence = clamp01(p.confidence);
      const score = scoreOf(impact, confidence, effort);

      // Build evidence links from signal records that have evidenceUrl
      const evidence = validIds
        .map((id) => idToRecord.get(id)!)
        .filter((r) => r.evidenceUrl)
        .map((r) => ({ title: r.title, url: r.evidenceUrl! }));

      const now = new Date().toISOString();
      raw.push({
        key,
        title: p.title,
        rationale: p.rationale,
        impact,
        effort,
        confidence,
        score,
        rank: 0, // assigned below after sorting
        status: 'open',
        signal_count: validIds.length,
        member_keys: memberKeys,
        evidence,
        scoped_epic_id: null,
        created_at: now,
        updated_at: now,
      });
    }

    // Assign descending ranks: rank 1 = highest score (NFR-5 determinism)
    raw.sort((a, b) => b.score - a.score);
    for (let i = 0; i < raw.length; i++) {
      raw[i].rank = i + 1;
    }

    // id is 0 until persisted by OpportunityStore.upsertRanked
    return raw.map((o) => ({ ...o, id: 0 }));
  }
}
