import { createHash } from 'node:crypto';

export const AUDIT_GENESIS_HASH: string = '0'.repeat(64);

export function canonicalPayload(
  id: number,
  agent_id: string | null,
  action: string,
  command: string | null,
  allowed: number | null,
  policy_rule: string | null,
  detail: string | null,
  contract_hash: null,
  timestamp: string,
  prev_hash: string,
): string {
  return JSON.stringify([
    id, agent_id, action, command, allowed, policy_rule, detail, null, timestamp, prev_hash,
  ]);
}

export function computeEntryHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}
