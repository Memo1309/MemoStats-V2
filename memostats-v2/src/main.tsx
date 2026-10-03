import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { log } from './logs/logStore';
import './performance/performanceStore';
import './ui/styles.css';

log('APP', `MemoStats V2 ${__APP_VERSION__} started`, {
  build: __BUILD_TIME__,
  userAgent: navigator.userAgent,
  webBluetooth: 'bluetooth' in navigator,
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
