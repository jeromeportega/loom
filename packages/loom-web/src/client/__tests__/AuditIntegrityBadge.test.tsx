import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { AuditIntegrityBadge } from '../components/AuditIntegrityBadge';
import { AppShell } from '../components/AppShell';
import { makeQueryResult } from '../testUtils';
import type { VerifyChainResult } from '@loom-ai/core';

vi.mock('../hooks/useAuditVerify');

import * as useAuditVerifyModule from '../hooks/useAuditVerify';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function renderBadge() {
  const { container } = render(<AuditIntegrityBadge />, { wrapper: makeWrapper() });
  return { container };
}

describe('AuditIntegrityBadge — loading state', () => {
  it('renders a Skeleton while the query is pending', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({ isPending: true, status: 'pending' })
    );

    const { container } = renderBadge();
    const skeleton = container.querySelector('.animate-pulse');
    expect(skeleton).not.toBeNull();
  });

  it('does not render a Badge while loading', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({ isPending: true, status: 'pending' })
    );

    renderBadge();
    expect(screen.queryByText('Chain intact')).toBeNull();
    expect(screen.queryByText(/Broken at/)).toBeNull();
  });
});

describe('AuditIntegrityBadge — ok: true', () => {
  it('renders a Badge with variant="default" when ok is true', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        data: { ok: true, hashedRows: 5, legacyRows: 0, fromId: 1, toId: 5 },
        isSuccess: true,
        status: 'success',
      })
    );

    const { container } = renderBadge();
    const badge = container.querySelector('.bg-primary');
    expect(badge).not.toBeNull();
  });

  it('shows "Chain intact" text when ok is true', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        data: { ok: true, hashedRows: 3, legacyRows: 0, fromId: 1, toId: 3 },
        isSuccess: true,
        status: 'success',
      })
    );

    renderBadge();
    expect(screen.getByText('Chain intact')).not.toBeNull();
  });

  it('does not mention brokenAtId when ok is true', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        data: { ok: true, hashedRows: 3, legacyRows: 0, fromId: 1, toId: 3 },
        isSuccess: true,
        status: 'success',
      })
    );

    renderBadge();
    expect(screen.queryByText(/Broken at/)).toBeNull();
    expect(screen.queryByText(/42/)).toBeNull();
  });
});

describe('AuditIntegrityBadge — ok: false', () => {
  it('renders a Badge with variant="destructive" when ok is false', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        data: { ok: false, hashedRows: 3, legacyRows: 0, fromId: 1, toId: 3, brokenAtId: 42, reason: 'hash mismatch' },
        isSuccess: true,
        status: 'success',
      })
    );

    const { container } = renderBadge();
    const badge = container.querySelector('.bg-destructive');
    expect(badge).not.toBeNull();
  });

  it('includes brokenAtId (42) in the label when ok is false', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        data: { ok: false, hashedRows: 3, legacyRows: 0, fromId: 1, toId: 3, brokenAtId: 42, reason: 'hash mismatch' },
        isSuccess: true,
        status: 'success',
      })
    );

    renderBadge();
    const badgeEl = screen.getByText(/Broken at #42/);
    expect(badgeEl).not.toBeNull();
  });

  it('does not render "Chain intact" when ok is false', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        data: { ok: false, hashedRows: 1, legacyRows: 0, fromId: 7, toId: 7, brokenAtId: 7 },
        isSuccess: true,
        status: 'success',
      })
    );

    renderBadge();
    expect(screen.queryByText('Chain intact')).toBeNull();
  });
});

describe('AuditIntegrityBadge — error state', () => {
  it('renders a neutral Badge (variant="secondary") on fetch error', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        isError: true,
        error: new Error('network failure'),
        status: 'error',
      })
    );

    const { container } = renderBadge();
    const badge = container.querySelector('.bg-secondary');
    expect(badge).not.toBeNull();
  });

  it('shows "Unknown" text on error', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        isError: true,
        error: new Error('network failure'),
        status: 'error',
      })
    );

    renderBadge();
    expect(screen.getByText('Unknown')).not.toBeNull();
  });

  it('does not throw an uncaught exception on fetch error', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        isError: true,
        error: new Error('network failure'),
        status: 'error',
      })
    );

    expect(() => renderBadge()).not.toThrow();
  });
});

describe('AuditIntegrityBadge — mounted in AppShell', () => {
  it('the audit view (AppShell) renders the badge element', () => {
    vi.mocked(useAuditVerifyModule.useAuditVerify).mockReturnValue(
      makeQueryResult<VerifyChainResult>({
        data: { ok: true, hashedRows: 1, legacyRows: 0, fromId: 1, toId: 1 },
        isSuccess: true,
        status: 'success',
      })
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AppShell>
            <div>content</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText('Chain intact')).not.toBeNull();
  });
});
