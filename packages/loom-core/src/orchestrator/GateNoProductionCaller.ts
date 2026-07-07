export interface NoCallerFinding {
  symbol: string;
  file: string;
  callers: string[];
}

export interface NoCallerResult {
  findings: NoCallerFinding[];
  scannedSymbols: string[];
  durationMs: number;
}

// Stub: real implementation delivered by story-082-003.
export function checkNoProductionCallers(_opts: {
  epicDiff: string;
  projectRoot: string;
}): NoCallerResult {
  console.warn('[finalize] noCallers gate is a stub — findings skipped until story-082-003 lands');
  return { findings: [], scannedSymbols: [], durationMs: 0 };
}
