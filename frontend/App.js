// src/App.js
import React from 'react';
import Reception from './Reception';
import Admin from './Admin';
import TVDisplay from './TVDisplay';

function App() {
  // ブラウザのURLパスに応じてコンポーネントを切り替える
  const path = window.location.pathname;

  if (path === '/admin') {
    return <Admin />;
  } else if (path === '/tv') {
    return <TVDisplay />;
  } else {
    return <Reception />;
  }
}
export default App;
