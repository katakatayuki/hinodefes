// 必要なライブラリをインポート
const express = require('express');
const cors = require('cors'); // 必須
const admin = require('firebase-admin');
const fetch = require('node-fetch'); // CommonJS形式でインポート

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
// このコードはRenderの環境変数から認証情報を取得する
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const MAX_PER_PERSON_DOC = 'settings/system';

// サーバー起動とルーティングを非同期関数でラップ
async function startServer() {
    
    // util: send LINE push (🚨 サーバークラッシュ防止のため、一時的に無効化)
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

    // POST /api/compute-call
    // body: { availableCount: number, apiSecret: string }
    app.post('/api/compute-call', async (req, res) => {
        // シークレットキーの確認 (403)
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        // 利用可能な席数の確認 (400)
        const available = parseInt(req.body.availableCount, 10);
        if (isNaN(available) || available <= 0) return res.status(400).send('bad available');

        // maxPerPersonを取得
        const sdoc = await db.doc(MAX_PER_PERSON_DOC).get();
        const M = (sdoc.exists && sdoc.data().maxPerPerson) ? sdoc.data().maxPerPerson : 1;

        // 待機中の予約を取得（Firestoreインデックスが必要です）
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
              console.error(`Reservation ID ${item.id} is missing 'number' field and was skipped.`);
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

        // LINE notify for those who want it (fire-and-forget) - 🚨 現在無効化中
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
startServer().catch(e => {
    console.error("FATAL SERVER CRASH:", e);
    // Renderのログに残すために、ここでアプリを終了させる
    process.exit(1); 
});
