// server.js (最終版 - 省略なし)
const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// CORSを詳細に設定
app.use(cors({
    origin: '*',  // すべてのドメインからのアクセスを許可
    methods: ['GET', 'POST']
}));

app.use(express.json());

// Firebaseの初期化
try {
    // 🚨 環境変数からサービスアカウントキーを読み込む
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error("Firebase initialization failed. Check FIREBASE_SERVICE_ACCOUNT variable.");
    process.exit(1);
}

const db = admin.firestore();
const MAX_PER_PERSON_DOC = 'settings/system';

// ==========================================================
// LINE Push通知ユーティリティ
// ==========================================================

async function sendLinePush(toUserId, messageText) {
    if (!process.env.LINE_ACCESS_TOKEN) {
        console.error("LINE_ACCESS_TOKEN is not set.");
        return;
    }

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
        console.error('LINE push failed:', res.status, await res.text());
    }
}


// ==========================================================
// POST /api/reserve: 予約登録と連番採番 (フロントエンドから叩く)
// ==========================================================
app.post('/api/reserve', async (req, res) => {
    
    const userData = req.body;
    
    if (!userData.name || !userData.people || userData.people <= 0) {
        return res.status(400).send('Invalid reservation data (name or people missing).');
    }
    
    try {
        const result = await db.runTransaction(async (t) => {
            
            // 1. カウンターを取得し、連番を採番
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
                number: nextNumber, // トランザクションで採番された番号
                status: 'waiting',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                calledAt: null,
                seatEnterAt: null,
                notes: userData.notes || ""
            };
            
            t.set(newReservationRef, reservationData);

            return { success: true, number: nextNumber, id: newReservationRef.id };
        });

        res.json(result);

    } catch (e) {
        console.error("Reservation registration failed:", e);
        res.status(500).send("Registration failed due to server error.");
    }
});

// ==========================================================
// POST /api/line-webhook: LINEからのイベント処理 (友だち追加時)
// ==========================================================

app.post('/api/line-webhook', async (req, res) => {
    
    const events = req.body.events;
    
    if (!events || events.length === 0) {
        return res.sendStatus(200);
    }

    for (const event of events) {
        // 友だち追加（follow）イベントのみ処理
        if (event.type === 'follow') {
            const lineUserId = event.source.userId;
            
            // 1. 紐付けるべき最新の「waiting」予約ドキュメントを検索
            const latestReservationSnap = await db.collection('reservations')
                .where('status', '==', 'waiting')
                .where('lineUserId', '==', null)
                .where('wantsLine', '==', true)
                .orderBy('createdAt', 'desc') 
                .limit(1)
                .get();

            if (!latestReservationSnap.empty) {
                const docRef = latestReservationSnap.docs[0].ref;
                
                // 2. 最新の予約にLINE IDを書き込み
                await docRef.update({
                    lineUserId: lineUserId
                });
                
                console.log(`LINE ID ${lineUserId} を予約 ${docRef.id} に紐付けました。`);
            } else {
                console.log(`LINE ID ${lineUserId} の最新の予約が見つかりませんでした。`);
            }
        }
    }

    res.sendStatus(200);
});


// ==========================================================
// POST /api/compute-call (管理画面からの呼び出し実行)
// ==========================================================

app.post('/api/compute-call', async (req, res) => {
    
    if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
    
    const available = parseInt(req.body.availableCount, 10);
    if (isNaN(available) || available <= 0) {
        return res.status(400).send('bad available (must be a valid positive number)');
    }

    const sdoc = await db.doc(MAX_PER_PERSON_DOC).get();
    const M = (sdoc.exists && sdoc.data().maxPerPerson) ? sdoc.data().maxPerPerson : 1;

    const waitingSnap = await db.collection('reservations')
      .where('status', '==', 'waiting')
      .orderBy('createdAt', 'asc') // FIFO
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
    
    if (selected.length === 0) {
        return res.json({ success: true, called: [], totalNeeded: 0 });
    }

    // Firestoreの更新とLINE通知
    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const calledNumbers = [];
    
    selected.forEach(item => {
        // numberがない予約にフォールバック値（9999）を付与してクラッシュを防ぐ
        const reservationNumber = item.data.number !== undefined ? item.data.number : 9999;
        
        const rRef = db.collection('reservations').doc(item.id);
        
        batch.update(rRef, { 
            status: 'called', 
            calledAt: now,
            number: reservationNumber
        });
        
        calledNumbers.push(reservationNumber);
        
        // LINE通知の実行
        if (item.data.wantsLine && item.data.lineUserId) {
            const text = `ご準備ができました。番号 ${reservationNumber} さん、受付へお戻りください。`;
            sendLinePush(item.data.lineUserId, text).catch(e => console.error(e));
        }
    });

    // update /tv/state
    const tvRef = db.doc('tv/state');
    batch.set(tvRef, { currentCalled: calledNumbers, updatedAt: now }, { merge: true });

    await batch.commit();

    await db.collection('logs').add({
        type: 'call',
        reservationIds: selected.map(s=>s.id),
        available,
        createdAt: now
    });

    res.json({ success: true, called: calledNumbers, totalNeeded });
});

// ==========================================================
// GET /api/tv-status (省略されていたTV表示用ルート)
// ==========================================================
app.get('/api/tv-status', async (req, res) => {
    // 現在呼び出し中の番号リストを返す
    try {
        const doc = await db.doc('tv/state').get();
        res.json(doc.exists ? doc.data() : { currentCalled: [], updatedAt: null });
    } catch (e) {
        console.error("Error fetching tv status:", e);
        res.status(500).json({ error: "Failed to fetch status" });
    }
});

// ==========================================================
// GET /api/reservations (省略されていた管理画面用ルート)
// ==========================================================
app.get('/api/reservations', async (req, res) => {
    // すべての予約リストを返す（管理画面で一覧表示に使う）
    try {
        const snap = await db.collection('reservations')
            .orderBy('createdAt', 'desc')
            .limit(100) // 最新100件に制限
            .get();

        const reservations = snap.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        
        res.json(reservations);
    } catch (e) {
        console.error("Error fetching reservations:", e);
        res.status(500).json({ error: "Failed to fetch reservations" });
    }
});


// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server on', PORT));
