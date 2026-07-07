import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './components/AppShell';

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

/**
 * AppContent contains the shell layout and route definitions.
 * Exported so tests can wrap it with MemoryRouter + a test QueryClient
 * without the production BrowserRouter/QueryClient.
 */
export function AppContent() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<RepositoryList />} />
          <Route path="/repo/:slug" element={<EpicList />} />
          <Route path="/repo/:slug/epic/:epicId" element={<EpicDetail />} />
          <Route path="/repo/:slug/epic/:epicId/story/:storyId" element={<StoryDetail />} />
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
