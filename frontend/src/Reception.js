import React, { useState } from 'react';
// 🚨 修正: Firestore直接操作のインポートは不要になります
// import { db, serverTimestamp } from './firebase';
// import { collection, addDoc } from 'firebase/firestore'; 

// 🚨 あなたのRenderサーバーのURLに置き換えてください！
const SERVER_URL = "https://hinodefes.onrender.com"; 

export default function Reception() {
  const [name, setName] = useState('');
  const [people, setPeople] = useState(1);
  const [wantsLine, setWantsLine] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    
    try {
        // 🚨 修正: サーバーの /api/reserve を叩く
        const response = await fetch(`${SERVER_URL}/api/reserve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            people: Number(people),
            wantsLine,
            // lineUserId, notesなどはサーバー側でデフォルト値が設定されます
          }),
        });

        if (!response.ok) {
          throw new Error(`API登録に失敗しました: ${response.statusText}`);
        }

        const result = await response.json();

        // 🚨 修正: サーバーから返された連番 (number) を表示する
        alert(`登録しました。受付番号: ${result.number}`);
        
        // フォームをリセット
        setName('');
        setPeople(1);
        setWantsLine(false);
        
    } catch (error) {
        console.error(error);
        alert('登録処理中にエラーが発生しました。');
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
