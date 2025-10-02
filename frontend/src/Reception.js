import React, { useState, useEffect } from 'react';

// 🚨 【要変更】あなたのRenderサーバーのURLに置き換えてください
const SERVER_URL = "https://hinodefes.onrender.com"; 
// 🚨 【要変更】LINE友だち追加QRコード画像のURLに置き換えてください
// Firebase Hostingにアップロードした画像パスを設定
const LINE_QR_CODE_URL = 'https://hinodefes-57609.web.app/QRCODE.png'; 

export default function Reception() {
  const [name, setName] = useState('');
  const [people, setPeople] = useState(1);
  const [wantsLine, setWantsLine] = useState(false);
  
  // 🚨 修正: ローカルストレージを使って初期値を設定
  const [group, setGroup] = useState(() => {
      const savedGroup = localStorage.getItem('lastGroup');
      return savedGroup || '5-5'; // 読み込めない場合は '5-5' を初期値とする
  });

  // 🚨 追加: グループ選択のロック状態 (デフォルトでロック)
  const [isGroupLocked, setIsGroupLocked] = useState(true);

  // 予約が成功し、QRコードを表示すべきか
  const [isReserved, setIsReserved] = useState(false);
  const [reservedNumber, setReservedNumber] = useState(null);
  const [items, setItems] = useState({
    nikuman: 0,
    pizaman: 0,
    anman: 0,
    chocoman: 0,
    oolongcha: 0,
  });
  const [stockLimits, setStockLimits] = useState(null);
  const [error, setError] = useState('');

  // 🚨 追加: 団体変更時にローカルストレージに保存するハンドラ
  const handleGroupChange = (newGroup) => {
      setGroup(newGroup);
      localStorage.setItem('lastGroup', newGroup);
  };

  useEffect(() => {
    // 在庫制限をサーバーから取得する
    const fetchStockLimits = async () => {
        try {
            const response = await fetch(`${SERVER_URL}/api/stock-limits`);
            if (!response.ok) {
                throw new Error('在庫情報の取得に失敗しました。');
            }
            const data = await response.json();
            setStockLimits(data);
        } catch (err) {
            console.error(err);
            setError('在庫情報を読み込めませんでした。ページを再読み込みしてください。');
        }
    };
    fetchStockLimits();
  }, []);

  const handleItemChange = (itemKey, value) => {
      const numValue = parseInt(value, 10);
      const limit = stockLimits[itemKey] || 0;
      
      if (isNaN(numValue) || numValue < 0) {
          setItems({ ...items, [itemKey]: 0 });
      } else if (numValue > limit) {
          setItems({ ...items, [itemKey]: limit });
      } else {
          setItems({ ...items, [itemKey]: numValue });
      }
  };

  async function handleSubmit(e) {
    e.preventDefault();
    
    const totalItems = Object.values(items).reduce((sum, count) => sum + count, 0);
    if (totalItems === 0) {
        alert('商品を1つ以上選択してください。');
        return; // ここで処理を中断
    }
    
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
            group, // サーバーに団体名（グループ）を送信
            items, // 商品の注文数を追加
          }),
        });

        if (!response.ok) {
          throw new Error(`API登録に失敗しました: ${response.statusText}`);
        }

        const result = await response.json();
        const number = result.number; // サーバーから複合番号（例: "55-1"）が返ってくる

        // フォームをリセット (GroupはLocalStorageから読み込んでいるため、ここではリセットしない)
        setName('');
        setPeople(1);
        setWantsLine(false);
        setItems({
            nikuman: 0,
            pizaman: 0,
            anman: 0,
            chocoman: 0,
            oolongcha: 0,
        });
        
        // 予約成功後の処理を条件分岐
        if (wantsLine) {
            // LINE通知希望の場合は、QRコード表示画面へ
            setReservedNumber(number);
            setIsReserved(true);
            // NOTE: alert()はブラウザ環境では非推奨ですが、カスタムモーダルUIへの変更を推奨します。
            alert(`登録完了！受付番号は【${number}】番です。\nLINEの友だち追加をしてください。`);
        } else {
            // LINE通知不要の場合は、番号をアラートで表示して完了
            // NOTE: alert()はブラウザ環境では非推奨ですが、カスタムモーダルUIへの変更を推奨します。
            alert(`登録完了！受付番号は【${number}】番です。`);
        }
        

    } catch (error) {
      console.error(error);
      // NOTE: alert()はブラウザ環境では非推奨ですが、カスタムモーダルUIへの変更を推奨します。
      alert('登録処理中にエラーが発生しました。サーバーまたはネットワークを確認してください。');
    }
  }

  // 予約完了後のQRコード表示画面
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
                style={{ padding: '10px 20px', backgroundColor: '#333', color: 'white', border: 'none', cursor: 'pointer', marginTop: '20px', borderRadius: '4px' }}
            >
                受付画面に戻る
            </button>
          </div>
      );
  }

  // 通常の受付フォーム
  return (
    <div style={{ padding: '20px', maxWidth: '400px', margin: 'auto' }}>
      <h1>受付</h1>
      <form onSubmit={handleSubmit}>
        
        {/* 🚨 修正: 団体選択ドロップダウンとロックボタン */}
        <div style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <label style={{ flexGrow: 1 }}>
                    団体を選択：
                    <select
                        value={group}
                        onChange={(e) => handleGroupChange(e.target.value)} // 🚨 修正: 専用ハンドラを使用
                        required
                        disabled={isGroupLocked} // 🚨 ロック状態に応じて無効化
                        style={{ width: '100%', padding: '8px', boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: '4px' }}
                    >
                        <option value="5-5">団体 5-5</option>
                        <option value="5-2">団体 5-2</option>
                    </select>
                </label>
                <button
                    type="button"
                    onClick={() => setIsGroupLocked(!isGroupLocked)} // 🚨 ボタンでロックを切り替え
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        backgroundColor: isGroupLocked ? '#f44336' : '#4CAF50', // ロック状態で色を変える
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        marginTop: '23px', // ラベルと入力欄の間に合うように調整
                        whiteSpace: 'nowrap'
                    }}
                >
                    {isGroupLocked ? '🔓 ロック解除' : '🔒 ロック中'}
                </button>
            </div>
        </div>
        
        {/* 商品入力セクション */}
        <div style={{ marginBottom: '15px', border: '1px solid #eee', padding: '10px', borderRadius: '4px' }}>
            <h4 style={{ marginTop: 0 }}>ご注文内容</h4>
            {error && <p style={{ color: 'red' }}>{error}</p>}
            {stockLimits ? (
                <div>
                    {[
                        { key: 'nikuman', name: '肉まん' },
                        { key: 'pizaman', name: 'ピザまん' },
                        { key: 'anman', name: 'あんまん' },
                        { key: 'chocoman', name: 'チョコまん' },
                        { key: 'oolongcha', name: '烏龍茶' },
                    ].map(({ key, name }) => {
                        const limit = stockLimits[key] || 0;
                        return (
                            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                <label htmlFor={key}>{name} (最大: {limit}個)</label>
                                <input
                                    id={key}
                                    type="number"
                                    min="0"
                                    max={limit}
                                    value={items[key]}
                                    onChange={(e) => handleItemChange(key, e.target.value)}
                                    style={{ width: '80px', padding: '5px', textAlign: 'right', border: '1px solid #ccc', borderRadius: '4px' }}
                                    disabled={limit === 0 || !stockLimits}
                                />
                            </div>
                        );
                    })}
                </div>
            ) : (
                <p>在庫情報を読み込み中...</p>
            )}
        </div>

        <div style={{ marginBottom: '10px' }}>
          <label>
            名前：
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
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
              style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
            />
          </label>
        </div>
        <div style={{ marginBottom: '20px' }}>
          <label>
            <input
              type="checkbox"
              checked={wantsLine}
              onChange={(e) => setWantsLine(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            LINEで通知希望
          </label>
        </div>
        <button
          type="submit"
          style={{ padding: '10px 20px', backgroundColor: '#4CAF50', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px' }}
        >
          登録
        </button>
      </form>
    </div>
  );
}
