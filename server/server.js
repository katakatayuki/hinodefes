// 必要なライブラリをインポート
const express = require('express');
const cors = require('cors'); // 必須
const admin = require('firebase-admin');
const fetch = require('node-fetch'); // 🚨 修正: await import ではなく require を使用

// サーバーを初期化
const app = express();

// CORSを詳細に設定
app.use(cors({
    origin: '*',  // ← すべてのドメインからのアクセスを許可
    methods: ['GET', 'POST'] // ← GETとPOSTを許可
}));

// ミドルウェアの設定
app.use(express.json());

// 環境変数の設定（Render用）
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Firestoreのシステム設定ドキュメントを定義
const MAX_PER_PERSON_DOC = 'settings/system';

// サーバー起動とルーティングを非同期関数でラップ (fetchのawait import回避のため、async関数は不要)
function startServer() {
    
    // util: send LINE push (🚨 エラー切り分けのため無効化)
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
    // 🚨 必須: ユーザーからの予約を受け付け、番号を付与するルート
    // ==========================================================
    // POST /api/reserve
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
                    number: nextNumber, // 🚨 これが重要
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
        
        // 利用可能な席数の確認 (400)
        const available = parseInt(req.body.availableCount, 10);
        if (isNaN(available) || available <= 0) return res.status(400).send('bad available');

        // maxPerPersonを取得
        const sdoc = await db.doc(MAX_PER_PERSON_DOC).get();
        const M = (sdoc.exists && sdoc.data().maxPerPerson) ? sdoc.data().maxPerPerson : 1;

        // 待機中の予約を取得
        const waitingSnap = await db.collection('reservations')
          .where('status', '==', 'waiting')
          .orderBy('createdAt', 'asc')
          .get();

        let totalNeeded = 0;
        const selected = [];
        waitingSnap.forEach(doc => {
          if (totalNeeded >= available) return;
          const d = doc.data();
          const need = (d.people || 1) * M;
          if (totalNeeded + need <= available) {
            totalNeeded += need;
            selected.push({ id: doc.id, data: d });
          }
        });

        // update selected reservations to "called"
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const calledNumbers = [];
        
        // 🚨 修正: numberフィールドが存在しない予約をスキップし、undefinedエラーを防ぐ
        selected.forEach(item => {
          if (item.data.number === undefined) {
              console.error(`Reservation ID ${item.id} is missing 'number' field and was skipped. Call failed.`);
              return; // numberがない予約は処理をスキップ
          }
          
          const rRef = db.collection('reservations').doc(item.id);
          batch.update(rRef, { status: 'called', calledAt: now });
          calledNumbers.push(item.data.number);
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

// サーバー起動関数を実行し、エラーをキャッチ
startServer(); // async関数ではないため、catchは不要
