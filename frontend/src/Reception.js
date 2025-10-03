import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, onSnapshot } from 'firebase/firestore';

// ====================================================================
// サーバーとLINEのQRコード設定
// ====================================================================

// 🚨 【要変更】あなたのRenderサーバーのURLに置き換えてください
const SERVER_URL = "https://hinodefes.onrender.com";

// 🚨 【要変更】LINE友だち追加用QRコード画像のURLに置き換えてください
const LINE_QR_CODE_URL = 'https://hinodefes-57609.web.app/QRCODE.png';

// ====================================================================
// Firebase 設定
// 環境変数から読み込むことを推奨します
// ====================================================================

const firebaseConfig = process.env.REACT_APP_FIREBASE_CONFIG
  ? JSON.parse(process.env.REACT_APP_FIREBASE_CONFIG)
  : {};

// ====================================================================
// メインコンポーネント
// ====================================================================

export default function Reception() {
  // ----------------------------------------------------------------
  // 状態管理 (State)
  // ----------------------------------------------------------------

  // Firebaseインスタンス
  const [db, setDb] = useState(null);

  // フォーム入力値
  const [name, setName] = useState('');
  const [people, setPeople] = useState(1);
  const [wantsLine, setWantsLine] = useState(false);
  const [group, setGroup] = useState(() => localStorage.getItem('lastGroup') || '5-5');
  const [items, setItems] = useState({
    nikuman: 0,
    pizaman: 0,
    anman: 0,
    chocoman: 0,
    oolongcha: 0,
  });

  // 在庫管理（リアルタイム更新用）
  const [stockLimits, setStockLimits] = useState(null); // 最大在庫数
  const [salesStats, setSalesStats] = useState(null); // 販売実績

  // UI制御
  const [isReserved, setIsReserved] = useState(false);
  const [reservedNumber, setReservedNumber] = useState(null);
  const [loading, setLoading] = useState(true); // 初期化・データ取得ローディング
  const [submitting, setSubmitting] = useState(false); // フォーム送信中
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null); // 成功・エラーメッセージ

  // ----------------------------------------------------------------
  // 定数・計算済みプロパティ
  // ----------------------------------------------------------------

  // 商品リスト (表示名とキーをマッピング)
  const itemMaster = useMemo(() => ({
    nikuman: { name: '肉まん', price: 200 },
    pizaman: { name: 'ピザまん', price: 200 },
    anman: { name: 'あんまん', price: 200 },
    chocoman: { name: 'チョコまん', price: 200 },
    oolongcha: { name: '烏龍茶', price: 100 },
  }), []);

  // 残り在庫数をリアルタイムで計算
  const remainingStock = useMemo(() => {
    if (!stockLimits || !salesStats) return null;
    const remaining = {};
    for (const key in itemMaster) {
      const max = stockLimits[key] || 0;
      const sold = salesStats[key] || 0;
      remaining[key] = Math.max(0, max - sold);
    }
    return remaining;
  }, [stockLimits, salesStats, itemMaster]);

  // 合計注文数と合計金額を計算
  const totalOrderCount = Object.values(items).reduce((sum, count) => sum + count, 0);
  const totalPrice = Object.entries(items).reduce((sum, [key, count]) => {
      return sum + (itemMaster[key].price * count);
  }, 0);


  // ----------------------------------------------------------------
  // Firebase 初期化と認証
  // ----------------------------------------------------------------

  useEffect(() => {
    if (!Object.keys(firebaseConfig).length) {
      setError("Firebase設定が見つかりません。");
      setLoading(false);
      return;
    }
    try {
      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
      const auth = getAuth(app);
      const firestore = getFirestore(app);
      
      setDb(firestore);

      // 匿名認証でFirestoreへの読み取りアクセスを確保
      if (!auth.currentUser) {
        signInAnonymously(auth).catch(authError => {
          console.error("Firebase匿名認証エラー:", authError);
          setError("データベースへの接続に失敗しました。");
        });
      }
    } catch (e) {
      console.error("Firebase初期化エラー:", e);
      setError("アプリケーションの初期化に失敗しました。");
      setLoading(false);
    }
  }, []);

  // ----------------------------------------------------------------
  // リアルタイム在庫監視 (Firestore onSnapshot)
  // ----------------------------------------------------------------

  useEffect(() => {
    if (!db) return;

    setLoading(true);

    const unsubStock = onSnapshot(doc(db, 'settings', 'stockLimits'), (docSnap) => {
      if (docSnap.exists()) {
        setStockLimits(docSnap.data());
      } else {
        setError("在庫上限設定が見つかりません。");
      }
    }, (err) => {
      console.error("在庫上限の購読エラー:", err);
      setError("在庫上限の取得に失敗しました。");
    });

    const unsubSales = onSnapshot(doc(db, 'settings', 'salesStats'), (docSnap) => {
      if (docSnap.exists()) {
        setSalesStats(docSnap.data());
      } else {
        // 販売実績がない場合は全て0とみなす
        setSalesStats({ nikuman: 0, pizaman: 0, anman: 0, chocoman: 0, oolongcha: 0 });
      }
      setLoading(false); // 両方のデータが揃ったらローディング完了
    }, (err) => {
      console.error("販売実績の購読エラー:", err);
      setError("販売実績の取得に失敗しました。");
      setLoading(false);
    });

    return () => {
      unsubStock();
      unsubSales();
    };
  }, [db]);


  // ----------------------------------------------------------------
  // イベントハンドラ
  // ----------------------------------------------------------------

  // 注文数変更
  const handleItemChange = useCallback((key, value) => {
    const amount = Math.max(0, parseInt(value, 10) || 0);
    const stock = remainingStock ? remainingStock[key] : 0;
    
    // 在庫数を超えないように制限
    setItems(prev => ({
      ...prev,
      [key]: Math.min(amount, stock),
    }));
  }, [remainingStock]);

  // 新規予約の開始
  const handleNewReservation = () => {
    setIsReserved(false);
    setReservedNumber(null);
    setName('');
    setPeople(1);
    setWantsLine(false);
    setItems({ nikuman: 0, pizaman: 0, anman: 0, chocoman: 0, oolongcha: 0 });
    setMessage(null);
  };

  // フォーム送信（予約登録）
  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage(null);

    // バリデーション
    if (!name.trim()) {
      setMessage({ type: 'error', text: '氏名を入力してください。' });
      return;
    }
    if (totalOrderCount === 0) {
      setMessage({ type: 'error', text: '商品を1つ以上選択してください。' });
      return;
    }

    setSubmitting(true);

    const reservationData = {
      name: name.trim(),
      group,
      people: Number(people),
      items,
      wantsLine,
      lineUserId: null, // LINE IDはサーバー側で紐付けするため常にnull
    };

    try {
      const response = await fetch(`${SERVER_URL}/api/reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reservationData),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || '予約処理中にサーバーエラーが発生しました。');
      }
      
      // 予約成功
      setReservedNumber(result.number);
      setIsReserved(true);
      localStorage.setItem('lastGroup', group);

    } catch (err) {
      console.error("予約処理中のエラー:", err);
      setMessage({ type: 'error', text: err.message || '通信エラーが発生しました。' });
    } finally {
      setSubmitting(false);
    }
  };


  // ----------------------------------------------------------------
  // レンダリング
  // ----------------------------------------------------------------

  // ローディング中
  if (loading) {
    return <div style={styles.container}><h1>在庫情報を読み込み中...</h1></div>;
  }

  // エラー発生時
  if (error) {
    return <div style={styles.container}><h1 style={{color: 'red'}}>エラー: {error}</h1></div>;
  }

  // 予約完了画面
  if (isReserved) {
    return (
      <div style={{...styles.container, ...styles.centered}}>
        <div style={styles.card}>
          <div style={{ fontSize: '3rem', color: '#28a745' }}>✓</div>
          <h1 style={styles.h1}>受付完了</h1>
          <p style={{ fontSize: '1.2rem', margin: '1rem 0' }}>
            受付番号: <span style={styles.reservedNumber}>{reservedNumber}</span>
          </p>
          {wantsLine && (
            <div style={styles.lineBox}>
              <p style={{ fontWeight: 'bold' }}>LINE通知をご希望のお客様へ</p>
              <p style={{ fontSize: '0.9rem', color: '#c00' }}>
                お手数ですが、以下のQRコードを読み込んで「番号」を送信してください。
              </p>
              <img src={LINE_QR_CODE_URL} alt="LINE QR Code" style={{ width: '150px', height: '150px', marginTop: '1rem' }}/>
            </div>
          )}
          <button onClick={handleNewReservation} style={{...styles.button, ...styles.newButton}}>
            新規受付
          </button>
        </div>
      </div>
    );
  }

  // 受付フォーム画面
  return (
    <div style={styles.container}>
      <div style={{...styles.card, maxWidth: '600px'}}>
        <h1 style={styles.h1}>予約受付フォーム</h1>
        
        <form onSubmit={handleSubmit}>
          {/* 基本情報 */}
          <div style={styles.formSection}>
            <div style={styles.formGroup}>
              <label style={styles.label}>氏名</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={styles.input} placeholder="例: 日野フエス"/>
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>人数</label>
              <input type="number" value={people} onChange={(e) => setPeople(Math.max(1, e.target.value))} min="1" required style={styles.input}/>
            </div>
          </div>
          
          {/* 商品注文 */}
          <div style={{...styles.formSection, borderTop: '1px solid #eee', paddingTop: '1rem'}}>
            <h2 style={styles.h2}>ご注文</h2>
            <div style={styles.itemGrid}>
              {Object.entries(itemMaster).map(([key, { name }]) => {
                const stock = remainingStock ? remainingStock[key] : 0;
                const isSoldOut = stock === 0;
                return (
                  <div key={key} style={styles.itemRow}>
                    <label style={{...styles.label, flex: 3, color: isSoldOut ? '#aaa' : '#333'}}>{name}</label>
                    <span style={{flex: 2, color: isSoldOut ? 'red' : '#555', fontWeight: 'bold' }}>
                      {isSoldOut ? "完売" : `残り: ${stock}`}
                    </span>
                    <input
                      type="number"
                      value={items[key]}
                      onChange={(e) => handleItemChange(key, e.target.value)}
                      min="0"
                      max={stock}
                      disabled={isSoldOut}
                      style={{...styles.input, flex: 1, textAlign: 'center'}}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* 合計 */}
          <div style={styles.totalBox}>
            <span>合計: <strong>{totalPrice.toLocaleString()} 円</strong> ({totalOrderCount} 点)</span>
          </div>

          {/* LINE通知 */}
          <div style={styles.lineCheckbox}>
            <label>
              <input
                type="checkbox"
                checked={wantsLine}
                onChange={(e) => setWantsLine(e.target.checked)}
                style={{ marginRight: '10px' }}
              />
              LINEで呼び出し通知を受け取る
            </label>
          </div>
          
          {/* メッセージ表示 */}
          {message && (
             <div style={{...styles.message, backgroundColor: message.type === 'error' ? '#f8d7da' : '#d4edda', color: message.type === 'error' ? '#721c24' : '#155724'}}>
              {message.text}
            </div>
          )}

          {/* 送信ボタン */}
          <button type="submit" disabled={submitting || totalOrderCount === 0} style={{...styles.button, ...styles.submitButton}}>
            {submitting ? '予約中...' : 'この内容で予約する'}
          </button>
        </form>
      </div>
    </div>
  );
}


// ====================================================================
// スタイル定義
// ====================================================================

const styles = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    backgroundColor: '#f0f2f5',
    minHeight: '100vh',
    padding: '2rem',
    boxSizing: 'border-box',
  },
  centered: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: 'white',
    borderRadius: '12px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
    padding: '2rem',
    margin: '0 auto',
    width: '100%',
  },
  h1: {
    textAlign: 'center',
    color: '#333',
    marginBottom: '2rem',
    borderBottom: '2px solid #4CAF50',
    paddingBottom: '0.5rem',
  },
  h2: {
    fontSize: '1.2rem',
    color: '#555',
    marginBottom: '1rem',
  },
  formSection: {
    marginBottom: '1.5rem',
  },
  formGroup: {
    marginBottom: '1rem',
  },
  label: {
    display: 'block',
    marginBottom: '0.5rem',
    color: '#333',
    fontWeight: '600',
  },
  input: {
    width: '100%',
    padding: '0.75rem',
    border: '1px solid #ccc',
    borderRadius: '6px',
    fontSize: '1rem',
    boxSizing: 'border-box',
  },
  itemGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  itemRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  totalBox: {
    textAlign: 'right',
    fontSize: '1.2rem',
    fontWeight: 'bold',
    margin: '1.5rem 0',
    padding: '1rem',
    backgroundColor: '#e9f5e9',
    borderRadius: '6px',
  },
  lineCheckbox: {
    margin: '1.5rem 0',
    padding: '1rem',
    backgroundColor: '#fffbe6',
    border: '1px solid #ffeeba',
    borderRadius: '6px',
    textAlign: 'center',
  },
  message: {
    padding: '1rem',
    borderRadius: '6px',
    margin: '1rem 0',
    textAlign: 'center',
  },
  button: {
    width: '100%',
    padding: '1rem',
    fontSize: '1.1rem',
    fontWeight: 'bold',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  submitButton: {
    backgroundColor: '#4CAF50',
    color: 'white',
    ':disabled': {
        backgroundColor: '#aaa',
        cursor: 'not-allowed',
    }
  },
  newButton: {
      backgroundColor: '#007bff',
      color: 'white',
      marginTop: '1.5rem',
  },
  reservedNumber: {
    fontSize: '3rem',
    color: '#d9534f',
    fontWeight: 'bold',
  },
  lineBox: {
    marginTop: '1.5rem',
    padding: '1.5rem',
    border: '1px solid #ddd',
    backgroundColor: '#f9f9f9',
    borderRadius: '8px',
    textAlign: 'center',
  },
};
