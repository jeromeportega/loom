import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { EpicsResponse, EpicStatus, PlanningArtifacts, StoriesResponse } from '../../shared/types';
import { makeQueryResult } from '../testUtils';
import { EpicDetail } from '../views/EpicDetail';
import { queryKeys } from '../lib/queryKeys';
import * as useEpicsModule from '../hooks/useEpics';
import * as useStoriesModule from '../hooks/useStories';
import * as apiModule from '../lib/api';

vi.mock('../hooks/useEpics');
vi.mock('../hooks/useStories');
vi.mock('../lib/api');
vi.mock('../views/StoryList', () => ({
  StoryList: () => <div data-testid="story-list-mock" />,
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockArtifacts: PlanningArtifacts = {
  epic_id: 'epic-001',
  paths: {
    brief: '/epics/brief.md',
    prd: '/epics/prd.md',
    epic_yaml: '/epics/epic.yaml',
    architecture: '/epics/arch.md',
  },
  brief: 'This is the brief content',
  prd: 'This is the PRD content',
  architecture: 'This is the architecture content',
  epic_yaml: 'epic_id: epic-001\nstories: []',
};

function makeEpic(overrides: Partial<EpicStatus> = {}): EpicStatus {
  return {
    id: 'epic-001',
    title: 'Test Epic',
    status: 'planned',
    planning_phase: null,
    stories: { total: 0, done: 0, failed: 0, blocked: 0, pending: 0, running: 0 },
    updated_at: '2026-01-01T00:00:00.000Z',
    project_name: 'my-repo',
    project_root: '/projects/my-repo',
    is_current_project: true,
    archived: false,
    intake_verdict: null,
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
}

function renderEpicDetail(slug = 'my-repo', epicId = 'epic-001', qc?: QueryClient) {
  const client = qc ?? makeClient();
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/repo/${slug}/epic/${epicId}`]}>
        <Routes>
          <Route path="/repo/:slug/epic/:epicId" element={<EpicDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, client };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(useEpicsModule.useEpics).mockReturnValue(
    makeQueryResult<EpicsResponse>({
      data: { epics: [makeEpic({ status: 'planned' })] },
      isLoading: false,
      isSuccess: true,
      status: 'success',
    })
  );

  vi.mocked(useStoriesModule.useStories).mockReturnValue(
    makeQueryResult<StoriesResponse>({
      data: { epic_id: 'epic-001', stories: [] },
      isLoading: false,
      isSuccess: true,
      status: 'success',
    })
  );

  vi.mocked(apiModule.apiFetch).mockImplementation(async (path: string) => {
    if (path.includes('planning-artifacts')) {
      return { ok: true, json: async () => mockArtifacts } as Response;
    }
    return { ok: true, json: async () => ({ epic_id: 'epic-001', stories: [] }) } as Response;
  });

  vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: true, status: 200 } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── queryKeys.planningArtifacts ─────────────────────────────────────────────

describe('queryKeys.planningArtifacts', () => {
  it('returns the correct key array', () => {
    expect(queryKeys.planningArtifacts('my-repo', 'epic-001')).toEqual([
      'repos',
      'my-repo',
      'epic-001',
      'planning-artifacts',
    ]);
  });
});

// ─── Artifact rendering ───────────────────────────────────────────────────────

describe('EpicDetail — artifact rendering', () => {
  it('calls apiFetch with planning-artifacts path when status is planned', async () => {
    renderEpicDetail();

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
        '/api/epics/epic-001/planning-artifacts'
      );
    });
  });

  it('renders brief, PRD, architecture, and YAML text from mocked response', async () => {
    renderEpicDetail();

    expect(await screen.findByTestId('artifact-brief')).not.toBeNull();
    expect(screen.getByTestId('artifact-brief').textContent).toContain('This is the brief content');
    expect(screen.getByTestId('artifact-prd').textContent).toContain('This is the PRD content');
    expect(screen.getByTestId('artifact-architecture').textContent).toContain(
      'This is the architecture content'
    );
    expect(screen.getByTestId('artifact-yaml').textContent).toContain('epic_id: epic-001');
  });

  it('renders gracefully when artifact fields are null', async () => {
    vi.mocked(apiModule.apiFetch).mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        ...mockArtifacts,
        brief: null,
        prd: null,
        architecture: null,
        epic_yaml: null,
      } satisfies PlanningArtifacts),
    } as Response));

    expect(() => renderEpicDetail()).not.toThrow();

    expect(await screen.findByTestId('artifact-brief')).not.toBeNull();
    expect(screen.getByTestId('artifact-brief').textContent).toContain('(not available)');
    expect(screen.getByTestId('artifact-prd').textContent).toContain('(not available)');
    expect(screen.getByTestId('artifact-architecture').textContent).toContain('(not available)');
    expect(screen.getByTestId('artifact-yaml').textContent).toContain('(not available)');
  });

  it('does NOT call apiFetch for planning-artifacts when status is not planned', async () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'in_progress' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicDetail();

    await act(async () => {});
    expect(vi.mocked(apiModule.apiFetch)).not.toHaveBeenCalledWith(
      expect.stringContaining('planning-artifacts')
    );
  });

  it('shows artifacts-error message when artifact fetch fails', async () => {
    vi.mocked(apiModule.apiFetch).mockImplementation(async (path: string) => {
      if (path.includes('planning-artifacts')) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ epic_id: 'epic-001', stories: [] }) } as Response;
    });

    renderEpicDetail();

    await waitFor(() => {
      expect(screen.getByTestId('artifacts-error')).not.toBeNull();
    });
  });
});

// ─── Approve / Reject button presence ────────────────────────────────────────

describe('EpicDetail — Approve/Reject button presence', () => {
  it('shows Approve and Reject buttons when status is planned', () => {
    renderEpicDetail();

    expect(screen.getByRole('button', { name: /approve/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /reject/i })).not.toBeNull();
  });

  it('hides Approve and Reject buttons when status is in_progress', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'in_progress' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicDetail();

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('hides Approve and Reject buttons when status is done', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'done' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicDetail();

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('hides Approve and Reject buttons when status is failed', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'failed' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicDetail();

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('hides Approve and Reject buttons when status is approved (post-approve state)', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'approved' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicDetail();

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });
});

// ─── Approve mutation UX ──────────────────────────────────────────────────────

describe('EpicDetail — Approve mutation', () => {
  it('calls apiPost with the approve endpoint on click', async () => {
    renderEpicDetail();

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiPost)).toHaveBeenCalledWith(
        '/api/epics/epic-001/approve'
      );
    });
  });

  it('disables Approve button with spinner while POST is in flight; Reject unaffected', async () => {
    let resolvePost!: (r: Response) => void;
    vi.mocked(apiModule.apiPost).mockReturnValueOnce(
      new Promise<Response>((r) => { resolvePost = r; })
    );

    renderEpicDetail();

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    const rejectBtn = screen.getByRole('button', { name: /reject/i });

    fireEvent.click(approveBtn);
    await act(async () => {});

    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('approve-spinner')).not.toBeNull();
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(false);

    // Resolve to clean up
    await act(async () => { resolvePost({ ok: true, status: 200 } as Response); });
  });

  it('calls invalidateQueries and re-enables button on 2xx', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: true, status: 200 } as Response);

    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
    renderEpicDetail('my-repo', 'epic-001', qc);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.epics('my-repo') })
      );
    });

    expect((screen.getByRole('button', { name: /approve/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows inline error and re-enables button on non-2xx', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: false, status: 403 } as Response);

    renderEpicDetail();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('approve-error')).not.toBeNull();
    });

    expect(screen.getByTestId('approve-error').textContent).toContain('403');
    expect((screen.getByRole('button', { name: /approve/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ─── Reject mutation UX ───────────────────────────────────────────────────────

describe('EpicDetail — Reject mutation', () => {
  it('calls apiPost with the reject endpoint on click', async () => {
    renderEpicDetail();

    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiPost)).toHaveBeenCalledWith(
        '/api/epics/epic-001/reject'
      );
    });
  });

  it('disables Reject button with spinner while POST is in flight; Approve unaffected', async () => {
    let resolvePost!: (r: Response) => void;
    vi.mocked(apiModule.apiPost).mockReturnValueOnce(
      new Promise<Response>((r) => { resolvePost = r; })
    );

    renderEpicDetail();

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    const rejectBtn = screen.getByRole('button', { name: /reject/i });

    fireEvent.click(rejectBtn);
    await act(async () => {});

    expect((rejectBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('reject-spinner')).not.toBeNull();
    expect((approveBtn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { resolvePost({ ok: true, status: 200 } as Response); });
  });

  it('calls invalidateQueries and re-enables button on 2xx', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: true, status: 200 } as Response);

    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
    renderEpicDetail('my-repo', 'epic-001', qc);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.epics('my-repo') })
      );
    });

    expect((screen.getByRole('button', { name: /reject/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows inline error and re-enables button on non-2xx', async () => {
    vi.mocked(apiModule.apiPost).mockResolvedValue({ ok: false, status: 403 } as Response);

    renderEpicDetail();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('reject-error')).not.toBeNull();
    });

    expect(screen.getByTestId('reject-error').textContent).toContain('403');
    expect((screen.getByRole('button', { name: /reject/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ─── Epics query loading / error states ──────────────────────────────────────

describe('EpicDetail — epics loading/error states', () => {
  it('shows a loading indicator while epics query is in flight', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: undefined,
        isLoading: true,
        isSuccess: false,
        status: 'pending',
      })
    );

    renderEpicDetail();

    expect(screen.getByTestId('epics-loading')).not.toBeNull();
  });

  it('shows an error message when epics query fails', () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: undefined,
        isLoading: false,
        isSuccess: false,
        isError: true,
        status: 'error',
      })
    );

    renderEpicDetail();

    expect(screen.getByTestId('epics-error')).not.toBeNull();
  });

  it('shows a loading indicator while planning artifacts are loading', async () => {
    // Delay the apiFetch resolution to keep the artifacts query loading
    let resolveArtifacts!: (r: Response) => void;
    vi.mocked(apiModule.apiFetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => { resolveArtifacts = resolve; })
    );

    renderEpicDetail();

    await waitFor(() => {
      expect(screen.getByTestId('artifacts-loading')).not.toBeNull();
    });

    // Resolve to clean up
    await act(async () => {
      resolveArtifacts({ ok: true, json: async () => mockArtifacts } as Response);
    });
  });
});

// ─── Routing and composition ──────────────────────────────────────────────────

describe('EpicDetail — routing and composition', () => {
  it('renders StoryList as a child', () => {
    renderEpicDetail('my-repo', 'epic-001');

    expect(screen.getByTestId('story-list-mock')).not.toBeNull();
  });

  it('useEpicArtifacts is disabled when epic status is not planned', async () => {
    vi.mocked(useEpicsModule.useEpics).mockReturnValue(
      makeQueryResult<EpicsResponse>({
        data: { epics: [makeEpic({ status: 'approved' })] },
        isLoading: false,
        isSuccess: true,
        status: 'success',
      })
    );

    renderEpicDetail();

    await act(async () => {});
    // Hook is disabled — apiFetch must not be called for planning-artifacts
    expect(vi.mocked(apiModule.apiFetch)).not.toHaveBeenCalledWith(
      expect.stringContaining('planning-artifacts')
    );
  });

  it('useEpicArtifacts is enabled only when epic status is planned', async () => {
    renderEpicDetail();

    await waitFor(() => {
      expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
        expect.stringContaining('planning-artifacts')
      );
    });
  });
});
