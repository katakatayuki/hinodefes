// Reception.js (最終版)
import React, { useState } from 'react';

// 🚨 【要変更】あなたのRenderサーバーのURLに置き換えてください
const SERVER_URL = "https://hinodefes.onrender.com"; 
// 🚨 【要変更】LINE友だち追加QRコード画像のURLに置き換えてください
const LINE_QR_CODE_URL = 'https://hinodefes-57609.web.app/QRCODE.png'; 

export default function Reception() {
  const [name, setName] = useState('');
  const [people, setPeople] = useState(1);
  const [wantsLine, setWantsLine] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    
    try {
        const response = await fetch(`${SERVER_URL}/api/reserve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            people: Number(people),
            wantsLine,
          }),
        });

        if (!response.ok) {
          throw new Error(`API登録に失敗しました: ${response.statusText}`);
        }

        const result = await response.json();
        const number = result.number;

        let alertMessage = `登録完了！受付番号は【${number}】番です。`;

        if (wantsLine) {
            alertMessage += `\n\n【LINE通知希望の方へ】\n準備ができたらLINEで通知します。\n今すぐQRコードを読み取り、友だち追加してください。`;
            // 🚨 実際のQRコード画像は、このアラートの後で表示される画面/モーダルに含めてください
            alertMessage += `\n(QRコードのURLは: ${LINE_QR_CODE_URL})`; 
        }

        alert(alertMessage);
        
        // フォームをリセット
        setName('');
        setPeople(1);
        setWantsLine(false);
        
    } catch (error) {
      console.error(error);
      alert('登録処理中にエラーが発生しました。サーバーまたはネットワークを確認してください。');
    }
  }

  return (
    <div style={{ padding: '20px', maxWidth: '400px', margin: 'auto' }}>
      <h1>受付</h1>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '10px' }}>
          <label>
            名前：
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ width: '100%', padding: '8px' }}
            />
          </label>
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label>
            人数：
            <input
              type="number"
              value={people}
              min={1}
              onChange={(e) => setPeople(e.target.value)}
              style={{ width: '100%', padding: '8px' }}
            />
          </label>
        </div>
        <div style={{ marginBottom: '20px' }}>
          <label>
            <input
              type="checkbox"
              checked={wantsLine}
              onChange={(e) => setWantsLine(e.target.checked)}
            />
            LINEで通知希望
          </label>
        </div>
        <button
          type="submit"
          style={{ padding: '10px 20px', backgroundColor: '#4CAF50', color: 'white', border: 'none', cursor: 'pointer' }}
        >
          登録
        </button>
      </form>
    </div>
  );
}
