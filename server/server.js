// 必要なライブラリをインポート
const express = require('express');
const cors = require('cors'); // 必須
const admin = require('firebase-admin');
// dynamic import() を使う
let fetch;
import('node-fetch').then(nodeFetch => {
    fetch = nodeFetch.default;
});

// サーバーを初期化
const app = express();

// CORSを詳細に設定（この行だけ残す！）
app.use(cors({
    origin: '*',  // ← すべてのドメインからのアクセスを許可
    methods: ['GET', 'POST'] // ← GETとPOSTを許可
}));

// ミドルウェアの設定
app.use(express.json());

// 環境変数の設定（この部分はRender用でOK）
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const MAX_PER_PERSON_DOC = 'settings/system';

// util: send LINE push
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

// POST /api/compute-call
// body: { availableCount: number, apiSecret: string }
app.post('/api/compute-call', async (req, res) => {
  if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
  const available = parseInt(req.body.availableCount, 10);
  if (isNaN(available) || available <= 0) return res.status(400).send('bad available');

  // get maxPerPerson
  const sdoc = await db.doc(MAX_PER_PERSON_DOC).get();
  const M = (sdoc.exists && sdoc.data().maxPerPerson) ? sdoc.data().maxPerPerson : 1;

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
  selected.forEach(item => {
    const rRef = db.collection('reservations').doc(item.id);
    batch.update(rRef, { status: 'called', calledAt: now });
    calledNumbers.push(item.data.number);
  });

  // update /tv/state
  const tvRef = db.doc('tv/state');
  batch.set(tvRef, { currentCalled: calledNumbers, updatedAt: now }, { merge: true });

  await batch.commit();

  // LINE notify for those who want it (fire-and-forget)
  selected.forEach(item => {
    if (item.data.wantsLine && item.data.lineUserId) {
      const text = `ご準備ができました。番号 ${item.data.number} さん、受付へお戻りください。`;
      sendLinePush(item.data.lineUserId, text).catch(e => console.error(e));
    }
  });

  // log
  await db.collection('logs').add({
    type: 'call',
    reservationIds: selected.map(s=>s.id),
    available,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ success: true, called: calledNumbers, totalNeeded });
});

app.get('/api/tv-status', async (req, res) => {
  const doc = await db.doc('tv/state').get();
  res.json(doc.exists ? doc.data() : { currentCalled: [], updatedAt: null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server on', PORT));

