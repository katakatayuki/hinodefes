const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// CORSを詳細に設定
app.use(cors({
    origin: '*',  // すべてのドメインからのアクセスを許可
    // 🚨 修正1: DELETEとPUTメソッドを追加して管理画面の全機能（削除・更新）を許可
    methods: ['GET', 'POST', 'DELETE', 'PUT'] 
}));

app.use(express.json());

// Firebaseの初期化
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
const COUNTER_DOC = 'settings/counters';

// ==========================================================
// LINE Push/Reply Utility (エラーログ強化版)
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
        const errorText = await res.text();
        console.error('LINE push failed:', res.status, errorText);
    }
}

async function sendLineReply(replyToken, messageText) {
    if (!process.env.LINE_ACCESS_TOKEN) return;

    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.LINE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            replyToken: replyToken,
            messages: [{ type: 'text', text: messageText }]
        })
    });
    if (!res.ok) {
        const errorText = await res.text();
        console.error('LINE reply failed:', res.status, errorText);
    }
}

// ==========================================================
// LINE Webhookイベントを非同期で処理する関数
// ==========================================================
async function processLineWebhookEvents(events, db) {
    const admin = require('firebase-admin'); // 関数内で使うため再取得
    
    for (const event of events) {
        // LINEユーザーIDと応答トークンを取得
        const lineUserId = event.source.userId;
        const replyToken = event.replyToken;
        const inputText = (event.type === 'message' && event.message.type === 'text') ? event.message.text.trim() : null;

        // -----------------------------------------------------
        // 1. 友だち追加時 (follow)
        // -----------------------------------------------------
        if (event.type === 'follow') {
            const message = '友だち追加ありがとうございます！\n準備完了の通知をご希望の場合は、お手持ちの「受付番号」をメッセージで送信してください。例: 55-1';
            await sendLineReply(replyToken, message);
        }

        // -----------------------------------------------------
        // 2. 「はい」のメッセージ受信時 (変更承認)
        // -----------------------------------------------------
        else if (event.type === 'message' && inputText === 'はい') {
            const pendingSnap = await db.collection('reservations')
                .where('pendingLineUserId', '==', lineUserId)
                .where('status', '==', 'waiting')
                .limit(1)
                .get();

            if (pendingSnap.empty) {
                await sendLineReply(replyToken, '申し訳ありません、変更を保留中の番号が見つかりませんでした。再度番号を送信してください。');
                continue;
            }

            const docRef = pendingSnap.docs[0].ref;
            const reservationNumber = pendingSnap.docs[0].data().number;

            await docRef.update({
                lineUserId: lineUserId,
                pendingLineUserId: admin.firestore.FieldValue.delete()
            });

            const successMessage = `番号 ${reservationNumber} の通知先を、このアカウントに変更しました！準備ができたら通知します。`;
            await sendLineReply(replyToken, successMessage);
        }

        // -----------------------------------------------------
        // 3. テキストメッセージ受信時 (番号入力による新規紐付け/変更確認)
        // -----------------------------------------------------
        else if (event.type === 'message' && event.message.type === 'text') {
            
            const reservationNumber = inputText; 

            if (!reservationNumber) {
                const message = '申し訳ありません、通知設定には「受付番号」が必要です。番号を再入力してください。例: 55-1';
                await sendLineReply(replyToken, message);
                continue;
            }

            const reservationSnap = await db.collection('reservations')
                .where('number', '==', reservationNumber)
                .where('status', 'in', ['waiting', 'called'])
                .where('wantsLine', '==', true)
                .limit(1)
                .get();

            if (reservationSnap.empty) {
                const message = `番号 ${reservationNumber} の「待機中」または「呼び出し中」の予約は見つかりませんでした。番号を確認してください。`;
                await sendLineReply(replyToken, message);
                continue;
            }

            const doc = reservationSnap.docs[0];
            const docData = doc.data();
            const docRef = doc.ref;

            // 既にLINE IDが紐付いているかチェック
            if (docData.lineUserId) {
                if (docData.lineUserId === lineUserId) {
                    const message = `番号 ${reservationNumber} は既にあなたのLINEに紐付け済みです。準備ができたら通知します！`;
                    await sendLineReply(replyToken, message);
                } else {
                    const message = `番号 ${reservationNumber} は、既に別のLINEアカウントに紐付けされています。\n\n**この番号の通知先を、このアカウントに変更しますか？**\n\n変更する場合は【はい】と返信してください。`;
                    await sendLineReply(replyToken, message);
                    // 変更を保留中の状態として保存
                    await docRef.update({
                        pendingLineUserId: lineUserId
                    });
                }
                continue;
            }

            // 新規紐付けの実行
            await docRef.update({ lineUserId: lineUserId });

            const successMessage = `番号 ${reservationNumber} をあなたのLINEに紐付けました。準備ができたら通知します！`;
            await sendLineReply(replyToken, successMessage);
            console.log(`Successfully linked LINE ID ${lineUserId} to number ${reservationNumber}.`);
        }
    }
}

// ==========================================================
// POST /api/reserve: 予約登録
// ==========================================================
app.post('/api/reserve', async (req, res) => {
    const userData = req.body;
    if (!userData.name || !userData.people || userData.people <= 0 || !userData.group) { 
        return res.status(400).send('Invalid reservation data (name, people, or group missing).');
    }
    const groupPrefix = userData.group.replace('-', '');
    const groupCounterKey = `counter_${groupPrefix}`;

    try {
        const result = await db.runTransaction(async (t) => {
            const counterRef = db.doc(COUNTER_DOC);
            const counterSnap = await t.get(counterRef);
            let nextNumber = 1;
            if (counterSnap.exists && counterSnap.data()[groupCounterKey]) {
                nextNumber = counterSnap.data()[groupCounterKey] + 1;
            }
            const updateData = {};
            updateData[groupCounterKey] = nextNumber;
            t.set(counterRef, updateData, { merge: true });

            const newReservationRef = db.collection('reservations').doc();
            const fullReservationNumber = `${groupPrefix}-${nextNumber}`; 
            
            const reservationData = {
                name: userData.name, 
                people: parseInt(userData.people, 10), 
                wantsLine: !!userData.wantsLine,
                lineUserId: userData.lineUserId || null,
                group: userData.group,
                number: fullReservationNumber,
                status: 'waiting',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                calledAt: null,
                seatEnterAt: null,
                notes: userData.notes || ""
            };
            t.set(newReservationRef, reservationData);
            return { success: true, number: fullReservationNumber, id: newReservationRef.id }; 
        });
        res.json(result);
    } catch (e) {
        console.error("Reservation registration failed:", e);
        res.status(500).send("Registration failed due to server error.");
    }
});


// ==========================================================
// POST /api/line-webhook: LINEからのイベント処理 (即時応答を確保)
// ==========================================================
app.post('/api/line-webhook', async (req, res) => {

    if (!process.env.LINE_SECRET || !process.env.LINE_ACCESS_TOKEN) {
        console.error("LINE env variables are missing.");
        return res.sendStatus(500);
    }
    
    // 🚨 最重要: LINEの応答期限(3秒)を遵守するため、即座に200 OKを返す
    res.sendStatus(200);

    // イベント処理はres.sendStatus(200)の後に非同期で開始する
    try {
        const events = req.body.events;
        if (events && events.length > 0) {
            // 非同期で実行し、応答速度を確保
            processLineWebhookEvents(events, db).catch(e => {
                console.error("Error initiating LINE event processing:", e);
            });
        }
    } catch (e) {
        // req.bodyのパース失敗など、リクエスト受信時のエラー
        console.error("Error processing LINE webhook request body:", e);
    }
});


// ==========================================================
// POST /api/compute-call (呼び出し計算とTV表示更新)
// ==========================================================
app.post('/api/compute-call', async (req, res) => {
    try {
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        const availablePeople = parseInt(req.body.availableCount, 10); 
        const callGroup = req.body.callGroup; 
        
        if (isNaN(availablePeople) || availablePeople <= 0) {  
            return res.status(400).send('bad available (must be a valid positive number)');
        }
        if (!callGroup || (callGroup !== '5-5' && callGroup !== '5-2')) {
            return res.status(400).send('bad callGroup (must be 5-5 or 5-2)');
        }

        let waitingQuery = db.collection('reservations')
          .where('status', '==', 'waiting')
          .where('group', '==', callGroup)
          .orderBy('createdAt', 'asc');
          
        const waitingSnap = await waitingQuery.get();

        let totalNeeded = 0;
        const selected = [];
        
        waitingSnap.forEach(doc => {
          if (totalNeeded >= availablePeople) return; 
          const d = doc.data();
          const need = d.people || 1; 
          if (totalNeeded + need <= availablePeople) {
            totalNeeded += need; 
            selected.push({ id: doc.id, data: d });
          }
        });

        if (selected.length === 0) {
            return res.json({ success: true, called: [], totalNeeded: 0 });
        }
        
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const calledNumbers = [];
        const tvRef = db.doc('tv/state');
        
        const tvSnap = await tvRef.get(); 
        const currentCalled = tvSnap.exists && tvSnap.data().currentCalled
                             ? tvSnap.data().currentCalled
                             : [];
        
        selected.forEach(item => {
            const reservationNumber = item.data.number !== undefined ? item.data.number : '99-99'; 
            const rRef = db.collection('reservations').doc(item.id);
            
            batch.update(rRef, { 
                status: 'called', 
                calledAt: now,
                number: reservationNumber
            });
            
            calledNumbers.push(reservationNumber);
            
            if (item.data.wantsLine && item.data.lineUserId) {
                const text = `ご準備ができました。番号 ${reservationNumber} さん、受付へお戻りください。`;
                sendLinePush(item.data.lineUserId, text).catch(e => console.error(e));
            }
        });

        // 1. 既存のリストと新しく呼び出す番号を結合し、重複を排除
        const newCalledSet = new Set([...currentCalled, ...calledNumbers]);
        let updatedCalledList = Array.from(newCalledSet); 

        // 2. 🚨 修正2: Firestoreのinクエリの制限（最大10個）を回避するため、リストを最大10個に制限する
        // 最新の10個のみを保持するために、配列の末尾10要素をスライスします。
        if (updatedCalledList.length > 10) { 
            updatedCalledList = updatedCalledList.slice(-10); 
        }

        // 3. TV表示用のドキュメントを更新
        batch.set(tvRef, { 
            currentCalled: updatedCalledList, 
            updatedAt: now 
        }, { merge: true }); 

        // 4. トランザクションをコミット
        await batch.commit();

        await db.collection('logs').add({
            type: 'call',
            reservationIds: selected.map(s=>s.id),
            available: availablePeople,
            callGroup: callGroup,
            calledNumbers: calledNumbers,
            createdAt: now
        });

        res.json({ success: true, called: calledNumbers, totalNeeded });

    } catch (e) {
        console.error("CRITICAL ERROR IN COMPUTE-CALL:", e); 
        return res.status(500).send("Internal Server Error. Check Render logs for details.");
    }
});


// ==========================================================
// GET /api/waiting-summary
// ==========================================================
app.get('/api/waiting-summary', async (req, res) => {
    try {
        const waitingSnap = await db.collection('reservations')
            .where('status', '==', 'waiting')
            .get();

        const summary = {
            '5-5': { groups: 0, people: 0 },
            '5-2': { groups: 0, people: 0 },
        };
        
        waitingSnap.forEach(doc => {
            const data = doc.data();
            const groupKey = data.group; 
            const people = data.people || 1;
            
            if (summary.hasOwnProperty(groupKey)) {
                summary[groupKey].groups += 1;
                summary[groupKey].people += people;
            }
        });

        res.json(summary);

    } catch (e) {
        console.error("Error fetching waiting summary:", e);
        res.status(500).json({ error: "Failed to fetch summary" });
    }
});


// ==========================================================
// GET /api/tv-status
// ==========================================================
app.get('/api/tv-status', async (req, res) => {
    try {
        const doc = await db.doc('tv/state').get();
        if (!doc.exists) {
            return res.json({ currentCalled: [], updatedAt: null });
        }

        const data = doc.data();
        const now = new Date();
        
        if (!data.currentCalled || data.currentCalled.length === 0) {
            return res.json({ currentCalled: [], updatedAt: data.updatedAt });
        }

        // Firestoreのin句制限を回避するため、クエリに渡すリストを最大10個にスライス
        let numbersToQuery = data.currentCalled;
        if (numbersToQuery.length > 10) {
            numbersToQuery = numbersToQuery.slice(-10);
        }

        // numbersToQueryを使用
        const calledReservationSnap = await db.collection('reservations')
            .where('status', 'in', ['called', 'seatEnter']) 
            .where('number', 'in', numbersToQuery) 
            .get();
            
        const stillCalledNumbers = [];
        const TEN_MINUTES_MS = 10 * 60 * 1000;

        calledReservationSnap.forEach(rDoc => {
            const rData = rDoc.data();
            if (!rData.calledAt) return; 

            const calledAt = rData.calledAt.toDate(); 
            
            // 呼び出し時刻から10分以内なら表示を継続
            if (now.getTime() - calledAt.getTime() < TEN_MINUTES_MS) {
                stillCalledNumbers.push(rData.number);
            }
        });

        res.json({ currentCalled: stillCalledNumbers, updatedAt: data.updatedAt });

    } catch (e) {
        console.error("Error fetching tv status:", e);
        res.status(500).json({ error: "Failed to fetch status" });
    }
});

// ==========================================================
// GET /api/reservations (管理画面用ルート)
// ==========================================================
app.get('/api/reservations', async (req, res) => {
    try {
        const snap = await db.collection('reservations')
            .orderBy('createdAt', 'desc')
            .limit(100)
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

// ==========================================================
// PUT /api/reservations/:id (管理画面からのステータス更新)
// ==========================================================
app.put('/api/reservations/:id', async (req, res) => {
    try {
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        const { id } = req.params;
        const { status } = req.body;
        
        const validStatuses = ['waiting', 'called', 'seatEnter', 'cancel'];
        if (!validStatuses.includes(status)) {
            return res.status(400).send('Invalid status value.');
        }

        const reservationRef = db.collection('reservations').doc(id);
        
        const updateData = { status };
        
        if (status === 'called') {
            updateData.calledAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.seatEnterAt = null;
        } else if (status === 'seatEnter') {
            updateData.seatEnterAt = admin.firestore.FieldValue.serverTimestamp();
        } else if (status === 'waiting' || status === 'cancel') {
            updateData.calledAt = null;
            updateData.seatEnterAt = null;
        }

        await reservationRef.update(updateData);
        
        res.json({ success: true, id, newStatus: status });

    } catch (e) {
        console.error(`Error updating reservation ${req.params.id}:`, e);
        res.status(500).send("Status update failed.");
    }
});

// ==========================================================
// DELETE /api/reservations/:id (管理画面からの削除)
// ==========================================================
app.delete('/api/reservations/:id', async (req, res) => {
    try {
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        const { id } = req.params;

        const reservationRef = db.collection('reservations').doc(id);
        
        await reservationRef.delete();
        
        res.json({ success: true, id });

    } catch (e) {
        console.error(`Error deleting reservation ${req.params.id}:`, e);
        res.status(500).send("Reservation deletion failed.");
    }
});


// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server is running on port ${PORT}`));
