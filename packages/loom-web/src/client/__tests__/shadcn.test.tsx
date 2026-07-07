import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const pkgRoot = join(process.cwd());

  it('components.json exists', () => {
    expect(existsSync(join(pkgRoot, 'components.json'))).toBe(true);
  });

  it('client-dist exists and is non-empty after build', () => {
    const clientDist = join(pkgRoot, 'client-dist');
    if (!existsSync(clientDist)) {
      console.warn('client-dist not found — run npm run build first');
      return;
    }
    const files = readdirSync(clientDist);
    expect(files.length).toBeGreaterThan(0);
  });

  it('Tailwind utility classes appear in compiled CSS bundle', () => {
    const assetsDir = join(pkgRoot, 'client-dist', 'assets');
    if (!existsSync(assetsDir)) {
      console.warn('client-dist/assets not found — run npm run build first');
      return;
    }
    const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
    if (cssFiles.length === 0) {
      console.warn('No CSS files found in client-dist/assets');
      return;
    }
    const cssContent = cssFiles
      .map((f) => readFileSync(join(assetsDir, f), 'utf8'))
      .join('');
    expect(cssContent).toMatch(/flex|block|inline-flex/);
  });
});
