// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Card } from '../components/ui/card';
import { Table } from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tabs } from '../components/ui/tabs';
import { Skeleton } from '../components/ui/skeleton';

describe('shadcn/ui components', () => {
  it('Card is importable', () => {
    expect(Card).toBeDefined();
  });

  it('Table is importable', () => {
    expect(Table).toBeDefined();
  });

  it('Badge is importable', () => {
    expect(Badge).toBeDefined();
  });

  it('Button is importable', () => {
    expect(Button).toBeDefined();
  });

  it('Tabs is importable', () => {
    expect(Tabs).toBeDefined();
  });

  it('Skeleton is importable', () => {
    expect(Skeleton).toBeDefined();
  });
});

describe('build outputs', () => {
  // Anchor to the test file location, not process.cwd(), so the path is
  // stable regardless of which directory npm test is invoked from.
  // Use fileURLToPath for Node 20 compatibility (import.meta.dirname is Node 21.2+).
  const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');
  const clientDist = join(pkgRoot, 'client-dist');
  const assetsDir = join(clientDist, 'assets');

  it('components.json exists', () => {
    expect(existsSync(join(pkgRoot, 'components.json'))).toBe(true);
  });

  // These two tests require a prior `npm run build` — skip rather than fail on fresh checkouts.
  it.skipIf(!existsSync(clientDist))('client-dist exists and is non-empty after build', () => {
    const files = readdirSync(clientDist);
    expect(files.length).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(assetsDir))('Tailwind utility classes appear in compiled CSS bundle', () => {
    const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
    expect(cssFiles.length, 'No CSS files found in client-dist/assets').toBeGreaterThan(0);
    const cssContent = cssFiles
      .map((f) => readFileSync(join(assetsDir, f), 'utf8'))
      .join('');
    expect(cssContent).toMatch(/flex|block|inline-flex/);
  });
});
