const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch'); // node-fetchを使う場合はインストールが必要です

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
// LINE Push通知ユーティリティ (管理画面からの呼び出し用)
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
// LINE Replyユーティリティ (Webhook応答用)
// ==========================================================
// Webhookイベント応答に必要な関数（最初のコードブロックから採用）
async function sendLineReply(replyToken, messageText) {
    if (!process.env.LINE_ACCESS_TOKEN) return;

    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.LINE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            replyToken: replyToken, // Webhookイベントの応答トークン
            messages: [{ type: 'text', text: messageText }]
        })
    });
    if (!res.ok) {
        console.error('LINE reply failed:', res.status, await res.text());
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
// POST /api/line-webhook: LINEからのイベント処理 (番号入力による紐付け)
// ==========================================================
// 🚨 こちらは番号入力による紐付けロジックを採用
app.post('/api/line-webhook', async (req, res) => {
    
    // 🚨 簡略化のため署名検証は省略しますが、本来は必須です。
    // const signature = req.headers['x-line-signature'];
    
    const events = req.body.events;
    if (!events || events.length === 0) return res.sendStatus(200);

    for (const event of events) {
        const lineUserId = event.source.userId;
        const replyToken = event.replyToken;

        if (event.type === 'follow') {
            // 1. 友だち追加時: 応答メッセージで番号入力を促す
            const message = '友だち追加ありがとうございます！\n準備完了の通知をご希望の場合は、お手持ちの「受付番号」をメッセージで送信してください。例: 12';
            await sendLineReply(replyToken, message);

        } else if (event.type === 'message' && event.message.type === 'text') {
            
            const inputText = event.message.text.trim();
            const reservationNumber = parseInt(inputText, 10);

            // 2. テキストメッセージ受信時: 予約番号の紐付けを試みる
            if (isNaN(reservationNumber) || reservationNumber <= 0) {
                // 有効な数値ではない場合
                await sendLineReply(replyToken, `「${inputText}」は有効な番号ではありません。受付番号を半角数字で再入力してください。`);
                continue;
            }

            // 3. Firestoreで該当番号の予約を検索
            const reservationSnap = await db.collection('reservations')
                .where('number', '==', reservationNumber)
                .where('status', '==', 'waiting') // 待機中のみ
                .where('wantsLine', '==', true) // LINE通知希望者のみ
                .limit(1)
                .get();

            if (reservationSnap.empty) {
                // 予約が見つからない場合
                await sendLineReply(replyToken, `番号 ${reservationNumber} の「待機中」の予約は見つかりませんでした。番号を確認してください。`);
                continue;
            }

            // 4. IDの紐付けを実行
            const docRef = reservationSnap.docs[0].ref;
            
            // 既にこのLINE IDが紐付いているかチェック (二重登録防止)
            if (reservationSnap.docs[0].data().lineUserId === lineUserId) {
                await sendLineReply(replyToken, `番号 ${reservationNumber} は既にあなたのLINEに紐付け済みです。準備ができたら通知します！`);
                continue;
            }

            // 5. FirestoreにIDを書き込み、ユーザーに成功を通知
            await docRef.update({ lineUserId: lineUserId });

            const successMessage = `番号 ${reservationNumber} をあなたのLINEに紐付けました。準備ができたら通知します！`;
            await sendLineReply(replyToken, successMessage);
            console.log(`Successfully linked LINE ID ${lineUserId} to number ${reservationNumber}.`);

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
            // Promiseをcatchすることで、通知失敗が全体の処理を止めないようにする
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
// GET /api/tv-status (TV表示用ルート)
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
// GET /api/reservations (管理画面用ルート)
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
