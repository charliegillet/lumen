import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/** /c/:id names the conversation; anything else starts a new one. */
function conversationId(): string {
  const m = /^\/c\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname);
  if (m) return m[1]!;
  const id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  history.replaceState(null, '', `/c/${id}`);
  return id;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App conversationId={conversationId()} />
  </StrictMode>,
);
