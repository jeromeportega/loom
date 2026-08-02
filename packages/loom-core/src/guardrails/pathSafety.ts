export type RejectionRule =
  | 'null-byte'
  | 'control-char'
  | 'encoded-dot'
  | 'encoded-sep'
  | 'encoded-null'
  | 'url-scheme';

export type PathSafetyResult =
  | { safe: true }
  | { safe: false; reason: string; rule: RejectionRule };

export function checkPathSafety(token: string): PathSafetyResult {
  if (/\x00/.test(token)) {
    return { safe: false, reason: 'token contains a null byte', rule: 'null-byte' };
  }

  if (/[\x00-\x1f\x7f]/.test(token)) {
    return { safe: false, reason: 'token contains a C0 or DEL control character', rule: 'control-char' };
  }

  if (/%2e|%252e/i.test(token)) {
    return { safe: false, reason: 'token contains a percent-encoded dot', rule: 'encoded-dot' };
  }

  if (/%2f|%5c|%252f|%255c/i.test(token)) {
    return { safe: false, reason: 'token contains a percent-encoded path separator', rule: 'encoded-sep' };
  }

  if (/%00|%2500/i.test(token)) {
    return { safe: false, reason: 'token contains a percent-encoded null byte', rule: 'encoded-null' };
  }

  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(token)) {
    return { safe: false, reason: 'token begins with a URI scheme', rule: 'url-scheme' };
  }

  return { safe: true };
}
