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
    origin: '*',  // すべてのドメインからのアクセスを許可
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
        console.error("LINE_ACCESS_TOKEN is not set.");
        return;
    }
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
            to: toUserId,
            messages: [{ type: 'text', text: messageText }]
        })
    });

    if (!res.ok) {
        const errorBody = await res.text();
        console.error(`LINE Push failed for user ${toUserId}. Status: ${res.status}. Body: ${errorBody}`);
    }
}


// ==========================================================
// GET /api/reservations (全予約の取得)
// ==========================================================
app.get('/api/reservations', async (req, res) => {
    try {
        const snapshot = await db.collection('reservations').get();
        const reservations = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                // Firestore TimestampをJavaScriptフレンドリーな形式に変換
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
                calledAt: data.calledAt ? data.calledAt.toDate().toISOString() : null,
                seatEnterAt: data.seatEnterAt ? data.seatEnterAt.toDate().toISOString() : null,
            };
        });

        // 整理されたデータを返す (Admin.jsでのソートに任せる)
        res.json({ reservations });

    } catch (e) {
        console.error("Error fetching reservations:", e);
        res.status(500).send("Reservation fetch failed.");
    }
});


// ==========================================================
// POST /api/reservations (受付の登録)
// ==========================================================
app.post('/api/reservations', async (req, res) => {
    const { name, order, wantsLine, lineUserId } = req.body;

    // 簡易バリデーション
    if (!name || Object.values(order).reduce((sum, count) => sum + (count || 0), 0) === 0) {
        return res.status(400).send("Name or order is invalid.");
    }

    try {
        // 予約番号 (counter) をアトミックに取得・インクリメント
        const counterRef = db.doc(COUNTER_DOC);
        let currentNumber;

        await db.runTransaction(async (transaction) => {
            const counterDoc = await transaction.get(counterRef);
            const data = counterDoc.data() || { lastNumber: 0 };
            currentNumber = data.lastNumber + 1;
            
            // 999を超えたら1に戻る（最大3桁）
            if (currentNumber > 999) {
                currentNumber = 1;
            }
            
            transaction.set(counterRef, { lastNumber: currentNumber });
        });
        
        // 予約データの作成
        const reservationData = {
            queueNumber: currentNumber,
            name,
            order,
            wantsLine: !!wantsLine,
            lineUserId: wantsLine ? lineUserId : null,
            status: 'waiting', // 初期状態は'waiting'
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            calledAt: null,
            seatEnterAt: null,
        };

        const docRef = await db.collection('reservations').add(reservationData);
        
        // LINE通知希望者にはプッシュ通知を送信（登録完了メッセージ）
        if (wantsLine && lineUserId) {
            const orderSummary = Object.entries(order)
                .filter(([_, count]) => count > 0)
                .map(([item, count]) => `${item} x ${count}`)
                .join(', ');

            await sendLinePush(lineUserId, 
                `受付が完了しました！\n予約番号: ${currentNumber}\nご注文: ${orderSummary}\n\n順番が近づいたら再度通知します。`
            );
        }

        res.status(201).json({ 
            success: true, 
            id: docRef.id, 
            queueNumber: currentNumber,
            name,
            order,
        });

    } catch (e) {
        console.error("Error creating reservation:", e);
        res.status(500).send("Reservation creation failed.");
    }
});


// ==========================================================
// PUT /api/reservations/:id (ステータス更新 - 呼び出し、受け取り、キャンセル)
// ==========================================================
app.put('/api/reservations/:id', async (req, res) => {
    try {
        // API Secretで認証
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        const { id } = req.params;
        const { status, lineUserId, name, queueNumber } = req.body; // queueNumberとnameは通知用

        if (!['waiting', 'called', 'seatEnter', 'cancel'].includes(status)) {
            return res.status(400).send('Invalid status value.');
        }

        const reservationRef = db.collection('reservations').doc(id);
        const updateData = { status };

        if (status === 'called') {
            updateData.calledAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.seatEnterAt = null;

            // LINE通知希望者にはプッシュ通知を送信（呼び出しメッセージ）
            if (lineUserId) {
                await sendLinePush(lineUserId, 
                    `${name}様 (番号: ${queueNumber})\nお待たせいたしました！順番が参りましたので、受け取りカウンターへお越しください。`
                );
            }

        } else if (status === 'seatEnter') {
            updateData.calledAt = admin.firestore.FieldValue.serverTimestamp();
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


// ==========================================================
// 🚨 【追加】GET /api/inventory (在庫数の取得)
// ==========================================================
app.get('/api/inventory', async (req, res) => {
    try {
        const inventoryRef = db.doc(INVENTORY_DOC);
        const doc = await inventoryRef.get();
        
        // 在庫データがない場合は空のオブジェクトを返す
        const inventoryData = doc.exists ? doc.data().items || {} : {};

        res.json({ success: true, inventory: inventoryData });

    } catch (e) {
        console.error("Error fetching inventory:", e);
        res.status(500).send("Inventory fetch failed.");
    }
});

// ==========================================================
// 🚨 【追加】POST /api/inventory (在庫数の更新 - Admin用)
// ==========================================================
app.post('/api/inventory', async (req, res) => {
    try {
        // API Secretで認証
        if (req.body.apiSecret !== process.env.API_SECRET) {
            return res.status(403).send('forbidden');
        }

        const { items } = req.body;
        
        // itemsがオブジェクトであることを確認
        if (typeof items !== 'object' || items === null) {
            return res.status(400).send('Invalid inventory data.');
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
