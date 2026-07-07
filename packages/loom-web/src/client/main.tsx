import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="flex min-h-screen flex-col">
      <header className="border-b px-6 py-4">
        <h1 className="text-xl font-semibold">loom</h1>
      </header>
      <main className="flex-1 p-6">
        <p className="text-muted-foreground">Loading…</p>
      </main>
    </div>
  </React.StrictMode>
);
