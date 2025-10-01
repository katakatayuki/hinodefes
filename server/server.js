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
    process.exit(1);\
}

const db = admin.firestore();
const COUNTER_DOC = 'settings/counters';
// 🚨 在庫制限を保存するドキュメント
const STOCK_DOC = 'settings/stockLimits';

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
            messages: [{
                type: 'text',
                text: messageText
            }]
        })
    });
    
    // エラーレスポンスの詳細をログに出力
    if (!res.ok) {
        const errorDetails = await res.text();
        console.error(`LINE Push failed for user ${toUserId}: Status ${res.status}, Details: ${errorDetails}`);
    } else {
        // console.log(`LINE Push successful to ${toUserId}`); // 成功時はログを抑制
    }
}


// ==========================================================
// GET /api/order-summary (受付画面用: 在庫制限と現在の注文集計)
// ==========================================================
app.get('/api/order-summary', async (req, res) => {
    try {
        // 1. 在庫制限の取得 (手動で投入された設定データ)
        const stockDocRef = db.doc(STOCK_DOC);
        const stockDoc = await stockDocRef.get();
        const stockLimits = stockDoc.exists ? stockDoc.data() : {};

        // 2. 現在の注文の集計
        // 🚨 修正済み: Firestoreの制限を回避するため、否定クエリ(WHERE !=)を肯定クエリ(WHERE IN)に置き換え
        // ステータスが 'waiting' または 'called' の予約のみを対象とする
        const reservationsSnapshot = await db.collection('reservations')
            .where('status', 'in', ['waiting', 'called']) // 肯定系フィルタを使用
            .get();

        const currentOrders = {};

        reservationsSnapshot.forEach(doc => {
            const reservation = doc.data();
            
            // 予約に含まれる各注文アイテムを集計
            for (const itemCode in reservation.order) {
                const quantity = reservation.order[itemCode];
                if (typeof quantity === 'number' && quantity > 0) {
                    currentOrders[itemCode] = (currentOrders[itemCode] || 0) + quantity;
                }
            }
        });

        res.json({
            stockLimits: stockLimits,
            currentOrders: currentOrders
        });

    } catch (e) {
        // エラーメッセージを強化
        console.error("Error fetching order summary:", e);
        res.status(500).json({ error: "Failed to fetch order summary data." });
    }
});


// ==========================================================
// POST /api/reservations (新規予約登録)
// ==========================================================
app.post('/api/reservations', async (req, res) => {
    try {
        const { groupSize, groupType, order, lineUserId, wantsLine, comment } = req.body;

        if (!groupSize || !groupType || typeof order !== 'object') {
            return res.status(400).send('Invalid request body.');
        }

        const reservationRef = db.collection('reservations');
        const counterRef = db.doc(COUNTER_DOC);
        let currentNumber;

        // トランザクションでカウンターを安全にインクリメント
        await db.runTransaction(async (t) => {
            const counterDoc = await t.get(counterRef);
            if (!counterDoc.exists) {
                currentNumber = 1;
                t.set(counterRef, { lastNumber: 1 });
            } else {
                currentNumber = counterDoc.data().lastNumber + 1;
                t.update(counterRef, { lastNumber: currentNumber });
            }

            // 新規予約ドキュメントを作成
            await t.set(reservationRef.doc(), {
                number: currentNumber,
                groupSize: parseInt(groupSize, 10),
                groupType: groupType,
                order: order,
                lineUserId: wantsLine ? lineUserId : null,
                wantsLine: !!wantsLine,
                comment: comment || null,
                status: 'waiting', // 初期状態は'waiting'
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                calledAt: null,
                seatEnterAt: null,
            });
        });

        // LINE通知希望者へメッセージを送信 (通知は管理画面から行うため、ここでは不要)

        res.status(201).json({ success: true, number: currentNumber });

    } catch (e) {
        console.error("Error creating reservation:", e);
        res.status(500).send("Reservation failed.");
    }
});


// ==========================================================
// GET /api/reservations (管理画面用: 全予約リスト)
// ==========================================================
app.get('/api/reservations', async (req, res) => {
    try {
        if (req.query.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');

        const reservationsSnapshot = await db.collection('reservations')
            .orderBy('createdAt', 'asc')
            .get();

        const reservations = reservationsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            // Firestore TimestampをJavaScript Dateに変換
            createdAt: doc.data().createdAt ? doc.data().createdAt.toDate() : null,
            calledAt: doc.data().calledAt ? doc.data().calledAt.toDate() : null,
            seatEnterAt: doc.data().seatEnterAt ? doc.data().seatEnterAt.toDate() : null,
        }));

        res.json(reservations);

    } catch (e) {
        console.error("Error fetching reservations:", e);
        res.status(500).send("Failed to fetch reservations.");
    }
});

// ==========================================================
// PUT /api/reservations/:id (管理画面用: ステータス更新)
// ==========================================================
app.put('/api/reservations/:id', async (req, res) => {
    try {
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');

        const { id } = req.params;
        const { status } = req.body;
        const reservationRef = db.collection('reservations').doc(id);
        const updateData = { status };

        if (status === 'called') {
            updateData.calledAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.seatEnterAt = null;
            
            // LINE通知の実行
            const reservationDoc = await reservationRef.get();
            const reservation = reservationDoc.data();
            if (reservation && reservation.wantsLine && reservation.lineUserId) {
                const message = `お待たせいたしました！間もなくお席にご案内できます。番号札の番号をご確認の上、スタッフの指示に従って受付までお越しください。\n（あなたの番号: ${reservation.number}）`;
                await sendLinePush(reservation.lineUserId, message);
            }
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


// ==========================================================
// GET /api/tv-status (TV表示画面用: 呼び出し中の番号リスト)
// ==========================================================
app.get('/api/tv-status', async (req, res) => {
    try {
        const TEN_MINUTES_MS = 10 * 60 * 1000;
        const now = admin.firestore.Timestamp.now();
        const tenMinutesAgo = new Date(now.toDate().getTime() - TEN_MINUTES_MS);

        // 呼び出し中 ('called') の予約を取得
        const calledSnapshot = await db.collection('reservations')
            .where('status', '==', 'called')
            // 🚨 修正: 複合クエリによるインデックス不足エラーを回避するため、orderByを削除
            .get(); 

        // 🚨 追加: Node.js側でソートを実行
        let calledReservations = calledSnapshot.docs.map(doc => doc.data());

        // calledAt (Timestampオブジェクト) に基づいて降順ソート
        calledReservations.sort((a, b) => {
            // null/undefinedの場合は0として扱う（実際にはcalled==trueなのでnullはないはずだが念のため）
            const timeA = a.calledAt ? a.calledAt.toMillis() : 0;
            const timeB = b.calledAt ? b.calledAt.toMillis() : 0;
            return timeB - timeA; // 降順ソート (新しい時刻が前)
        });
        
        const currentCalled = [];

        calledReservations.forEach(reservation => {
            // 呼び出しから10分未満のものを「呼び出し中」として表示する
            if (reservation.calledAt && reservation.calledAt.toDate() > tenMinutesAgo) {
                currentCalled.push(reservation.number);
            }
        });

        res.json({ currentCalled });
    } catch (e) {
        console.error("Error fetching TV status:", e);
        res.status(500).send("Failed to fetch TV status.");
    }
});

// ==========================================================
// GET /api/waiting-summary (TV表示画面用: 待ち状況サマリー)
// ==========================================================
app.get('/api/waiting-summary', async (req, res) => {
    try {
        // ステータスが 'waiting' の予約のみを対象とする
        const waitingSnapshot = await db.collection('reservations')
            .where('status', '==', 'waiting')
            .get();

        const summary = {
            '5-5': { groups: 0, people: 0 },
            '5-2': { groups: 0, people: 0 },
        };

        waitingSnapshot.forEach(doc => {
            const reservation = doc.data();
            const type = reservation.groupType;
            const size = reservation.groupSize;
            
            if (summary[type]) {
                summary[type].groups += 1;
                summary[type].people += size;
            }
        });

        res.json(summary);
    } catch (e) {
        console.error("Error fetching waiting summary:", e);
        res.status(500).send("Failed to fetch waiting summary.");
    }
});


// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
