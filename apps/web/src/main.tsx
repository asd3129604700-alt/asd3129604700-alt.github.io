import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { installTrustedTypesPolicy } from './runtime/trustedTypes';
import './styles.css';
import { isGitHubPagesBuild } from './runtime/localModelImport';
import { preparePagesIsolation } from './runtime/pagesIsolation';

installTrustedTypesPolicy();

async function start(): Promise<void> {
  if (isGitHubPagesBuild && !await preparePagesIsolation()) return;
  ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
}
void start().catch(error => {
  document.getElementById('root')!.textContent = error instanceof Error ? error.message : String(error);
});
