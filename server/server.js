const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

const SALES_STATS_DOC = 'settings/salesStats';
const WAITING_SUMMARY_DOC = 'summary/waiting'; // 待ち状況サマリー



// ==========================================================
// サーバー設定
// ==========================================================
// CORSを詳細に設定
app.use(cors({
    origin: '*',  // すべてのドメインからのアクセスを許可
    methods: ['GET', 'POST', 'DELETE', 'PUT'] 
}));

app.use(express.json());

// Firebaseの初期化
try {
    // 環境変数からサービスアカウント情報をロード（Renderなどの環境を想定）
    let serviceAccount;
    
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT環境変数が設定されていません。");
    }

    try {
        // JSON文字列をパース
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (parseError) {
        // パースエラーが発生した場合、詳細をログに出力
        console.error("🔥 JSON PARSE ERROR: FIREBASE_SERVICE_ACCOUNTのJSON形式が不正です。改行や不要な文字がないか確認してください。", parseError.message);
        throw new Error("JSON形式エラー");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin SDK initialized successfully.");

} catch (e) {
    console.error(`❌ Firebase initialization failed. Reason: ${e.message}`, e);
    process.exit(1);
}

const db = admin.firestore();
const COUNTER_DOC = 'settings/counters';

// server.js の任意の場所に追加

// server.js のどこかにある、GET /api/stock-limits ルート全体を以下のコードに置き換えてください。
// ==========================================================
// 🚨 【維持】/api/stock-limits: 在庫数は受付画面で必要なため維持
// ==========================================================
app.get('/api/stock-limits', async (req, res) => {
    try {
        const [stockDoc, salesDoc] = await Promise.all([
            db.doc('settings/stockLimits').get(),
            db.doc(SALES_STATS_DOC).get()
        ]);

        const maxLimits = stockDoc.exists ? stockDoc.data() : {};
        const salesStats = salesDoc.exists ? salesDoc.data() : {};
        const itemKeys = ['nikuman', 'pizaman', 'anman', 'chocoman', 'oolongcha'];

        const remainingStock = {};
        itemKeys.forEach(key => {
            const max = maxLimits[key] || 0;
            const sold = salesStats[key] || 0;
            remainingStock[key] = Math.max(0, max - sold);
        });

        res.json(remainingStock);
    } catch (e) {
        console.error("Error fetching remaining stock limits:", e);
        res.status(500).json({ error: "Failed to fetch stock limits" });
    }
});
// ==========================================================
// GET /api/sales-stats: 販売実績の取得 (Admin.jsが使用)
// ==========================================================
app.get('/api/sales-stats', async (req, res) => {
    try {
        // 1. Firestoreから販売実績ドキュメントを取得
        // パス: 'settings/salesStats'
        const salesDoc = await db.doc('settings/salesStats').get(); 

        if (!salesDoc.exists) {
            // ドキュメントがない場合、全ての販売実績を0として返す
            return res.json({
                nikuman: 0,
                pizaman: 0,
                anman: 0,
                chocoman: 0,
                oolongcha: 0,
            });
        }
        
        // 2. 取得したデータをそのままクライアント（Admin.js）に返す
        // (FirestoreのキーとAdmin.jsのキーが一致しているため、変換は不要)
        res.json(salesDoc.data());

    } catch (e) {
        console.error("Error fetching sales statistics:", e);
        res.status(500).json({ error: "Failed to fetch sales statistics" });
    }
});

// ==========================================================
// LINE Push/Reply Utility (エラーログ強化版)
// ==========================================================

/**
 * 指定したユーザーIDへLINEのプッシュメッセージを送信する
 * @param {string} toUserId - LINEユーザーID
 * @param {string} messageText - 送信するテキストメッセージ
 */
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

/**
 * 受信したイベントへのLINEの応答メッセージを送信する
 * @param {string} replyToken - 応答トークン
 * @param {string} messageText - 送信するテキストメッセージ
 */
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
    // Firebase Adminを関数内で使うために再取得
    const admin = require('firebase-admin'); 
    
    for (const event of events) {
        // LINEユーザーIDと応答トークンを取得
        const lineUserId = event.source.userId;
        const replyToken = event.replyToken;
        const inputText = (event.type === 'message' && event.message.type === 'text') ? event.message.text.trim() : null;

        // -----------------------------------------------------
        // 1. 友だち追加時 (follow)
        // -----------------------------------------------------
        if (event.type === 'follow') {
            const message = '友だち追加ありがとうございます！\n準備完了の通知をご希望の場合は、お手持ちの「受付番号」をメッセージで送信してください。例: 1';
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
            // 番号は連番のみを想定 (例: 1, 2, 3...)
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
            
            // 入力された値は連番のみを想定
            const reservationNumber = parseInt(inputText, 10); 

            if (isNaN(reservationNumber) || reservationNumber <= 0) {
                const message = '申し訳ありません、通知設定には「受付番号」が必要です。番号を半角数字で再入力してください。例: 1';
                await sendLineReply(replyToken, message);
                continue;
            }

            // 'number'は数値として保存されていることを前提とする
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


app.post('/api/reserve', async (req, res) => {

    const userData = req.body;

    const { group, name, people } = userData;



    if (!group || !name || !people) {

        return res.status(400).send("Missing required fields: group, name, or people.");

    }



    try {

        const result = await db.runTransaction(async (t) => {

            const stockLimitsRef = db.doc('settings/stockLimits');

            const stockLimitsSnap = await t.get(stockLimitsRef);

            if (!stockLimitsSnap.exists) throw new Error("Stock limits setting is not found.");

            const stockLimits = stockLimitsSnap.data();



            if (!userData.items || typeof userData.items !== 'object' || Object.keys(userData.items).length === 0) {

                throw new Error("Items data is invalid or missing.");

            }



            const salesStatsSnap = await t.get(db.doc(SALES_STATS_DOC));

            const salesStats = salesStatsSnap.exists ? salesStatsSnap.data() : {};



            for (const itemKey in userData.items) {

                const orderedAmount = userData.items[itemKey];

                const soldAmount = salesStats[itemKey] || 0;

                const maxLimit = stockLimits[itemKey] || 0;

                if (soldAmount + orderedAmount > maxLimit) {

                    throw new Error(`Order for ${itemKey} exceeds stock limit.`);

                }

            }



            const counterRef = db.doc(COUNTER_DOC);

            const counterDoc = await t.get(counterRef);

            let currentNumber = 1;

            const currentCounters = counterDoc.exists ? counterDoc.data() : {};

            const groupCounterKey = group.replace(/[^a-zA-Z0-9]/g, '');

            if (currentCounters[groupCounterKey]) {

                currentNumber = (currentCounters[groupCounterKey].currentNumber || 0) + 1;

            }

            const nextNumber = currentNumber;

            t.update(counterRef, {

                [`${groupCounterKey}.currentNumber`]: nextNumber,

                [`${groupCounterKey}.updatedAt`]: admin.firestore.FieldValue.serverTimestamp()

            });



            const summaryRef = db.doc(WAITING_SUMMARY_DOC);

            const peopleCount = parseInt(people, 10) || 1;

            const groupUpdateKey = group.replace('-', '_');



            t.set(summaryRef, {

                [groupUpdateKey]: {

                    groups: admin.firestore.FieldValue.increment(1),

                    people: admin.firestore.FieldValue.increment(peopleCount)

                }

            }, { merge: true });



            const newReservationRef = db.collection('reservations').doc();

            const fullReservationNumber = `${group.replace('-', '')}-${nextNumber}`;

            const reservationData = {

                name: userData.name,

                people: peopleCount,

                wantsLine: !!userData.wantsLine,

                lineUserId: userData.lineUserId || null,

                group: userData.group,

                number: fullReservationNumber,

                status: 'waiting',

                createdAt: admin.firestore.FieldValue.serverTimestamp(),

                items: userData.items || {},

            };

            t.set(newReservationRef, reservationData);



            return { success: true, number: fullReservationNumber, id: newReservationRef.id };

        });



        res.json(result);



    } catch (e) {

        console.error("Reservation registration failed:", e.message);

        if (e.message.includes("exceeds stock limit")) {

            return res.status(400).send("注文数が在庫上限を超えています。");

        }

        res.status(500).send("サーバーエラーにより登録に失敗しました。");

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
        // 団体名は5-5, 5-2など、カウンターで使われるキーを想定
        if (!callGroup) {
            return res.status(400).send('bad callGroup (must be specified)');
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
            // numberは連番(数値)として保存されている
            const reservationNumber = item.data.number !== undefined ? item.data.number : 9999; 
            const rRef = db.collection('reservations').doc(item.id);
            
            batch.update(rRef, { 
                status: 'called', 
                calledAt: now,
                // numberフィールドは更新しないが、ログのために取得
            });
            
            calledNumbers.push(reservationNumber);
            
            if (item.data.wantsLine && item.data.lineUserId) {
                // LINE通知では、連番のみを通知
                const text = `ご準備ができました。番号 ${reservationNumber} さん、受付へお戻りください。`;
                sendLinePush(item.data.lineUserId, text).catch(e => console.error(e));
            }
        });

        // 1. 既存のリストと新しく呼び出す番号を結合し、重複を排除
        // numberは数値だが、TV表示ロジックは文字列を扱う可能性があるため、念のため文字列に変換する
        const newCalledSet = new Set([...currentCalled.map(n => String(n)), ...calledNumbers.map(n => String(n))]);
        let updatedCalledList = Array.from(newCalledSet); 

        // 2. Firestoreのinクエリの制限（最大10個）を回避するため、リストを最大10個に制限する
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
// GET /api/stock-limits: 在庫制限値を取得 (Reception.js用)
// ==========================================================
app.get('/api/stock-limits', async (req, res) => {
    try {
        const doc = await db.doc('settings/stockLimits').get();
        if (!doc.exists) {
            // 在庫設定がない場合は、全商品を0として返す
            return res.json({ nikuman: 0, pizaman: 0, anman: 0, chocoman: 0, oolongcha: 0 });
        }
        res.json(doc.data());
    } catch (e) {
        console.error("Error fetching stock limits:", e);
        res.status(500).json({ error: "Failed to fetch stock limits" });
    }
});

// ==========================================================
// POST /api/reservations/:id/status: 予約ステータス更新 (Admin.js用)
// ==========================================================
app.post('/api/reservations/:id/status', async (req, res) => {
    if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
    
    const { id } = req.params;
    const { status } = req.body; // 'called', 'completed' など
    
    if (!id || !status) {
        return res.status(400).send('Invalid request (id or status missing).');
    }

    try {
        const docRef = db.collection('reservations').doc(id);
        const updatePayload = { status };
        const now = admin.firestore.FieldValue.serverTimestamp();

        // 個別に呼び出す場合
        if (status === 'called') {
            updatePayload.calledAt = now;
            
            const reservationSnap = await docRef.get();
            const reservationData = reservationSnap.data();

            if (reservationData) {
                // TV表示用のリストを更新
                const tvRef = db.doc('tv/state');
                await db.runTransaction(async t => {
                    const tvSnap = await t.get(tvRef);
                    const currentCalled = tvSnap.exists ? (tvSnap.data().currentCalled || []) : [];
                    const newCalledSet = new Set([...currentCalled, reservationData.number]);
                    t.set(tvRef, { currentCalled: Array.from(newCalledSet), updatedAt: now }, { merge: true });
                });
                
                // LINE通知
                if (reservationData.wantsLine && reservationData.lineUserId) {
                       const text = `ご準備ができました。番号 ${reservationData.number} さん、受付へお戻りください。`;
                       sendLinePush(reservationData.lineUserId, text).catch(e => console.error(e));
                }
            }
        } else if (status === 'completed') {
            updatePayload.completedAt = now;
        }
        
        await docRef.update(updatePayload);
        res.json({ success: true, id, newStatus: status });
    } catch (e) {
        console.error(`Failed to update status for ${id}:`, e);
        res.status(500).send("Failed to update status.");
    }
});

// ==========================================================
// DELETE /api/reservations/:id: 予約を削除 (Admin.js用)
// ==========================================================
app.delete('/api/reservations/:id', async (req, res) => {
    // Expressの仕様上、DELETEのbodyは推奨されないため、本来はヘッダーで認証すべき
    if (!req.body.apiSecret || req.body.apiSecret !== process.env.API_SECRET) {
      return res.status(403).send('forbidden');
    }
            
    const { id } = req.params;
    if (!id) {
        return res.status(400).send('Invalid request (id missing).');
    }

    try {
        await db.collection('reservations').doc(id).delete();
        res.json({ success: true, id });
    } catch (e) {
        console.error(`Failed to delete reservation ${id}:`, e);
        res.status(500).send("Failed to delete reservation.");
    }
});

// ==========================================================
// POST /api/reservations/:id/status: 🚨 集計ロジックをここに追加
// ==========================================================
app.post('/api/reservations/:id/status', async (req, res) => {
    if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');

    const { id } = req.params;
    const { status: newStatus } = req.body;

    if (!id || !newStatus) return res.status(400).send('Invalid request.');

    const docRef = db.collection('reservations').doc(id);

    try {
        await db.runTransaction(async t => {
            const docSnap = await t.get(docRef);
            if (!docSnap.exists) throw new Error("Reservation not found.");

            const reservationData = docSnap.data();
            const oldStatus = reservationData.status;

            if (oldStatus !== newStatus) {
                const groupKey = reservationData.group.replace('-', '_');
                const peopleCount = reservationData.people || 1;
                const summaryRef = db.doc(WAITING_SUMMARY_DOC);

                if (oldStatus === 'waiting') {
                    t.set(summaryRef, {
                        [groupKey]: {
                            groups: admin.firestore.FieldValue.increment(-1),
                            people: admin.firestore.FieldValue.increment(-peopleCount)
                        }
                    }, { merge: true });
                }

                if (newStatus === 'completed' || newStatus === 'seatEnter') {
                    const salesRef = db.doc(SALES_STATS_DOC);
                    const items = reservationData.items || {};
                    const salesUpdate = {};
                    for (const key in items) {
                        if (items[key] > 0) {
                            salesUpdate[key] = admin.firestore.FieldValue.increment(items[key]);
                        }
                    }
                    if (Object.keys(salesUpdate).length > 0) {
                        t.set(salesRef, salesUpdate, { merge: true });
                    }
                }
            }

            const updatePayload = { status: newStatus };
            if (newStatus === 'called') updatePayload.calledAt = admin.firestore.FieldValue.serverTimestamp();
            if (newStatus === 'completed') updatePayload.completedAt = admin.firestore.FieldValue.serverTimestamp();

            t.update(docRef, updatePayload);
        });

        const reservationSnap = await docRef.get();
        const reservationData = reservationSnap.data();

        if (newStatus === 'called') {
            const tvRef = db.doc('tv/state');
            await db.runTransaction(async t => {
                const tvSnap = await t.get(tvRef);
                const currentCalled = tvSnap.exists ? (tvSnap.data().currentCalled || []) : [];
                const newCalledSet = new Set([...currentCalled, reservationData.number]);
                t.set(tvRef, { currentCalled: Array.from(newCalledSet), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            });

            if (reservationData.wantsLine && reservationData.lineUserId) {
                const text = `ご準備ができました。番号 ${reservationData.number} さん、受付へお戻りください。`;
                sendLinePush(reservationData.lineUserId, text).catch(e => console.error(e));
            }
        }

        res.json({ success: true, id, newStatus });
    } catch (e) {
        console.error(`Failed to update status for ${id}:`, e);
        res.status(500).send("Failed to update status.");
    }
});


// ==========================================================
// DELETE /api/reservations/:id: 🚨 集計ロジックを追加
// ==========================================================
app.delete('/api/reservations/:id', async (req, res) => {
    if (!req.body.apiSecret || req.body.apiSecret !== process.env.API_SECRET) {
      return res.status(403).send('forbidden');
    }

    const { id } = req.params;
    if (!id) return res.status(400).send('Invalid request (id missing).');

    const docRef = db.collection('reservations').doc(id);

    try {
        await db.runTransaction(async t => {
            const docSnap = await t.get(docRef);
            if (!docSnap.exists) return;

            const reservationData = docSnap.data();

            if (reservationData.status === 'waiting') {
                const summaryRef = db.doc(WAITING_SUMMARY_DOC);
                const groupKey = reservationData.group.replace('-', '_');
                const peopleCount = reservationData.people || 1;

                t.set(summaryRef, {
                    [groupKey]: {
                        groups: admin.firestore.FieldValue.increment(-1),
                        people: admin.firestore.FieldValue.increment(-peopleCount)
                    }
                }, { merge: true });
            }

            t.delete(docRef);
        });

        res.json({ success: true, id });
    } catch (e) {
        console.error(`Failed to delete reservation ${id}:`, e);
        res.status(500).send("Failed to delete reservation.");
    }
});
// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server is running on port ${PORT}`));
