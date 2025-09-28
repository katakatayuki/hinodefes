import React, { useState } from 'react';

// あなたのRenderサービスのURLに置き換える
const API_BASE_URL = 'https://hinodefes.onrender.com';

export default function Admin() {
  const [available, setAvailable] = useState(0);

  async function sendCompute() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/compute-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          availableCount: Number(available),
          apiSecret: process.env.REACT_APP_API_SECRET
        })
      });

      if (!response.ok) {
        throw new Error(`API呼び出しに失敗しました: ${response.status}`);
      }

      const data = await response.json();
      if (data.called && data.called.length > 0) {
        alert('以下の番号を呼び出しました: ' + data.called.join(', '));
      } else {
        alert('呼び出せるグループがありませんでした。');
      }
    } catch (error) {
      console.error('呼出エラー:', error);
      alert('呼出処理中にエラーが発生しました。コンソールを確認してください。');
    }
  }

  return (
    <div style={{ padding: '20px', maxWidth: '400px', margin: 'auto' }}>
      <h1>管理者画面</h1>
      <p>完成した商品の個数を入力して、呼び出しを実行します。</p>
      <div style={{ marginBottom: '10px' }}>
        <label>
          完成個数：
          <input
            type="number"
            value={available}
            onChange={(e) => setAvailable(e.target.value)}
            min={0}
            style={{ width: '100%', padding: '8px' }}
          />
        </label>
      </div>
      <button
        onClick={sendCompute}
        style={{ padding: '10px 20px', backgroundColor: '#007BFF', color: 'white', border: 'none', cursor: 'pointer' }}
      >
        呼出実行
      </button>
    </div>
  );
}


