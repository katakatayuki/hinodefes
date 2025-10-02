import React, { useState, useEffect, useCallback } from 'react';

// 🚨 【要変更】あなたのRenderサーバーのURLに置き換えてください
const SERVER_URL = "https://hinodefes.onrender.com"; 
// 🚨 【要変更】LINE友だち追QRコード画像のURLに置き換えてください
// Firebase Hostingにアップロードした画像パスを設定
const LINE_QR_CODE_URL = 'https://hinodefes-57609.web.app/QRCODE.png'; 

export default function Reception() {
  const [name, setName] = useState('');
  const [people, setPeople] = useState(1);
  // LINE通知希望のチェックボックスの状態
  const [wantsLine, setWantsLine] = useState(false);
  
  // 団体名 ('5-5'プルダウン形式を維持)
  const [group, setGroup] = useState(() => {
      const savedGroup = localStorage.getItem('lastGroup');
      return savedGroup || '5-5'; 
  });

  const AVAILABLE_GROUPS = ['5-5']; 
  const [isGroupLocked, setIsGroupLocked] = useState(true);

  // 予約状態
  const [isReserved, setIsReserved] = useState(false);
  const [reservedNumber, setReservedNumber] = useState(null);
  
  // 注文アイテム
  const [items, setItems] = useState({
    nikuman: 0,
    pizaman: 0,
    anman: 0,
    chocoman: 0,
    oolongcha: 0,
  });
  
  const [stockLimits, setStockLimits] = useState(null); 
  // 🚨 修正: lineUserIdとshowLineIdInputのStateを削除
  const [loading, setLoading] = useState(true); 
  const [error, setError] = useState(null); 
  const [reservationMessage, setReservationMessage] = useState(null); 

  // 商品リスト (表示用)
  const itemNames = {
    nikuman: '肉まん',
    pizaman: 'ピザまん',
    anman: 'あんまん',
    chocoman: 'チョコまん',
    oolongcha: '烏龍茶',
  };

  /**
   * 在庫情報をサーバーから取得し、状態を更新する関数
   */
  const fetchStockLimits = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${SERVER_URL}/api/stock-limits`);
      
      if (!response.ok) {
        throw new Error('在庫情報の取得に失敗しました。サーバーが応答していません。');
      }
      
      const data = await response.json();
      setStockLimits(data);
      
    } catch (err) {
      console.error("Error fetching stock limits:", err);
      setError('在庫情報の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 初回ロード時にのみ在庫情報を取得するEffect
   */
  useEffect(() => {
    fetchStockLimits();
  }, [fetchStockLimits]); 

  // Group Lock/Unlock のトグル
  const handleLockToggle = () => {
    setIsGroupLocked(!isGroupLocked);
  };

  // 注文数の変更ハンドラ
  const handleItemChange = (key, value) => {
    const amount = Math.max(0, parseInt(value, 10) || 0);
    setItems(prev => ({
      ...prev,
      [key]: amount,
    }));
  };

  // 予約登録処理
  const handleSubmit = async (e) => {
    e.preventDefault();
    setReservationMessage(null);
    setError(null);
    
    // 注文が0でないかチェック
    const totalOrder = Object.values(items).reduce((sum, count) => sum + count, 0);
    if (totalOrder === 0) {
      setReservationMessage({ type: 'error', text: '注文する商品を1つ以上選択してください。' });
      return;
    }

    // 在庫チェック (クライアント側でも念のため実施)
    let hasStockError = false;
    if (stockLimits) {
      for (const key in items) {
        const ordered = items[key];
        const remaining = stockLimits[key] || 0;
        if (ordered > remaining) {
          setReservationMessage({ type: 'error', text: `${itemNames[key]}の注文数が在庫上限を超えています。` });
          hasStockError = true;
          break;
        }
      }
    }
    if (hasStockError) return;

    // 予約データの作成 (lineUserIdは常にnullで送信)
    const reservationData = {
      name,
      group,
      people: Number(people),
      items,
      wantsLine,
      lineUserId: null, // 🚨 修正: ユーザーIDは送信しない
    };

    try {
      const response = await fetch(`${SERVER_URL}/api/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reservationData),
      });

      const result = await response.json();

      if (!response.ok) {
        const errorText = result.error || '予約処理中にエラーが発生しました。';
        setReservationMessage({ type: 'error', text: errorText });
        return;
      }

      // 予約成功
      setReservedNumber(result.number);
      setIsReserved(true);
      localStorage.setItem('lastGroup', group); 

      // 予約成功後に在庫情報をリロードして最新の状態を反映
      fetchStockLimits();
      
      setReservationMessage({ type: 'success', text: `${result.number}番で予約を受け付けました！` });

    } catch (err) {
      console.error("Network Error during reservation:", err);
      setReservationMessage({ type: 'error', text: '通信エラーが発生しました。インターネット接続を確認してください。' });
    }
  };

  // 予約成功後の画面（QRコード表示）
  if (isReserved) {
    return (
      <div style={{ padding: '20px', maxWidth: '500px', margin: '20px auto', backgroundColor: '#f9f9f9', border: '1px solid #ccc', borderRadius: '8px', textAlign: 'center' }}>
        <div style={{ fontSize: '30px', color: 'green', marginBottom: '10px' }}>✓</div>
        <h1 style={{ fontSize: '24px', color: '#333', marginBottom: '10px' }}>受付完了</h1>
        <p style={{ fontSize: '18px', marginBottom: '20px' }}>受付番号: <span style={{ fontSize: '36px', color: 'red', fontWeight: 'bold' }}>{reservedNumber}</span></p>
        
        {wantsLine && (
          // 🚨 修正: LINE通知希望の場合、QRコード表示のみ
          <div style={{ marginTop: '15px', padding: '15px', border: '1px solid #ddd', backgroundColor: '#fff', borderRadius: '6px' }}>
            <p style={{ fontWeight: 'bold', color: '#555', marginBottom: '10px' }}>LINE通知をご希望です。</p>
            <p style={{ fontSize: '14px', color: 'red', marginBottom: '10px', fontWeight: 'bold' }}>
              お客様にQRコードを読み込んでいただくようお伝えください。
            </p>
            <img 
              src={LINE_QR_CODE_URL} 
              alt="LINE友だち追加QRコード" 
              style={{ width: '150px', height: '150px', margin: '0 auto', border: '1px solid #aaa' }} 
              onError={(e) => { e.target.onerror = null; e.target.src = "https://placehold.co/150x150/cccccc/333333?text=QR%20Code" }}
            />
            <p style={{ fontSize: '14px', marginTop: '10px' }}>QRコードをスキャンして友だち追加してください。</p>
          </div>
        )}

        <button 
          onClick={() => window.location.reload()}
          style={{ marginTop: '20px', width: '100%', padding: '10px', backgroundColor: '#6c757d', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px' }}
        >
          新しい予約を受け付ける
        </button>
      </div>
    );
  }

  // 通常の予約フォーム
  return (
    <div style={{ padding: '20px', maxWidth: '500px', margin: '20px auto', backgroundColor: '#f9f9f9', border: '1px solid #ccc', borderRadius: '8px' }}>
      <h1 style={{ fontSize: '22px', borderBottom: '2px solid #333', paddingBottom: '5px', marginBottom: '20px' }}>ご注文受付</h1>
      
      {/* メッセージ表示エリア */}
      {reservationMessage && (
        <div style={{ 
          padding: '10px', 
          marginBottom: '15px', 
          borderRadius: '4px', 
          fontWeight: 'bold', 
          border: reservationMessage.type === 'error' ? '1px solid red' : '1px solid green',
          backgroundColor: reservationMessage.type === 'error' ? '#ffebeb' : '#ebfff0',
          color: reservationMessage.type === 'error' ? 'red' : 'green'
        }}>
          {reservationMessage.text}
        </div>
      )}

      {/* グループ選択とロック */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '15px', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', backgroundColor: '#eee' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 'bold', color: '#333', marginRight: '10px' }}>団体名 (クラス)</h2>
        
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          required
          disabled={isGroupLocked}
          style={{ flexGrow: 1, padding: '8px', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: isGroupLocked ? '#ddd' : 'white', marginRight: '5px' }}
        >
          {AVAILABLE_GROUPS.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        
        <button 
          onClick={handleLockToggle}
          type="button"
          style={{ padding: '8px', border: 'none', cursor: 'pointer', borderRadius: '4px', color: 'white', backgroundColor: isGroupLocked ? '#dc3545' : '#28a745' }}
          title={isGroupLocked ? 'グループのロックを解除' : 'グループをロック'}
        >
          {isGroupLocked ? '🔒' : '🔓'}
        </button>
      </div>


      <form onSubmit={handleSubmit}>
        
        {/* ご注文内容 (在庫制限) */}
        <div style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: '#fff' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 'bold', borderBottom: '1px solid #eee', paddingBottom: '5px', marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>ご注文内容</span>
              <button 
                type="button" 
                onClick={fetchStockLimits}
                style={{ background: 'none', border: '1px solid #ccc', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                title="手動で在庫をリロード"
              >
                {loading ? 'リロード中...' : 'リロード'}
              </button>
          </h2>

          {loading && (
            <p style={{ color: '#007bff', fontWeight: 'bold' }}>在庫情報を読み込み中...</p>
          )}

          {error && (
            <p style={{ color: 'red', fontWeight: 'bold' }}>エラー: {error}</p>
          )}

          {stockLimits && !loading && (
            <div style={{ display: 'grid', gap: '10px' }}>
              {Object.keys(itemNames).map((key) => {
                const remaining = stockLimits[key] !== undefined ? stockLimits[key] : '---';
                const isSoldOut = remaining === 0;
                
                return (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', border: '1px solid #eee', borderRadius: '4px', backgroundColor: isSoldOut ? '#fdd' : 'white' }}>
                    <span style={{ fontWeight: 'normal', color: isSoldOut ? '#999' : '#333' }}>
                      {itemNames[key]}
                    </span>
                    <span style={{ fontSize: '14px', fontWeight: 'bold', color: isSoldOut ? 'red' : '#007bff', marginRight: '10px' }}>
                      残り: {remaining} {isSoldOut && '(完売)'}
                    </span>
                    <input
                      type="number"
                      value={items[key]}
                      min={0}
                      max={remaining}
                      onChange={(e) => handleItemChange(key, e.target.value)}
                      disabled={isSoldOut}
                      style={{ width: '60px', textAlign: 'center', padding: '5px', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: isSoldOut ? '#ddd' : 'white' }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 基本情報入力 */}
        <div style={{ marginBottom: '20px', display: 'grid', gap: '10px' }}>
            <div>
                <label>
                    <span style={{ fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>人数 (必須)</span>
                    <input
                      type="number"
                      value={people}
                      min={1}
                      onChange={(e) => setPeople(e.target.value)}
                      required
                      style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
                    />
                </label>
            </div>
            <div>
                <label>
                    <span style={{ fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>名前 (必須)</span>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
                    />
                </label>
            </div>
        </div>


        {/* LINE通知設定 (QRコード方式) */}
        <div style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ffc107', backgroundColor: '#fffbe5', borderRadius: '4px' }}>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={wantsLine}
              // 🚨 修正: LINE ID入力がなくなったため、チェックボックス変更で他の状態を変更する必要なし
              onChange={(e) => setWantsLine(e.target.checked)}
              style={{ marginRight: '10px', width: '18px', height: '18px' }}
            />
            <span style={{ fontWeight: 'bold', color: '#856404' }}>LINEで通知希望</span>
          </label>
        </div>

        <button
          type="submit"
          disabled={loading || error || !stockLimits || Object.values(items).reduce((sum, count) => sum + count, 0) === 0}
          style={{ 
            width: '100%', 
            padding: '12px', 
            fontSize: '18px', 
            fontWeight: 'bold', 
            border: 'none', 
            cursor: loading || error || !stockLimits || Object.values(items).reduce((sum, count) => sum + count, 0) === 0 ? 'not-allowed' : 'pointer', 
            borderRadius: '4px', 
            color: 'white',
            backgroundColor: loading || error || !stockLimits || Object.values(items).reduce((sum, count) => sum + count, 0) === 0 ? '#6c757d' : '#4CAF50' 
          }}
        >
          {loading ? '処理中...' : 'この内容で登録する'}
        </button>
        {error && <p style={{ color: 'red', marginTop: '5px', textAlign: 'center' }}>エラーのため登録できません。</p>}
      </form>
    </div>
  );
}
