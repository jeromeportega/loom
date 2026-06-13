import type { SignalScanner } from '../SignalScanner.js';
import { AuditIntrospectionScanner } from './AuditIntrospectionScanner.js';
import { CodeDebtScanner } from './CodeDebtScanner.js';
import { GithubIssuesScanner } from './GithubIssuesScanner.js';

export { AuditIntrospectionScanner } from './AuditIntrospectionScanner.js';
export { CodeDebtScanner, CODE_DEBT_CAP } from './CodeDebtScanner.js';
export { GithubIssuesScanner } from './GithubIssuesScanner.js';
export type { SpawnFn } from './GithubIssuesScanner.js';

/** Returns the three real scanners in deterministic order. */
export function defaultScanners(): SignalScanner[] {
  return [
    new AuditIntrospectionScanner(),
    new CodeDebtScanner(),
    new GithubIssuesScanner(),
  ];
}
