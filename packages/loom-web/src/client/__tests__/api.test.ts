// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// TOKEN is captured at module load time from sessionStorage (or the URL hash).
// We seed sessionStorage before each dynamic import so the captured value is
// known and non-empty for all assertions.
const SEEDED_TOKEN = 'test-token-abc123';

async function loadApi() {
  vi.resetModules();
  return import('../lib/api');
}

beforeEach(() => {
  window.sessionStorage.setItem('loom_token', SEEDED_TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('apiPost', () => {
  it('sends method POST, Content-Type application/json, and x-loom-token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { apiPost } = await loadApi();
    await apiPost('/api/some-endpoint');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/some-endpoint');
    expect(init.method).toBe('POST');

    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('x-loom-token')).toBe(SEEDED_TOKEN);
  });

  it('serializes the body argument as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { apiPost } = await loadApi();
    const payload = { reason: 'needs work', clean: true };
    await apiPost('/api/epics/epic-001/reject', payload);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify(payload));
  });

  it('sends undefined body (no throw) when no body argument is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { apiPost } = await loadApi();
    await expect(apiPost('/api/stop')).resolves.not.toThrow();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('returns the raw Response without throwing on a non-2xx status', async () => {
    const errorResponse = { ok: false, status: 422 } as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse));

    const { apiPost } = await loadApi();
    const result = await apiPost('/api/epics/epic-001/approve');

    expect(result).toBe(errorResponse);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
  });
});

describe('apiFetch (existing GET callers unaffected)', () => {
  it('fires a GET with no Content-Type or x-loom-token mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ repos: [] }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { apiFetch } = await loadApi();
    await apiFetch('/api/repos');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    // default method is GET (no explicit method set)
    expect(init?.method).toBeUndefined();

    const headers = new Headers((init as RequestInit | undefined)?.headers as HeadersInit | undefined);
    expect(headers.get('Content-Type')).toBeNull();
    // token IS set on apiFetch (that's its purpose) — assert it still works
    expect(headers.get('x-loom-token')).toBe(SEEDED_TOKEN);
  });

  it('accepts a caller-supplied init without altering method or adding Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { apiFetch } = await loadApi();
    await apiFetch('/api/repos', { method: 'GET', headers: { 'Accept': 'application/json' } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('Content-Type')).toBeNull();
    expect(headers.get('Accept')).toBe('application/json');
  });
});

// EventSource cannot set request headers, so the SSE URL must carry the token as
// a query param — otherwise every live-log connection 401s in default token mode.
describe('eventSourceUrl', () => {
  it('appends the auth token as a ?token= query param', async () => {
    const { eventSourceUrl } = await loadApi();
    expect(eventSourceUrl('/api/events')).toBe(`/api/events?token=${SEEDED_TOKEN}`);
  });

  it('uses & as the separator when the path already has a query string', async () => {
    const { eventSourceUrl } = await loadApi();
    expect(eventSourceUrl('/api/events?since=5')).toBe(`/api/events?since=5&token=${SEEDED_TOKEN}`);
  });

  it('URL-encodes the token', async () => {
    window.sessionStorage.setItem('loom_token', 'a b+c/d');
    const { eventSourceUrl } = await loadApi();
    expect(eventSourceUrl('/api/events')).toBe('/api/events?token=a%20b%2Bc%2Fd');
  });

  it('returns the bare path when no token is present (read-only mode)', async () => {
    window.sessionStorage.clear();
    const { eventSourceUrl } = await loadApi();
    expect(eventSourceUrl('/api/events')).toBe('/api/events');
  });
});
