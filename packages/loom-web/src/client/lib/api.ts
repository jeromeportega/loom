/**
 * Authenticated fetch for the loom-web JSON API.
 *
 * `loom web` prints a per-launch token and embeds it in the opening URL's
 * fragment (`/#token=<hex>`); the server requires it on every request as the
 * `x-loom-token` header (or a `?token=` query). BrowserRouter navigations drop
 * the fragment, so we capture the token ONCE at module load and persist it to
 * sessionStorage — every subsequent API call reuses it regardless of the
 * current URL (including a deep-link refresh after the fragment is gone).
 */
function readToken(): string {
  try {
    const fromHash = new URLSearchParams(
      window.location.hash.replace(/^#/, '')
    ).get('token');
    if (fromHash) {
      window.sessionStorage.setItem('loom_token', fromHash);
      return fromHash;
    }
    return window.sessionStorage.getItem('loom_token') ?? '';
  } catch {
    return '';
  }
}

const TOKEN = readToken();

/** fetch() that attaches the loom-web auth token as the `x-loom-token` header. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('x-loom-token', TOKEN);
  return fetch(path, { ...init, headers });
}

/** POST helper: sends JSON body with auth token. Returns raw Response — never throws on non-2xx. */
export function apiPost(path: string, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (TOKEN) headers.set('x-loom-token', TOKEN);
  headers.set('Content-Type', 'application/json');
  return fetch(path, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
