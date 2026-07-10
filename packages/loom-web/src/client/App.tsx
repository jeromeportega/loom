import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './components/AppShell';
import { useEventStream } from './hooks/useEventStream';

const KanbanBoard = lazy(() =>
  import('./views/KanbanBoard').then((m) => ({ default: m.KanbanBoard }))
);
const RepositoryList = lazy(() =>
  import('./views/RepositoryList').then((m) => ({ default: m.RepositoryList }))
);
const EpicList = lazy(() =>
  import('./views/EpicList').then((m) => ({ default: m.EpicList }))
);
const EpicDetail = lazy(() =>
  import('./views/EpicDetail').then((m) => ({ default: m.EpicDetail }))
);
const StoryDetail = lazy(() =>
  import('./views/StoryDetail').then((m) => ({ default: m.StoryDetail }))
);

const queryClient = new QueryClient();

function SSEConnector() {
  useEventStream();
  return null;
}

/**
 * Padded, vertically-scrollable wrapper for the drill-down pages. The board
 * route stays full-bleed and owns its own (horizontal) scroll, so it is not
 * wrapped in this.
 */
function Page({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto p-6">{children}</div>;
}

/**
 * AppContent contains the shell layout and route definitions.
 * Exported so tests can wrap it with MemoryRouter + a test QueryClient
 * without the production BrowserRouter/QueryClient.
 */
export function AppContent() {
  return (
    <AppShell>
      <SSEConnector />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<KanbanBoard />} />
          <Route path="/repos" element={<Page><RepositoryList /></Page>} />
          <Route path="/repo/:slug" element={<Page><EpicList /></Page>} />
          <Route path="/repo/:slug/epic/:epicId" element={<Page><EpicDetail /></Page>} />
          <Route path="/repo/:slug/epic/:epicId/story/:storyId" element={<Page><StoryDetail /></Page>} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
