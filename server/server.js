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
// Webhookイベント応答に必要な関数
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
// POST /api/line-webhook: LINEからのイベント処理 (番号入力/変更承認ロジック)
// ==========================================================
app.post('/api/line-webhook', async (req, res) => {
    
    // 署名検証は省略
    
    const events = req.body.events;
    if (!events || events.length === 0) return res.sendStatus(200);

    for (const event of events) {
        const lineUserId = event.source.userId;
        const replyToken = event.replyToken;

        // -----------------------------------------------------
        // 1. 友だち追加時 (follow)
        // -----------------------------------------------------
        if (event.type === 'follow') {
            const message = '友だち追加ありがとうございます！\n準備完了の通知をご希望の場合は、お手持ちの「受付番号」をメッセージで送信してください。例: 12';
            await sendLineReply(replyToken, message);
        } 
        
        // -----------------------------------------------------
        // 2. テキストメッセージ受信時 (message type: text)
        // -----------------------------------------------------
        else if (event.type === 'message' && event.message.type === 'text') {
            
            const inputText = event.message.text.trim();
            
            // 「はい」のメッセージは、次のセクションで特別に処理
            if (inputText === 'はい') {
                
                // 🚨 自分のIDが pendingLineUserId に設定されている予約を探す
                const pendingSnap = await db.collection('reservations')
                    .where('pendingLineUserId', '==', lineUserId)
                    .where('status', '==', 'waiting') 
                    .limit(1)
                    .get();

                if (pendingSnap.empty) {
                    // 「はい」と送ってきたが、保留中の変更がない場合
                    await sendLineReply(replyToken, '申し訳ありません、変更を保留中の番号が見つかりませんでした。再度番号を送信してください。');
                    continue;
                }
                
                const docRef = pendingSnap.docs[0].ref;
                const reservationNumber = pendingSnap.docs[0].data().number;

                // 変更を実行
                await docRef.update({
                    lineUserId: lineUserId,         // 🚨 新しいIDに更新
                    pendingLineUserId: admin.firestore.FieldValue.delete() // 🚨 保留フィールドを削除
                });

                const successMessage = `番号 ${reservationNumber} の通知先を、このアカウントに変更しました！準備ができたら通知します。`;
                await sendLineReply(replyToken, successMessage);
                continue; // 処理完了
            }


            // 予約番号の入力処理
            const reservationNumber = parseInt(inputText, 10);

            // A. 有効な数値ではない場合（文字などが送られてきた場合）
            if (isNaN(reservationNumber) || reservationNumber <= 0) {
                const message = '申し訳ありません、通知設定には「受付番号」の**半角数字**が必要です。番号を再入力してください。';
                await sendLineReply(replyToken, message);
                continue;
            }

            // B. 予約番号の検索
            const reservationSnap = await db.collection('reservations')
                .where('number', '==', reservationNumber)
                .where('status', '==', 'waiting')  
                .where('wantsLine', '==', true) 
                .limit(1)
                .get();

            if (reservationSnap.empty) {
                // 予約が見つからない場合
                const message = `番号 ${reservationNumber} の「待機中」の予約は見つかりませんでした。番号を確認してください。`;
                await sendLineReply(replyToken, message);
                continue;
            }

            // 該当予約のデータとリファレンス
            const doc = reservationSnap.docs[0];
            const docData = doc.data();
            const docRef = doc.ref;
            
            // C. 既にLINE IDが紐付いているかチェック
            if (docData.lineUserId) {
                // 紐付いているLINE IDが自分自身のものである場合 (二重通知設定)
                if (docData.lineUserId === lineUserId) {
                    const message = `番号 ${reservationNumber} は既にあなたのLINEに紐付け済みです。準備ができたら通知します！`;
                    await sendLineReply(replyToken, message);
                } else {
                    // 🚨 別のユーザーのLINE IDが紐付いている場合（変更要求）
                    const message = `番号 ${reservationNumber} は、既に別のLINEアカウントに紐付けされています。\n\n**この番号の通知先を、このアカウントに変更しますか？**\n\n変更する場合は【はい】と返信してください。`;
                    await sendLineReply(replyToken, message);
                    
                    // 🚨 暫定的な「変更希望」を記録
                    await docRef.update({
                        pendingLineUserId: lineUserId // このLINE IDが変更を希望している
                    });
                }
                continue; 
            }

            // D. 新規紐付けの実行
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
