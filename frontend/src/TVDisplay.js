import React, { useEffect, useState } from 'react';

// あなたのRenderサービスのURLに置き換える
const API_BASE_URL = 'https://hinodefes.onrender.com';

export default function TVDisplay() {
  const [state, setState] = useState({ currentCalled: [] });

  useEffect(() => {
    // 3秒ごとにAPIをポーリングして最新の情報を取得
    const id = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/tv-status`);
        const data = await response.json();
        setState(data);
      } catch (error) {
        console.error('TV表示データの取得エラー:', error);
      }
    }, 3000);

    // コンポーネントがアンマウントされるときにポーリングを停止
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      fontSize: '72px',
      textAlign: 'center',
      paddingTop: '50px',
      backgroundColor: '#f0f0f0',
      minHeight: '100vh',
      boxSizing: 'border-box'
    }}>
      <h1>現在呼び出し中の番号</h1>
      {state.currentCalled.length ? (
        state.currentCalled.map((n, index) => (
          <div key={index} style={{
            margin: '20px',
            padding: '20px',
            border: '2px solid #ccc',
            borderRadius: '10px',
            backgroundColor: '#fff'
          }}>
            No.{n}
          </div>
        ))
      ) : (
        <div style={{ fontSize: '36px', color: '#888' }}>
          呼び出し中の番号はありません
        </div>
      )}
    </div>
  );
}

