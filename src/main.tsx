import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { applyTheme, readPersistedTheme, readPersistedAccent } from './hooks/useTheme';
import { initZoom } from './utils/appZoom';
import './index.css';

// Apply the user's last-chosen theme BEFORE React mounts, so the first paint
// matches their preference instead of flashing dark and then swapping when
// settings load from SQLite. The settings query reconciles after mount.
applyTheme(readPersistedTheme(), readPersistedAccent());

// Same reasoning for interface scale: restore it before the first paint rather
// than letting the window draw at 100% and jump.
initZoom();

// The webview's own context menu has no business in a desktop app — it offers
// to reload the page. Anywhere the app wants a menu it renders its own and
// calls preventDefault itself, so this is the backstop for everywhere else.
// Text fields keep the native menu: copy, paste and the spelling suggestions
// are real features there and nothing in the app replaces them.
window.addEventListener('contextmenu', (e) => {
  const el = e.target as HTMLElement | null;
  const editable =
    el?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') != null;
  if (!editable) e.preventDefault();
});

// Global unhandled error logging
window.addEventListener('error', (e) => {
  console.error('[Global] Unhandled error:', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Global] Unhandled promise rejection:', e.reason);
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Log all query errors
queryClient.getQueryCache().subscribe((event) => {
  if (event.type === 'updated' && event.query.state.status === 'error') {
    console.error(
      '[QueryClient] Query error:',
      event.query.queryKey,
      event.query.state.error
    );
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
