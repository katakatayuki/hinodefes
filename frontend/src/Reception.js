import React, { useState } from 'react';
import { db, serverTimestamp } from './firebase';
import { collection, addDoc } from 'firebase/firestore';

export default function Reception() {
  const [name, setName] = useState('');
  const [people, setPeople] = useState(1);
  const [wantsLine, setWantsLine] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const docRef = await addDoc(collection(db, 'reservations'), {
      name,
      people: Number(people),
      wantsLine,
      createdAt: serverTimestamp(),
      status: 'waiting',
      lineUserId: null, // LINE連携は後で追加
      notes: "",
      seatEnterAt: null,
      calledAt: null
    });
    alert('登録しました。受付番号: ' + docRef.id);
    setName('');
    setPeople(1);
    setWantsLine(false);
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
