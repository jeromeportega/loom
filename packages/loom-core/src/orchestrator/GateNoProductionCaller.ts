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
  return { findings: [], scannedSymbols: [], durationMs: 0 };
}
