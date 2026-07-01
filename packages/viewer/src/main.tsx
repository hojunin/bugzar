import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectStyles } from './styles';

injectStyles();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
