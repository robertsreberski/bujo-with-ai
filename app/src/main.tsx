import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerJournalServiceWorker } from './pwa/registration';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Journal root element is missing.');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

void registerJournalServiceWorker();
