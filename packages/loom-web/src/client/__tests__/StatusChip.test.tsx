import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { StatusChip, STATUS_CLASSES } from '../components/StatusChip';
import type { CanonicalStatus } from '../components/StatusChip';

// Re-import via the index to verify the export chain.
import { StatusChip as StatusChipViaIndex } from '../components/index';
import type { CanonicalStatus as CanonicalStatusViaIndex } from '../components/index';

const ALL_STATUSES: CanonicalStatus[] = [
  'running',
  'blocked',
  'failed',
  'done',
  'pending',
  'queued',
];

function renderChip(status: string) {
  return render(<StatusChip status={status} />);
}

describe('StatusChip — all six states render', () => {
  for (const status of ALL_STATUSES) {
    it(`renders label text for status "${status}"`, () => {
      renderChip(status);
      expect(screen.getByText(status)).not.toBeNull();
    });
  }
});

describe('StatusChip — running state has animated spinner', () => {
  it('renders an svg with animate-spin class for running', () => {
    const { container } = renderChip('running');
    const spinner = container.querySelector('svg.animate-spin');
    expect(spinner).not.toBeNull();
  });

  it('does not render an svg spinner for non-running states', () => {
    for (const status of ALL_STATUSES.filter((s) => s !== 'running')) {
      const { container } = renderChip(status);
      expect(
        container.querySelector('svg.animate-spin'),
        `${status} must not have a spinner`
      ).toBeNull();
    }
  });
});

describe('StatusChip — color classes', () => {
  it('running uses blue color classes', () => {
    const { container } = renderChip('running');
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('bg-blue-100');
    expect(badge.className).toContain('text-blue-800');
  });

  it('blocked uses orange (alert) color classes', () => {
    const { container } = renderChip('blocked');
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('bg-orange-100');
    expect(badge.className).toContain('text-orange-800');
  });

  it('failed uses red (alert) color classes', () => {
    const { container } = renderChip('failed');
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('bg-red-100');
    expect(badge.className).toContain('text-red-800');
  });

  it('done uses green (success) color classes', () => {
    const { container } = renderChip('done');
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('bg-green-100');
    expect(badge.className).toContain('text-green-700');
  });

  it('pending uses neutral gray color classes', () => {
    const { container } = renderChip('pending');
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('bg-gray-100');
    expect(badge.className).toContain('text-gray-600');
  });

  it('queued uses neutral gray color classes', () => {
    const { container } = renderChip('queued');
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('bg-gray-100');
    expect(badge.className).toContain('text-gray-600');
  });
});

describe('StatusChip — dark mode classes present in STATUS_CLASSES', () => {
  it('every canonical status has dark: color classes defined', () => {
    for (const status of ALL_STATUSES) {
      const classes = STATUS_CLASSES[status];
      expect(classes, `${status} must include dark: class`).toContain('dark:');
    }
  });

  it('running dark classes are blue', () => {
    expect(STATUS_CLASSES.running).toContain('dark:bg-blue-900');
    expect(STATUS_CLASSES.running).toContain('dark:text-blue-200');
  });

  it('blocked dark classes are orange', () => {
    expect(STATUS_CLASSES.blocked).toContain('dark:bg-orange-900');
    expect(STATUS_CLASSES.blocked).toContain('dark:text-orange-200');
  });

  it('failed dark classes are red', () => {
    expect(STATUS_CLASSES.failed).toContain('dark:bg-red-900');
    expect(STATUS_CLASSES.failed).toContain('dark:text-red-200');
  });

  it('done dark classes are green', () => {
    expect(STATUS_CLASSES.done).toContain('dark:bg-green-900');
    expect(STATUS_CLASSES.done).toContain('dark:text-green-300');
  });
});

describe('StatusChip — distinct visual treatments', () => {
  it('blocked and failed both use alert colors but different hues', () => {
    const blockedClasses = STATUS_CLASSES.blocked;
    const failedClasses = STATUS_CLASSES.failed;
    // Both alert — but orange vs red, so they differ
    expect(blockedClasses).not.toBe(failedClasses);
    expect(blockedClasses).toContain('orange');
    expect(failedClasses).toContain('red');
  });

  it('each non-neutral status has a unique color class', () => {
    // The architect contract gives pending and queued the same gray class by design;
    // they are distinguished by label text alone.
    // All other statuses must have unique color classes.
    const nonNeutral: CanonicalStatus[] = ['running', 'blocked', 'failed', 'done'];
    const seen = new Set<string>();
    for (const status of nonNeutral) {
      const key = STATUS_CLASSES[status];
      expect(seen.has(key), `Duplicate color class for status "${status}": ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('pending and queued share the same gray class but differ by label text', () => {
    // Per architect contract — same color, distinct text label.
    expect(STATUS_CLASSES.pending).toBe(STATUS_CLASSES.queued);
    const { getByText: getPending } = render(<StatusChip status="pending" />);
    const { getByText: getQueued } = render(<StatusChip status="queued" />);
    expect(getPending('pending')).not.toBeNull();
    expect(getQueued('queued')).not.toBeNull();
  });
});

describe('StatusChip — unknown status fallback', () => {
  it('renders the status label for an unrecognized status string', () => {
    renderChip('mystery-status');
    expect(screen.getByText('mystery-status')).not.toBeNull();
  });

  it('does not throw for an empty string status', () => {
    expect(() => renderChip('')).not.toThrow();
  });
});

describe('StatusChip — no hardcoded hex values in source', () => {
  it('component file contains no hex color values', () => {
    // Use process.cwd() — vitest sets cwd to the package root (packages/loom-web)
    const src = readFileSync(
      join(process.cwd(), 'src/client/components/StatusChip.tsx'),
      'utf8'
    );
    // Match #xxx, #xxxxxx, rgb(...), rgba(...) — all hardcoded color forms
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\brgba?\s*\(/);
  });
});

describe('StatusChip — index export', () => {
  it('StatusChip is importable from the component index', () => {
    expect(StatusChipViaIndex).toBeDefined();
  });

  it('StatusChip from index renders without error', () => {
    expect(() => render(<StatusChipViaIndex status="done" />)).not.toThrow();
  });
});

describe('StatusChip — className prop merging', () => {
  it('applies additional className alongside status classes', () => {
    const { container } = render(<StatusChip status="done" className="ml-2" />);
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('ml-2');
    expect(badge.className).toContain('bg-green-100');
  });
});
