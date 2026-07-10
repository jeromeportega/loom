import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface AppShellProps {
  children: ReactNode;
}

const navLinkCls =
  'rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground';

function navClass({ isActive }: { isActive: boolean }): string {
  return cn(navLinkCls, isActive && 'bg-accent text-accent-foreground');
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-6 border-b bg-background px-6">
        <h1 className="text-base font-semibold tracking-tight">loom</h1>
        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={navClass}>
            Board
          </NavLink>
          <NavLink to="/repos" className={navClass}>
            Repos
          </NavLink>
        </nav>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
