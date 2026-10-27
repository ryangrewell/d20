import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import { loadRuntimeConfig } from '@/lib/config';
import { App } from '@/app/App';

const root = createRoot(document.getElementById('root')!);

loadRuntimeConfig()
  .then(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
  .catch((err: Error) => {
    root.render(
      <div style={{ padding: 32, fontFamily: 'system-ui', color: '#ece8f4' }}>
        <h1>d20 could not start</h1>
        <p>{err.message}</p>
      </div>,
    );
  });
