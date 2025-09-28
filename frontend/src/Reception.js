// Reception.js (QRコード表示機能追加版)
import React, { useState } from 'react';

// 🚨 【要変更】あなたのRenderサーバーのURLに置き換えてください
const SERVER_URL = "https://hinodefes.onrender.com"; 
// 🚨 【要変更】LINE友だち追加QRコード画像のURLに置き換えてください
// Firebase Hostingにアップロードした画像パスを設定
const LINE_QR_CODE_URL = 'https://hinodefes-57609.web.app/line_qr_code.png'; 

export default function Reception() {
  const [name, setName] = useState('');
  const [people, setPeople] = useState(1);
  const [wantsLine, setWantsLine] = useState(false);
  
  // 🚨 新しいStateを追加: 予約が成功し、QRコードを表示すべきか
  const [isReserved, setIsReserved] = useState(false);
  const [reservedNumber, setReservedNumber] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    
    // 既存の予約画面に戻す
    setIsReserved(false); 
    setReservedNumber(null);

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

        // フォームをリセット
        setName('');
        setPeople(1);
        setWantsLine(false);
        
        // 🚨 予約成功後の処理を条件分岐
        if (wantsLine) {
            // LINE通知希望の場合は、QRコード表示画面へ
            setReservedNumber(number);
            setIsReserved(true);
            alert(`登録完了！受付番号は【${number}】番です。\nLINEの友だち追加をしてください。`);
        } else {
            // LINE通知不要の場合は、番号をアラートで表示して完了
            alert(`登録完了！受付番号は【${number}】番です。`);
        }
        

    } catch (error) {
      console.error(error);
      alert('登録処理中にエラーが発生しました。サーバーまたはネットワークを確認してください。');
    }
  }

  // 🚨 予約完了後のQRコード表示画面
  if (isReserved && reservedNumber !== null) {
      return (
          <div style={{ padding: '20px', maxWidth: '400px', margin: 'auto', textAlign: 'center' }}>
              <h1>登録完了！</h1>
              <h2>受付番号: <span style={{ color: 'red', fontSize: '2em' }}>{reservedNumber}</span> 番</h2>
              
              <h3 style={{ marginTop: '30px' }}>LINE通知設定</h3>
              <p>準備完了の通知を受け取るため、以下のQRコードをLINEで読み取り、**友だち追加**してください。</p>
              
              <img 
                  src={LINE_QR_CODE_URL} 
                  alt="LINE友だち追加QRコード" 
                  style={{ width: '250px', height: '250px', border: '1px solid #ccc', margin: '20px 0' }} 
              />
              
              <button
                  onClick={() => setIsReserved(false)}
                  style={{ padding: '10px 20px', backgroundColor: '#333', color: 'white', border: 'none', cursor: 'pointer', marginTop: '20px' }}
              >
                  受付画面に戻る
              </button>
          </div>
      );
  }

  // 🚨 通常の受付フォーム
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
