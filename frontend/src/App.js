import React from 'react';
import Reception from './Reception';
import Admin from './Admin';
import TVDisplay from './TVDisplay';

function App() {
  // 現在のURLパスを取得
  const path = window.location.pathname;

  // パスに応じて表示するコンポーネントを切り替える
  if (path === '/admin') {
    return <Admin />;
  } else if (path === '/tv') {
    return <TVDisplay />;
  } else {
    return <Reception />;
  }
}

export default App;
