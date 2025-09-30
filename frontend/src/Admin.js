import React, { useState } from 'react';

// あなたのRenderサービスのURLに置き換える
const API_BASE_URL = 'https://hinodefes.onrender.com';

export default function Admin() {
  // availableをavailableCountにリネームし、初期値を1に設定
  const [availableCount, setAvailableCount] = useState(1);
  // 🚨 新しいState: 呼び出し対象の団体を追加
  const [callGroup, setCallGroup] = useState('5-5');

  // 関数名をsendComputeからhandleCallに変更
  async function handleCall() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/compute-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // State名に合わせて更新
          availableCount: Number(availableCount),
          apiSecret: process.env.REACT_APP_API_SECRET,
          // 🚨 callGroupをサーバーに送る
          callGroup: callGroup,
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
      <p>完成した商品の個数と対象団体を入力して、呼び出しを実行します。</p>

      {/* 🚨 呼び出し対象の団体選択を追加 */}
      <div style={{ marginBottom: '15px' }}>
        <label>
          呼び出し対象の団体:
          <select
            value={callGroup}
            onChange={(e) => setCallGroup(e.target.value)}
            style={{ padding: '8px', marginLeft: '10px' }}
          >
            <option value="5-5">団体 5-5</option>
            <option value="5-2">団体 5-2</option>
            {/* 必要に応じて他の団体オプションを追加 */}
          </select>
        </label>
      </div>
      
      {/* State名をavailableCountに更新 */}
      <div style={{ marginBottom: '10px' }}>
        <label>
          完成個数：
          <input
            type="number"
            value={availableCount}
            onChange={(e) => setAvailableCount(e.target.value)}
            min={0}
            style={{ width: '100%', padding: '8px' }}
          />
        </label>
      </div>

      <button
        // 関数名をhandleCallに更新
        onClick={handleCall}
        style={{ padding: '10px 20px', backgroundColor: '#007BFF', color: 'white', border: 'none', cursor: 'pointer' }}
      >
        呼出実行
      </button>
    </div>
  );
}
