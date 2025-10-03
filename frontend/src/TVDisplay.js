/* global __firebase_config, __initial_auth_token */
import React, { useEffect, useState, useMemo } from 'react';

// ====================================================================
// Firebase/API インポート
// ====================================================================
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, query, onSnapshot, where, orderBy, doc } from "firebase/firestore"; // docを追加
import { setLogLevel } from 'firebase/firestore'; // ログレベル設定

const firebaseConfig = process.env.REACT_APP_FIREBASE_CONFIG ? JSON.parse(process.env.REACT_APP_FIREBASE_CONFIG) : {};
const initialAuthToken = null; // グローバル変数への依存を排除

// 待ち状況を計算するための対象グループ
const AVAILABLE_GROUPS = ['5-5', '5-2'];

/**
 * 呼び出し番号の配列を圧縮して表示用の文字列に変換する関数
 * 例: [1, 2, 3, 5, 7, 8] => "1~3, 5, 7~8"
 * @param {number[]} numbers - 呼び出し番号の配列
 * @returns {string} 表示用の文字列
 */
const formatCalledNumbers = (numbers) => {
    if (!numbers || numbers.length === 0) return "";

    // 念のためソート
    const sorted = [...numbers].sort((a, b) => a - b);

    const ranges = [];
    let currentRange = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === sorted[i - 1] + 1) {
            currentRange.push(sorted[i]);
        } else {
            ranges.push(currentRange);
            currentRange = [sorted[i]];
        }
    }
    ranges.push(currentRange);

    return ranges.map(range => {
        if (range.length > 2) {
            return `${range[0]}~${range[range.length - 1]}`;
        }
        return range.join(', ');
    }).join(', ');
};


export default function TVDisplay() {
  const [db, setDb] = useState(null);
  const [calledNumbers, setCalledNumbers] = useState([]);
  const [waitingSummary, setWaitingSummary] = useState({ 
    '5-5': { groups: 0, people: 0 }, 
    '5-2': { groups: 0, people: 0 } 
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // 1. Firebaseの初期化と認証
  useEffect(() => {
    if (!Object.keys(firebaseConfig).length) {
      setError("Firebase設定が見つかりません。");
      setLoading(false);
      return;
    }
    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const authentication = getAuth(app);
      
      const authenticate = async () => {
        try {
          await signInAnonymously(authentication);
          setDb(firestore);
        } catch (e) {
          console.error("Firebase認証エラー:", e);
          setError("認証に失敗しました。");
          setLoading(false);
        }
      };
      authenticate();
    } catch (e) {
      console.error("Firebase初期化エラー:", e);
      setError("Firebaseの初期化に失敗しました。");
      setLoading(false);
    }
  }, []);

  // 2. onSnapshotによるリアルタイム購読
  useEffect(() => {
    if (!db) return;
    
    const reservationsQuery = query(
        collection(db, "reservations"),
        where('status', 'in', ['waiting', 'called']),
    );

    const unsubscribe = onSnapshot(reservationsQuery, (snapshot) => {
      let currentCalled = [];
      let summary = AVAILABLE_GROUPS.reduce((acc, group) => {
          acc[group] = { groups: 0, people: 0 };
          return acc;
      }, {});

      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.status === 'called') {
          currentCalled.push(data.number);
        }
        if (data.status === 'waiting' && AVAILABLE_GROUPS.includes(data.group)) {
          summary[data.group].groups += 1;
          summary[data.group].people += (data.people || 1);
        }
      });

      setCalledNumbers(currentCalled);
      setWaitingSummary(summary);
      setLoading(false);
      
    }, (err) => {
      console.error("Firestoreリスニングエラー:", err);
      setError("データ取得に失敗しました。");
      setLoading(false);
    });

    return () => unsubscribe();
  }, [db]);

  const formattedNumbersText = useMemo(() => formatCalledNumbers(calledNumbers), [calledNumbers]);

  const totalWaitingGroups = useMemo(() => {
    return AVAILABLE_GROUPS.reduce((sum, group) => sum + waitingSummary[group].groups, 0);
  }, [waitingSummary]);

  if (loading || !db) return <div style={styles.messageScreen}>⚡️ リアルタイムデータを読み込み中...</div>;
  if (error) return <div style={{...styles.messageScreen, color: 'red'}}>エラー: {error}</div>;

  return (
    <div style={styles.container}>
      {/* グローバルスタイル */}
      <style>{`
        body { margin: 0; font-family: 'Hiragino Sans', 'ヒラギノ角ゴシック', 'メイリオ', Meiryo, 'MS Pゴシック', sans-serif; }
        * { box-sizing: border-box; }
        @keyframes pulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.02); }
          100% { transform: scale(1); }
        }
      `}</style>
      
      {/* 呼び出し中の番号リスト */}
      <div style={styles.calledSection}> 
        <h1 style={styles.calledTitle}>現在呼び出し中の番号</h1>
        <div style={styles.calledNumberWrapper}>
            {calledNumbers.length > 0 ? (
                <span style={styles.calledNumberText}>{formattedNumbersText}</span>
            ) : (
                <span style={{...styles.calledNumberText, fontSize: '8vh', animation: 'none'}}>
                    {totalWaitingGroups > 0 ? `現在 ${totalWaitingGroups} 組待機中` : "受付終了"}
                </span>
            )}
        </div>
        <p style={styles.subText}>
          お呼び出し後、10分以内にお受け取りください。
        </p>
      </div>

      {/* 待ち状況エリア */}
      <div style={styles.waitingSection}>
        <h2 style={styles.waitingTitle}>現在の待ち状況</h2>
        <div style={styles.waitingGrid}>
          {AVAILABLE_GROUPS.map(group => (
              <div key={group} style={styles.waitingCard}>
                <h4 style={styles.waitingCardTitle}>団体 {group}</h4>
                <p style={styles.waitingCardText}>
                  {waitingSummary[group]?.groups ?? 0} 組 ({waitingSummary[group]?.people ?? 0} 人)
                </p>
              </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// レスポンシブなスタイル定義
const styles = {
    container: {
        width: '100vw',
        height: '100vh',
        backgroundColor: '#001f3f', // ネイビー
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
    },
    messageScreen: {
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '5vh',
        color: '#666',
        backgroundColor: '#f0f0f0',
    },
    calledSection: {
        flex: 3, // 画面の3/4を占める
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '2vh 2vw',
        borderBottom: '0.5vh solid #0074D9',
        textAlign: 'center',
    },
    calledTitle: {
        fontSize: '7vh',
        color: '#FF4136', // 赤
        margin: '0 0 2vh 0',
        fontWeight: '900',
    },
    calledNumberWrapper: {
        backgroundColor: '#fff',
        color: '#FF4136',
        borderRadius: '2vh',
        padding: '2vh 5vw',
        margin: '2vh 0',
        width: '90%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        animation: 'pulse 1.5s infinite',
        minHeight: '25vh',
    },
    calledNumberText: {
        fontSize: '18vh',
        fontWeight: '900',
        lineHeight: 1,
        wordBreak: 'break-all',
    },
    subText: {
        fontSize: '3.5vh',
        opacity: 0.9,
        marginTop: '2vh',
    },
    waitingSection: {
        flex: 1, // 画面の1/4を占める
        backgroundColor: '#001a33',
        padding: '2vh 2vw',
        width: '100%',
    },
    waitingTitle: {
        fontSize: '4vh',
        textAlign: 'center',
        margin: '0 0 2vh 0',
        color: '#7FDBFF', // ライトブルー
    },
    waitingGrid: {
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        height: '100%',
    },
    waitingCard: {
        backgroundColor: '#0074D9', // ブルー
        padding: '1.5vh 3vw',
        borderRadius: '1.5vh',
        textAlign: 'center',
        minWidth: '25vw',
    },
    waitingCardTitle: {
        fontSize: '4vh',
        margin: '0 0 1vh 0',
    },
    waitingCardText: {
        fontSize: '3vh',
        margin: 0,
    }
};
