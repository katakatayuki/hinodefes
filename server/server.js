const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// ==========================================================
// サーバー設定
// ==========================================================
// 🚨 【修正】CORSをより確実に設定する
// 特定の環境で 'origin: "*"' が機能しない場合を考慮し、
// cors() を引数なしで使用してシンプルな全て許可設定にしてみる。
// もしくは、明示的に Origin を指定するロジックを加える。
// ここでは、一旦シンプルに cors() を使用して、すべて許可を再適用します。
app.use(cors()); // 引数なしで全て許可
app.use(express.json());

// Firebaseの初期化
// ...
// Firebaseの初期化
try {
    // 環境変数からサービスアカウント情報をロード
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
const STOCK_LIMITS_DOC = 'settings/stockLimits'; // 最初のプログラムの在庫制限ドキュメント
const INVENTORY_DOC = 'settings/inventory'; // 在庫設定ドキュメント（管理画面用）

// ==========================================================
// LINE Push Utility
// ==========================================================

/**
 * 指定したユーザーIDへLINEのプッシュメッセージを送信する
 * @param {string} toUserId - LINEユーザーID
 * @param {string} messageText - 送信するテキストメッセージ
 */
async function sendLinePush(toUserId, messageText) {
    if (!process.env.LINE_ACCESS_TOKEN) {
        console.error("LINE_ACCESS_TOKEN is not set. Cannot send LINE push message.");
        return;
    }

    const url = 'https://api.line.me/v2/bot/message/push';
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}`
    };

    const body = JSON.stringify({
        to: toUserId,
        messages: [{
            type: 'text',
            text: messageText,
        }]
    });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`LINE Push failed for user ${toUserId}. Status: ${response.status}. Body: ${errorBody}`);
        } else {
            console.log(`LINE Push successful for user ${toUserId}.`);
        }
    } catch (error) {
        console.error(`Error during LINE Push for user ${toUserId}:`, error);
    }
}

// ==========================================================
// 認証ミドルウェア (管理用APIで使用)
// ==========================================================
/**
 * API Secretによる認証チェック
 * @param {object} req - Expressリクエストオブジェクト
 * @returns {boolean} - 認証成功ならtrue
 */
const authenticate = (req) => {
    const apiSecret = process.env.API_SECRET;
    if (!apiSecret) {
        console.error("API_SECRET is not set.");
        return false;
    }

    // 1. Bearer Headerからの認証を試みる
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const headerSecret = authHeader.split(' ')[1];
        if (headerSecret === apiSecret) {
            return true;
        }
    }

    // 2. リクエストボディからの認証を試みる (DELETEはqueryからも可)
    const bodySecret = req.body.apiSecret || req.query.apiSecret;
    if (bodySecret === apiSecret) {
        return true;
    }

    return false;
};

const requireAuth = (req, res, next) => {
    if (authenticate(req)) {
        next();
    } else {
        res.status(403).send('Forbidden: Invalid API Secret');
    }
};


// ==========================================================
// POST /api/reserve-number (整理番号の発行と予約/在庫チェック)
// = S-1: 在庫チェックと番号発行をトランザクションで統合
// ==========================================================
app.post('/api/reserve-number', async (req, res) => {
    try {
        const { group, name, people, lineId, wantsLine, order } = req.body;
        
        const totalOrder = Object.values(order || {}).reduce((sum, count) => sum + count, 0);

        let newNumber;
        let docRef;

        await db.runTransaction(async (t) => {
            // ----------------------------------------------------
            // 1. 【READS START】在庫制限とアクティブな予約を読み取る
            // ----------------------------------------------------
            const counterRef = db.doc(COUNTER_DOC);
            const counterDoc = await t.get(counterRef);
            
            let stockLimits = {};
            if (totalOrder > 0) {
                // READ: 在庫制限の読み取り
                const stockDoc = await t.get(db.doc(STOCK_LIMITS_DOC));
                stockLimits = stockDoc.exists ? stockDoc.data() : {};
                
                // READ: アクティブな予約の読み取り
                const activeReservationsSnapshot = await t.get(db.collection('reservations')
                    .where('status', 'in', ['waiting', 'called']));

                // ----------------------------------------------------
                // 2. 【ロジック】在庫チェック
                // ----------------------------------------------------
                let currentOrderedCount = {};
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


            // ----------------------------------------------------
            // 3. 【WRITES START】カウンターのインクリメントと予約の登録
            // ----------------------------------------------------
            const currentCount = counterDoc.exists ? (counterDoc.data().count || 0) : 0;
            newNumber = currentCount + 1;

            // カウンターを更新 (WRITE 1)
            t.set(counterRef, { count: newNumber, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

            // 予約を登録 (WRITE 2)
            docRef = db.collection('reservations').doc();
            await t.set(docRef, {
                number: newNumber,
                group: group || 'default', // '5-5' or '5-2'
                name: name || null,
                people: parseInt(people, 10) || 1,
                status: 'waiting',
                lineId: lineId || null,
                wantsLine: wantsLine || false,
                order: order || {},
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                calledAt: null,
                seatEnterAt: null,
            });
        });

        res.json({ success: true, number: newNumber, id: docRef.id });

    } catch (e) {
        console.error("Error reserving number:", e);
        if (e.message.includes('在庫制限')) {
             res.status(400).json({ success: false, message: e.message });
        } else {
            res.status(500).json({ success: false, message: "予約の登録に失敗しました。" });
        }
    }
});


// ==========================================================
// POST /api/compute-call (次の人を複数呼び出し - 団体別)
// = S-2: 団体と人数を指定して複数の待ちをトランザクションで処理
// ==========================================================
app.post('/api/compute-call', requireAuth, async (req, res) => {
    try {
        const { availableCount, callGroup } = req.body;
        const countToCall = parseInt(availableCount, 10) || 1; 
        const targetGroup = callGroup || 'default';

        let calledDocsData = []; // LINE通知用データを保持

        await db.runTransaction(async (t) => {
            
            // 🚨 指定団体・waitingステータスの予約を番号順に、呼び出し人数分だけ取得
            const snapshot = await t.get(db.collection('reservations')
                .where('status', '==', 'waiting')
                .where('group', '==', targetGroup) 
                .orderBy('number', 'asc')
                .limit(countToCall)); 

            if (snapshot.empty) {
                return; // 呼び出す待ちがない
            }

            // 取得した全ての予約を 'called' に更新
            snapshot.docs.forEach(doc => {
                const reservationRef = doc.ref;
                const data = doc.data();
                
                // ステータスを 'called' に更新し、呼び出し時刻を記録
                t.update(reservationRef, {
                    status: 'called',
                    calledAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                
                // LINE通知用にデータを保持
                calledDocsData.push({ number: data.number, lineId: data.lineId, wantsLine: data.wantsLine });
            });
            
        });

        // LINE通知（トランザクション成功後に実行）
        for (const data of calledDocsData) {
            if (data.wantsLine && data.lineId) {
                const message = `【${data.number}番】のお客様、お待たせいたしました！間もなくお席にご案内します。受付にお越しください。`;
                sendLinePush(data.lineId, message);
            }
        }
        
        const calledNumbers = calledDocsData.map(d => d.number);

        // 呼び出した番号のリストを返す
        if (calledNumbers.length > 0) {
            // TV表示用の最新呼び出し番号を記録する例
            await db.doc('tv_display/latest_call').set({ numbers: calledNumbers, time: admin.firestore.FieldValue.serverTimestamp() });
            res.json({ success: true, called: calledNumbers });
        } else {
            res.json({ success: true, called: [] });
        }

    } catch (e) {
        console.error("Error calling next reservation:", e);
        res.status(500).send("Call next failed.");
    }
});

// ==========================================================
// PUT /api/update-status/:id (予約ステータス更新 - 時刻スタンプ記録付き)
// = S-3: ステータスに応じて時刻スタンプを更新し、LINE通知を行う
// ==========================================================
app.put('/api/update-status/:id', requireAuth, async (req, res) => {
    try {
        const { status } = req.body;
        const reservationRef = db.collection('reservations').doc(req.params.id);
        
        if (!['waiting', 'called', 'seatEnter', 'cancel', 'noShow'].includes(status)) {
             return res.status(400).send('Invalid status value.');
        }

        const updateData = { 
            status: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 時刻スタンプの更新ロジック (最初のプログラムの機能を復元)
        if (status === 'called') {
            updateData.calledAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.seatEnterAt = null; // 着席時刻はクリア
        } else if (status === 'seatEnter') {
            updateData.seatEnterAt = admin.firestore.FieldValue.serverTimestamp();
            // calledAtはそのまま維持
        } else if (status === 'waiting' || status === 'cancel' || status === 'noShow') {
            updateData.calledAt = null; // 呼び出し時刻をクリア
            updateData.seatEnterAt = null; // 着席時刻をクリア
        }

        // 'seatEnter'になったら、LINEに完了通知を送信（任意）
        let lineNotificationData = null;
        if (status === 'seatEnter') {
            const doc = await reservationRef.get();
            const data = doc.data();
            
            if (data && data.wantsLine && data.lineId) {
                lineNotificationData = { number: data.number, lineId: data.lineId };
            }
        }
        
        await reservationRef.update(updateData);
        
        // トランザクション外でLINE通知を実行
        if (lineNotificationData) {
            const message = `【${lineNotificationData.number}番】ありがとうございます。お料理の準備ができました。ゆっくりお楽しみください！`;
            sendLinePush(lineNotificationData.lineId, message);
        }

        res.json({ success: true, id: req.params.id, newStatus: status });

    } catch (e) {
        console.error("Error updating status:", e);
        res.status(500).send("Status update failed.");
    }
});


// ==========================================================
// GET /api/reservations (予約一覧取得 - 管理/表示用)
// ==========================================================
app.get('/api/reservations', async (req, res) => {
    try {
        // GETでの認証は、API Secretをクエリとして渡すか、認証なしとして扱う (ここでは認証なしを許可)
        // if (!authenticate(req)) { return res.status(403).send('Forbidden'); }

        const snapshot = await db.collection('reservations').orderBy('number', 'asc').get();
        const reservations = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        res.json({ success: true, reservations });

    } catch (e) {
        console.error("Error fetching reservations:", e);
        res.status(500).send("Reservation fetch failed.");
    }
});


// ==========================================================
// DELETE /api/delete-reservation/:id (予約削除)
// ==========================================================
app.delete('/api/delete-reservation/:id', requireAuth, async (req, res) => {
    try {
        const reservationRef = db.collection('reservations').doc(req.params.id);
        await reservationRef.delete();
        res.json({ success: true, id: req.params.id });
    } catch (e) {
        console.error("Error deleting reservation:", e);
        res.status(500).send("Reservation deletion failed.");
    }
});


// ==========================================================
// GET /api/order-summary (注文合計と在庫制限の取得)
// = S-4: 最初のプログラムの注文集計ロジックを復元
// ==========================================================
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
        const stockDoc = await db.doc(STOCK_LIMITS_DOC).get();
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
// GET /api/inventory (在庫取得 - 管理画面用)
// ==========================================================
app.get('/api/inventory', requireAuth, async (req, res) => {
    try {
        const inventoryRef = db.doc(INVENTORY_DOC);
        const doc = await inventoryRef.get();
        
        // 在庫設定がない場合は空のオブジェクトを返す
        const items = doc.exists ? doc.data().items : {};

        res.json({ success: true, items });

    } catch (e) {
        console.error("Error fetching inventory:", e);
        res.status(500).send("Inventory fetch failed.");
    }
});


// ==========================================================
// POST /api/inventory (在庫更新 - 管理画面用)
// ==========================================================
app.post('/api/inventory', requireAuth, async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || typeof items !== 'object') {
            return res.status(400).send('Invalid items data.');
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
// GET /api/sales (販売数の集計)
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


// サーバーの待ち受け
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
