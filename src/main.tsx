// Must come first: patches the Buffer polyfill to support `base64url`,
// which @ar.io/sdk's canonical-message builder requires. See the module.
import './polyfills/buffer-base64url.ts';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
