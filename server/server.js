// 必要なライブラリをインポート
const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch'); // 🚨 修正: CommonJSの require を使用し、デプロイエラーを回避

// サーバーを初期化
const app = express();

// CORSを詳細に設定
app.use(cors({
    origin: '*',  // すべてのドメインからのアクセスを許可
    methods: ['GET', 'POST'] // GETとPOSTを許可
}));

// ミドルウェアの設定
app.use(express.json());

// 環境変数の設定（Render用）
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error("Firebase initialization failed. Check FIREBASE_SERVICE_ACCOUNT variable.");
    process.exit(1);
}

const db = admin.firestore();

// Firestoreのシステム設定ドキュメントを定義
const MAX_PER_PERSON_DOC = 'settings/system';

function startServer() {
    
    // util: send LINE push (🚨 エラー切り分けのため引き続き無効化)
    /*
    async function sendLinePush(toUserId, messageText) {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.LINE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: toUserId,
          messages: [{ type: 'text', text: messageText }]
        })
      });
      if (!res.ok) {
        console.error('LINE push failed', await res.text());
      }
    }
    */


    // ==========================================================
    // POST /api/reserve: ユーザーからの予約を受け付け、番号を付与
    // ==========================================================
    app.post('/api/reserve', async (req, res) => {
        
        const userData = req.body;
        
        // 必須フィールドの検証
        if (!userData.name || !userData.people || userData.people <= 0) {
            return res.status(400).send('Invalid reservation data (name or people missing).');
        }
        
        try {
            const result = await db.runTransaction(async (t) => {
                
                // 1. カウンターを取得 (settings/system/currentReservationNumber)
                const counterRef = db.doc(MAX_PER_PERSON_DOC);
                const counterSnap = await t.get(counterRef);
                
                let nextNumber = 1;
                if (counterSnap.exists && counterSnap.data().currentReservationNumber) {
                    // 🚨 採番ロジック: 現在の番号に+1
                    nextNumber = counterSnap.data().currentReservationNumber + 1;
                }
                
                // 2. カウンターを更新
                t.set(counterRef, { currentReservationNumber: nextNumber }, { merge: true });

                // 3. 予約ドキュメントを作成 (numberを付与)
                const newReservationRef = db.collection('reservations').doc();
                
                const reservationData = {
                    name: userData.name, 
                    people: parseInt(userData.people, 10), 
                    wantsLine: !!userData.wantsLine,
                    lineUserId: userData.lineUserId || null,
                    number: nextNumber, // 🚨 トランザクションで採番された番号
                    status: 'waiting',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    calledAt: null,
                    seatEnterAt: null,
                    notes: userData.notes || ""
                };
                
                t.set(newReservationRef, reservationData);

                return { success: true, number: nextNumber };
            });

            res.json(result);

        } catch (e) {
            console.error("Reservation registration failed:", e);
            res.status(500).send("Registration failed due to server error.");
        }
    });
    
    // ==========================================================
    // POST /api/compute-call (管理画面からの呼び出し実行)
    // ==========================================================

    app.post('/api/compute-call', async (req, res) => {
        
        // シークレットキーの確認 (403)
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        // 利用可能な席数（完成個数）の確認 (400)
        const available = parseInt(req.body.availableCount, 10);
        // 🚨 修正: 巨大な数字や空欄でNaNになる場合に400を返す
        if (isNaN(available) || available <= 0) {
            console.error(`Invalid availableCount received: ${req.body.availableCount}`);
            return res.status(400).send('bad available (must be a valid positive number)');
        }

        // maxPerPersonを取得
        const sdoc = await db.doc(MAX_PER_PERSON_DOC).get();
        // 🚨 修正: maxPerPersonがない場合は安全に1をデフォルトにする
        const M = (sdoc.exists && sdoc.data().maxPerPerson) ? sdoc.data().maxPerPerson : 1;

        // 待機中の予約を取得
        const waitingSnap = await db.collection('reservations')
          .where('status', '==', 'waiting')
          .orderBy('createdAt', 'asc')
          .get();

        let totalNeeded = 0;
        const selected = [];
        waitingSnap.forEach(doc => {
          if (totalNeeded >= available) return; // 席数が不足したらストップ
          const d = doc.data();
          const need = (d.people || 1) * M; // 必要な席数を計算
          if (totalNeeded + need <= available) {
            totalNeeded += need;
            selected.push({ id: doc.id, data: d });
          }
        });
        
        // 選択されたグループがない場合は、空の配列を返す
        if (selected.length === 0) {
            return res.json({ success: true, called: [], totalNeeded: 0 });
        }


        // update selected reservations to "called"
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const calledNumbers = [];
        
        // 🚨 最終修正: numberフィールドが存在しない予約をスキップせず、9999を付与して呼び出しクラッシュを防ぐ
        selected.forEach(item => {
            // numberがない場合は、古い予約だとみなし、仮の大きな番号を付与
            const reservationNumber = item.data.number !== undefined ? item.data.number : 9999;
          
            const rRef = db.collection('reservations').doc(item.id);
            
            // ドキュメントにも number フィールドを追加/更新する
            batch.update(rRef, { 
                status: 'called', 
                calledAt: now,
                number: reservationNumber // 呼び出し時にnumberを強制的に付与/更新
            });
          
            calledNumbers.push(reservationNumber);
        });

        // update /tv/state
        const tvRef = db.doc('tv/state');
        batch.set(tvRef, { currentCalled: calledNumbers, updatedAt: now }, { merge: true });

        await batch.commit();

        // LINE notify for those who want it (fire-and-forget) - 🚨 無効化中
        /*
        selected.forEach(item => {
          if (item.data.wantsLine && item.data.lineUserId) {
            const text = `ご準備ができました。番号 ${item.data.number} さん、受付へお戻りください。`;
            sendLinePush(item.data.lineUserId, text).catch(e => console.error(e));
          }
        });
        */

        // log
        await db.collection('logs').add({
          type: 'call',
          reservationIds: selected.map(s=>s.id),
          available,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, called: calledNumbers, totalNeeded });
    });

    // GET /api/tv-status
    app.get('/api/tv-status', async (req, res) => {
        const doc = await db.doc('tv/state').get();
        res.json(doc.exists ? doc.data() : { currentCalled: [], updatedAt: null });
    });

    // サーバーの待ち受け開始
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, ()=> console.log('Server on', PORT));
}

// サーバー起動関数を実行
startServer();
