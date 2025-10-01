const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// ==========================================================
// サーバー設定
// ==========================================================
// CORSを詳細に設定
app.use(cors({
    origin: '*',  // すべてのドメインからのアクセスを許可
    methods: ['GET', 'POST', 'DELETE', 'PUT'] 
}));

app.use(express.json());

// Firebaseの初期化
try {
    // 環境変数からサービスアカウント情報をロード（Renderなどの環境を想定）
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

// 🚨 【追加】在庫設定用のドキュメントパス
const INVENTORY_DOC = 'settings/inventory';

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
        console.error("LINE_ACCESS_TOKEN is not set. Cannot send LINE message.");
        return;
    }
    
    const lineApiUrl = 'https://api.line.me/v2/bot/message/push';
    
    try {
        const response = await fetch(lineApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                to: toUserId,
                messages: [{
                    type: 'text',
                    text: messageText
                }]
            })
        });

        if (response.status !== 200) {
            const errorBody = await response.json();
            console.error(`LINE Push API failed (Status: ${response.status}):`, errorBody);
        }

    } catch (error) {
        console.error("Error sending LINE push message:", error);
    }
}

// ==========================================================
// POST /api/reservation (予約受付)
// ==========================================================
app.post('/api/reservation', async (req, res) => {
    try {
        const { name, people, wantsLine, lineId, order, apiSecret } = req.body;
        
        // 開発環境でのAPI Secretチェックをスキップ (今回はテストのため)
        // if (apiSecret !== process.env.API_SECRET) return res.status(403).send('Forbidden');

        // トランザクションを開始
        const result = await db.runTransaction(async (t) => {
            // 1. カウンターをインクリメント
            const counterRef = db.doc(COUNTER_DOC);
            const counterDoc = await t.get(counterRef);
            
            let currentNumber = 1;
            if (counterDoc.exists) {
                const data = counterDoc.data();
                currentNumber = (data.currentNumber || 0) + 1;
                t.update(counterRef, { currentNumber, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            } else {
                t.set(counterRef, { currentNumber, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }

            // 2. 在庫制限の確認 (order-summaryロジックから流用)
            // 注文の合計数を計算
            const totalOrder = Object.values(order).reduce((sum, count) => sum + count, 0);
            if (totalOrder > 0) {
                 // 在庫制限を取得
                const stockDoc = await t.get(db.collection('settings').doc('stockLimits'));
                const stockLimits = stockDoc.exists ? stockDoc.data() : {};
                
                // 既存の予約の注文合計を計算
                // 'waiting'または'called'ステータスの予約のみを考慮
                const activeReservationsSnapshot = await t.get(db.collection('reservations')
                    .where('status', 'in', ['waiting', 'called']));
                
                const currentOrderedCount = {};
                activeReservationsSnapshot.forEach(doc => {
                    const data = doc.data();
                    const existingOrder = data.order || {};
                    for (const itemKey in existingOrder) {
                        currentOrderedCount[itemKey] = (currentOrderedCount[itemKey] || 0) + existingOrder[itemKey];
                    }
                });

                // 新しい注文を加えてチェック
                for (const itemKey in order) {
                    const newTotal = (currentOrderedCount[itemKey] || 0) + order[itemKey];
                    const limit = stockLimits[itemKey];
                    
                    if (limit !== undefined && limit !== null && newTotal > limit) {
                        // 在庫オーバーでトランザクションを中断
                        throw new Error(`在庫制限により、${itemKey}の注文はこれ以上受け付けられません。現在の注文数: ${currentOrderedCount[itemKey]}, 制限: ${limit}`);
                    }
                }
            }


            // 3. 予約を登録
            const newReservation = {
                number: currentNumber,
                name,
                people: parseInt(people, 10),
                wantsLine: !!wantsLine,
                lineId: wantsLine ? lineId : null,
                order: order || {},
                status: 'waiting', // 初期ステータスは 'waiting'
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                calledAt: null,
                seatEnterAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            const docRef = db.collection('reservations').doc();
            t.set(docRef, newReservation);

            return { number: currentNumber, docId: docRef.id };
        });
        
        // 予約番号を返す
        res.json({ success: true, number: result.number, id: result.docId });

    } catch (e) {
        console.error("Error creating reservation:", e);
        // 在庫制限エラーの場合、クライアントにエラーメッセージを返す
        if (e.message.includes('在庫制限')) {
             res.status(400).json({ success: false, message: e.message });
        } else {
            res.status(500).json({ success: false, message: "予約の登録に失敗しました。" });
        }
    }
});


// ==========================================================
// GET /api/reservations (予約一覧の取得) - 🚨 認証スキップ版
// ==========================================================
app.get('/api/reservations', async (req, res) => {
    try {
        // 認証チェックをスキップ (テストのため)
        // const authHeader = req.headers.authorization;
        // if (!authHeader || !authHeader.startsWith('Bearer ')) {
        //     return res.status(403).send('Forbidden: Authorization header missing or malformed.');
        // }
        // const apiSecret = authHeader.split(' ')[1];
        // if (apiSecret !== process.env.REACT_APP_API_SECRET && apiSecret !== process.env.API_SECRET) {
        //     return res.status(403).send('Forbidden: Invalid API Secret.');
        // }


        // 全予約を番号 (number) 順に取得
        const snapshot = await db.collection('reservations')
            .orderBy('number', 'asc') // 番号順にソートして取得
            .get();

        const reservations = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json(reservations);

    } catch (e) {
        console.error("Error fetching reservations:", e);
        res.status(500).send("Reservation list fetch failed.");
    }
});


// ==========================================================
// GET /api/order-summary (注文合計と在庫制限の取得)
// ==========================================================
// 現在の全注文の合計数と在庫制限を返すAPI
app.get('/api/order-summary', async (req, res) => {
    try {
        // 'waiting'または'called'ステータスの予約のみを対象とする
        const activeReservationsSnapshot = await db.collection('reservations')
            .where('status', 'in', ['waiting', 'called'])
            .get();

        const currentOrderedCount = {};
        activeReservationsSnapshot.forEach(doc => {
            const data = doc.data();
            const order = data.order || {};
            for (const itemKey in order) {
                currentOrderedCount[itemKey] = (currentOrderedCount[itemKey] || 0) + order[itemKey];
            }
        });

        // 在庫制限を取得
        const stockDoc = await db.collection('settings').doc('stockLimits').get();
        const stockLimits = stockDoc.exists ? stockDoc.data() : {};


        res.json({
            success: true,
            currentOrder: currentOrderedCount,
            stockLimits: stockLimits
        });

    } catch (e) {
        console.error('Error fetching order summary:', e);
        res.status(500).send("Order summary fetch failed.");
    }
});


// ==========================================================
// 🚨 【追加】GET /api/stock-limits
// 在庫制限データのみを返すAPI
// ==========================================================
app.get('/api/stock-limits', async (req, res) => {
    try {
        // 在庫制限データを取得
        // settings/stockLimits ドキュメントからデータを取得する
        const stockDoc = await db.collection('settings').doc('stockLimits').get();
        // 在庫制限がない場合は、初期値として空のオブジェクトを返す
        const stockLimits = stockDoc.exists ? stockDoc.data() : {};

        // 在庫制限データのみをレスポンスとして返す
        res.json(stockLimits);

    } catch (e) {
        console.error('Error fetching stock limits:', e);
        res.status(500).send("Stock limits fetch failed.");
    }
});


// ==========================================================
// POST /api/call-next (次の人を呼び出し)
// ==========================================================
// 🚨 【追加】LINE送信処理を追加
app.post('/api/call-next', async (req, res) => {
    try {
        // if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('Forbidden'); // 🚨 テストのため無効化

        let calledId = null;

        await db.runTransaction(async (t) => {
            // 'waiting'ステータスの予約を番号順に取得
            const snapshot = await t.get(db.collection('reservations')
                .where('status', '==', 'waiting')
                .orderBy('number', 'asc')
                .limit(1));

            if (snapshot.empty) {
                // 呼び出す待ちがない
                return;
            }

            const doc = snapshot.docs[0];
            const reservationRef = doc.ref;
            const data = doc.data();
            calledId = doc.id;

            // ステータスを 'called' に更新し、呼び出し時刻を記録
            t.update(reservationRef, {
                status: 'called',
                calledAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // LINE通知の必要があればプッシュメッセージを送信
            if (data.wantsLine && data.lineId) {
                // トランザクション外で処理するために必要な情報を変数に保持
                // LINE送信はI/Oが絡むためトランザクション外で行うべき
                // ここでは`calledId`と`data.lineId`の保持に留める
            }
        });

        // LINE通知（トランザクション成功後に実行）
        if (calledId) {
             // 呼び出し後にデータを再取得してLINE IDを確認する方が確実だが、
             // トランザクション内のデータを利用する（今回は単純化のため）
             const doc = await db.collection('reservations').doc(calledId).get();
             const data = doc.data();
             
             if (data && data.wantsLine && data.lineId) {
                 const message = `【${data.number}番】のお客様、お待たせいたしました！間もなくお席にご案内します。受付にお越しください。`;
                 // LINE送信はawaitしない (レスポンスをブロックしないため)
                 sendLinePush(data.lineId, message);
             }
        }
        
        res.json({ success: true, calledId });

    } catch (e) {
        console.error("Error calling next reservation:", e);
        res.status(500).send("Call next failed.");
    }
});


// ==========================================================
// PUT /api/reservations/:id (ステータス更新)
// ==========================================================
app.put('/api/reservations/:id', async (req, res) => {
    try {
        // if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('Forbidden'); // 🚨 テストのため無効化
        
        const { id } = req.params;
        const { status } = req.body; // 'waiting', 'called', 'seatEnter', 'cancel'

        const reservationRef = db.collection('reservations').doc(id);
        
        const updateData = { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() };

        if (status === 'called') {
            // 呼び出し時刻を記録
            updateData.calledAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.seatEnterAt = null;
        } else if (status === 'seatEnter') {
            // 着席時刻を記録（calledAtをクリアする必要はない）
            updateData.seatEnterAt = admin.firestore.FieldValue.serverTimestamp();
            // calledAtはそのまま維持
        } else if (status === 'waiting' || status === 'cancel') {
            // 待機中またはキャンセルの場合、呼び出し時刻と着席時刻をクリア
            updateData.calledAt = null;
            updateData.seatEnterAt = null;
        }
        
        // 'seatEnter'になったら、LINEに完了通知を送信（任意）
        if (status === 'seatEnter') {
             const doc = await reservationRef.get();
             const data = doc.data();
             
             if (data && data.wantsLine && data.lineId) {
                 const message = `【${data.number}番】ありがとうございます。お料理の準備ができました。ゆっくりお楽しみください！`;
                 // LINE送信はawaitしない
                 sendLinePush(data.lineId, message);
             }
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
        // if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden'); // 🚨 テストのため無効化
        
        const { id } = req.params;

        const reservationRef = db.collection('reservations').doc(id);
        
        await reservationRef.delete();
        
        res.json({ success: true, id });

    } catch (e) {
        console.error(`Error deleting reservation ${req.params.id}:`, e);
        res.status(500).send("Reservation deletion failed.");
    }
});


// ==========================================================
// POST /api/inventory (在庫の更新)
// ==========================================================
// 🚨 【追加】在庫設定API
app.post('/api/inventory', async (req, res) => {
    try {
        // 🚨 【修正】テスト段階のためAPI Secretチェックを一時的にスキップ
        // if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('Forbidden'); 

        const { items, apiSecret } = req.body;
        
        if (!items || typeof items !== 'object') {
            return res.status(400).send("Invalid items data.");
        }

        const inventoryRef = db.doc(INVENTORY_DOC);
        
        // itemsを保存
        await inventoryRef.set({ items, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

        res.json({ success: true, items });

    } catch (e) {
        console.error("Error updating inventory:", e);
        res.status(500).send("Inventory update failed.");
    }
});

// ==========================================================
// 🚨 【追加】GET /api/sales (販売数の集計)
// ==========================================================
app.get('/api/sales', async (req, res) => {
    try {
        // 'seatEnter'（受け取り済み）の予約のみを対象とする
        const snapshot = await db.collection('reservations')
            .where('status', '==', 'seatEnter')
            .get();

        const sales = {};

        snapshot.forEach(doc => {
            const data = doc.data();
            const order = data.order || {};
            
            // 注文内容を走査して販売数を集計
            for (const itemKey in order) {
                if (order[itemKey] && order[itemKey] > 0) {
                    sales[itemKey] = (sales[itemKey] || 0) + order[itemKey];
                }
            }
        });

        res.json({ success: true, sales });

    } catch (e) {
        console.error("Error fetching sales data:", e);
        res.status(500).send("Sales data fetch failed.");
    }
});


// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
