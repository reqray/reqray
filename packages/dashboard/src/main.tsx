import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Listed here in cascade order rather than imported from the components that
// use them: the sheets override one another, and import order would then
// depend on which screen React happened to mount first.
import './styles/tokens.css';
import './styles/base.css';
import './shared/chart/chart.css';
import './features/requests/requests.css';
import './features/detail/detail.css';
import './features/detail/replay.css';
import './features/exceptions/exceptions.css';
import './features/routes/routes.css';
import './features/findings/findings.css';
import './features/history/history.css';
import './features/project/project.css';

const root = document.getElementById('root');
if (!root) throw new Error('reqray: #root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
