import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/requests.css';
import './styles/detail.css';
import './styles/replay.css';
import './styles/exceptions.css';

const root = document.getElementById('root');
if (!root) throw new Error('loupe: #root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
