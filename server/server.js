const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// CORSを詳細に設定
app.use(cors({
    origin: '*',  // すべてのドメインからのアクセスを許可
    // 🚨 修正: DELETEとPUTメソッドを追加して管理画面の全機能（削除・更新）を許可
    methods: ['GET', 'POST', 'DELETE', 'PUT'] 
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
const COUNTER_DOC = 'settings/counters';

// ==========================================================
// LINE Push/Reply Utility
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

async function sendLineReply(replyToken, messageText) {
    if (!process.env.LINE_ACCESS_TOKEN) {
        console.error("LINE_ACCESS_TOKEN is not set.");
        return;
    }
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
        console.error('LINE reply failed:', res.status, await res.text());
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
// POST /api/line-webhook: LINE Webhook処理
// ==========================================================
app.post('/api/line-webhook', async (req, res) => {
    if (!process.env.LINE_SECRET || !process.env.LINE_ACCESS_TOKEN) return res.sendStatus(500);
    // 署名検証ロジックとメッセージ処理ロジックをここに記述
    // 省略していますが、本番環境では必ず署名検証を実装してください。
    
    // シンプルなオウム返し処理 (本番用ではない)
    const events = req.body.events;
    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const replyText = `現在、受付は予約番号でのみ機能しています。\n受付で表示された番号が「呼び出し中」になったら、ご来店ください。`;
            sendLineReply(event.replyToken, replyText).catch(console.error);
        } else if (event.type === 'follow') {
            const followText = `ご登録ありがとうございます。\n受付でLINE通知を希望すると、順番が来た際にお知らせします。`;
            sendLineReply(event.replyToken, followText).catch(console.error);
        }
    }
    res.sendStatus(200);
});


// ==========================================================
// POST /api/compute-call: TV表示リストの更新
// ==========================================================
app.post('/api/compute-call', async (req, res) => {
    
    try {
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        const availablePeople = parseInt(req.body.availableCount, 10); 
        const callGroup = req.body.callGroup; 
        
        // 予約選択処理
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
        
        // 1. 現在のTV表示ステータスを取得
        const tvSnap = await tvRef.get(); 
        const currentCalled = tvSnap.exists && tvSnap.data().currentCalled
                                 ? tvSnap.data().currentCalled
                                 : [];
        
        selected.forEach(item => {
            const reservationNumber = item.data.number !== undefined ? item.data.number : '99-99'; 
            const rRef = db.collection('reservations').doc(item.id);
            
            // ステータスを 'called' に更新
            batch.update(rRef, { 
                status: 'called', 
                calledAt: now,
                number: reservationNumber
            });
            
            calledNumbers.push(reservationNumber);
            
            // LINE通知の実行 (非同期で実行)
            if (item.data.wantsLine && item.data.lineUserId) {
                const text = `ご準備ができました。番号 ${reservationNumber} さん、受付へお戻りください。`;
                sendLinePush(item.data.lineUserId, text).catch(e => console.error(e));
            }
        });

        // 🚨 修正2-A: TV表示リストを更新する際、最大10個に制限する
        const newCalledSet = new Set([...currentCalled, ...calledNumbers]);
        let updatedCalledList = Array.from(newCalledSet); 

        // **Firestoreのin句制限（10個）を回避するためにリストを最大10個にスライス**
        if (updatedCalledList.length > 10) {
            // 最新の10個のみを保持する
            updatedCalledList = updatedCalledList.slice(-10); 
        }

        // 3. バッチでTV表示用のドキュメントを更新
        batch.set(tvRef, { 
            currentCalled: updatedCalledList, 
            updatedAt: now 
        }, { merge: true }); 

        await batch.commit();

        res.json({ success: true, called: calledNumbers, totalNeeded });

    } catch (e) {
        console.error("CRITICAL ERROR IN COMPUTE-CALL:", e); 
        return res.status(500).send("Internal Server Error. Check Render logs for details.");
    }
});


// ==========================================================
// GET /api/waiting-summary: 待ち状況サマリー
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
// GET /api/tv-status: TV表示用ルート (10分ルール適用 & 制限回避)
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

        // 🚨 修正2-B: Firestoreにクエリを投げる前に、リストを最大10個にスライス
        let numbersToQuery = data.currentCalled;
        if (numbersToQuery.length > 10) {
            // サーバー側で取得したリストも10個にスライスして、クエリの制限を超えないようにする
            numbersToQuery = numbersToQuery.slice(-10); 
        }

        // TVに表示中の番号を再確認し、10分ルールを適用
        const calledReservationSnap = await db.collection('reservations')
            .where('status', 'in', ['called', 'seatEnter']) 
            // 🚨 スライスされた numbersToQuery を使用
            .where('number', 'in', numbersToQuery) 
            .get();
            
        const stillCalledNumbers = [];
        const TEN_MINUTES_MS = 10 * 60 * 1000;

        calledReservationSnap.forEach(rDoc => {
            const rData = rDoc.data();
            if (!rData.calledAt) return; 

            // calledAtがTimestampオブジェクトであることを確認し、Dateオブジェクトに変換
            const calledAt = rData.calledAt.toDate(); 
            
            // 呼び出し時刻から10分以内なら表示を継続
            if (now.getTime() - calledAt.getTime() < TEN_MINUTES_MS) {
                stillCalledNumbers.push(rData.number);
            }
        });

        // 応答: 10分経過していない番号のリストを返す
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


// ==========================================================
// 🚨 PUT /api/reservations/:id (管理画面からのステータス更新)
// ==========================================================
app.put('/api/reservations/:id', async (req, res) => {
    try {
        // APIシークレットによる認証
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        const { id } = req.params;
        const { status } = req.body;
        
        const validStatuses = ['waiting', 'called', 'seatEnter', 'cancel'];
        if (!validStatuses.includes(status)) {
            return res.status(400).send('Invalid status value.');
        }

        const reservationRef = db.collection('reservations').doc(id);
        
        const updateData = { status };
        
        // ステータスに応じたタイムスタンプ更新
        if (status === 'called') {
            updateData.calledAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.seatEnterAt = null; // 念のため着席時刻はリセット
        } else if (status === 'seatEnter') {
            updateData.seatEnterAt = admin.firestore.FieldValue.serverTimestamp();
        } else if (status === 'waiting') {
            // waitingに戻す場合は、calledAtとseatEnterAtをリセット
            updateData.calledAt = null;
            updateData.seatEnterAt = null;
        } else if (status === 'cancel') {
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
// 🚨 DELETE /api/reservations/:id (管理画面からの削除)
// ==========================================================
app.delete('/api/reservations/:id', async (req, res) => {
    try {
        // APIシークレットによる認証
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
