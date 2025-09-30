import React, { useEffect, useState } from 'react';

// あなたのRenderサービスのURLに置き換える
const API_BASE_URL = 'https://hinodefes.onrender.com';

export default function TVDisplay() {
  // 🚨 修正: 呼び出し中の番号の状態
  const [calledState, setCalledState] = useState({ currentCalled: [] });
  // 🚨 追加: 待ち況のサマリーの状態
  const [waitingSummary, setWaitingSummary] = useState({ 
    '5-5': { groups: 0, people: 0 }, 
    '5-2': { groups: 0, people: 0 } 
  });


  // 🚨 関数: 呼び出し中の番号を取得
  const fetchCalledStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/tv-status`);
      const data = await response.json();
      setCalledState(data); // 状態名をsetStateからsetCalledStateに変更
    } catch (error) {
      console.error('TV表示データの取得エラー:', error);
    }
  };

  // 🚨 関数: 待ち状況のサマリーを取得
  const fetchWaitingSummary = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/waiting-summary`);
      if (res.ok) {
        const data = await res.json();
        setWaitingSummary(data);
      }
    } catch (error) {
      console.error('待ち状況サマリーの取得エラー:', error);
    }
  };


  useEffect(() => {
    // 初回実行
    fetchCalledStatus();
    fetchWaitingSummary();
    
    // 3秒ごとにAPIをポーリングして最新の情報を取得
    const id = setInterval(() => {
      fetchCalledStatus();
      fetchWaitingSummary(); // 🚨 サマリーも定期的に取得
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
      
      {/* 🚨 待ち状況の表示エリア */}
      <div style={{ 
        position: 'absolute', 
        top: '20px', 
        left: '20px', 
        right: '20px',
        padding: '20px',
        border: '1px solid #ccc',
        borderRadius: '10px',
        backgroundColor: '#fff',
        fontSize: '24px' 
      }}>
        <h2>現在の待ち状況</h2>
        <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '15px' }}>
          <div style={{ padding: '10px', borderRight: '1px solid #eee' }}>
            <h4>団体 5-5</h4>
            <p>団体数: <strong>{waitingSummary['5-5'].groups}</strong> / 人数: <strong>{waitingSummary['5-5'].people}</strong> 人</p>
          </div>
          <div style={{ padding: '10px' }}>
            <h4>団体 5-2</h4>
            <p>団体数: <strong>{waitingSummary['5-2'].groups}</strong> / 人数: <strong>{waitingSummary['5-2'].people}</strong> 人</p>
          </div>
        </div>
      </div>
      
      {/* 呼び出し中の番号リスト (CSSを調整して待ち状況エリアと被らないように) */}
      <div style={{ marginTop: '200px' }}> 
        <h1>現在呼び出し中の番号</h1>
        {calledState.currentCalled.length ? (
          calledState.currentCalled.map((n, index) => (
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
    </div>
  );
}
