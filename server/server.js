const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();


const COUNTER_DOC = 'settings/counters';
// 🚨 【追加】販売実績ドキュメントのパス
const SALES_STATS_DOC = 'settings/salesStats'; 

// ==========================================================
// サバ設定
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

// server.js の任意の場所に追加

// server.js のどこかにある、GET /api/stock-limits ルート全体を以下のコードに置き換えてください。

// ==========================================================
// GET /api/stock-limits: 残り在庫数の計算と取得
// ==========================================================
app.get('/api/stock-limits', async (req, res) => {
    try {
        // 1. 最大販売数 (Stock Limits) と 販売実績 (Sales Stats) の両方のドキュメントを取得
        const [stockDoc, salesDoc] = await Promise.all([
            db.doc('settings/stockLimits').get(), 
            db.doc('settings/salesStats').get() 
        ]);
        
        // データの初期値（ドキュメントが存在しない場合を考慮）
        const maxLimits = stockDoc.exists ? stockDoc.data() : {};
        const salesStats = salesDoc.exists ? salesDoc.data() : {};

        // クライアント (Reception.js) が期待する全商品キーのリスト
        const itemKeys = ['nikuman', 'pizaman', 'anman', 'chocoman', 'oolongcha'];

        // 2. 残り在庫数を計算
        const remainingStock = {};
        
        itemKeys.forEach(key => {
            // 最大販売数 - 販売実績 を計算
            const max = maxLimits[key] || 0;
            const sold = salesStats[key] || 0;
            
            // 残り在庫数は 0 未満にならないように Math.max(0, ...) で制限
            remainingStock[key] = Math.max(0, max - sold);
        });

        // 3. クライアントに残りの在庫数データを返す
        res.json(remainingStock);

    } catch (e) {
        console.error("Error fetching remaining stock limits:", e);
        res.status(500).json({ error: "Failed to fetch stock limits" });
    }
});

// server.js の任意の場所（例：既存のAPIルート群の最後など）に追加

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

// ==========================================================
// POST /api/reserve (予約登録) - 商品注文項目を追加
// ==========================================================
app.post('/api/reserve', async (req, res) => {
    const userData = req.body;
    const { group, name, people } = userData;

    if (!group || !name || !people) {
        return res.status(400).send("Missing required fields: group, name, or people.");
    }

    try {
        // トランザクション内で在庫チェックと予約登録を行う
        const result = await db.runTransaction(async (t) => {
            
            // 0. 在庫制限ドキュメントを取得
            const stockLimitsRef = db.doc('settings/stockLimits');
            const stockLimitsSnap = await t.get(stockLimitsRef);
            if (!stockLimitsSnap.exists) {
                // エラーをスローするとトランザクションがロールバックされる
                throw new Error("Stock limits setting is not found."); 
            }
            const stockLimits = stockLimitsSnap.data();

            // 注文内容を検証
            if (!userData.items || typeof userData.items !== 'object' || Object.keys(userData.items).length === 0) {
                throw new Error("Items data is invalid or missing.");
            }
            for (const itemKey in userData.items) {
                const orderedAmount = userData.items[itemKey];
                const limit = stockLimits[itemKey] || 0;
                if (orderedAmount > limit) {
                    throw new Error(`Order for ${itemKey} (${orderedAmount}) exceeds the limit (${limit}).`);
                }
            }
            
            // 1. 団体別カウンターを取得し、連番を採番
            const counterRef = db.doc(COUNTER_DOC);
            const counterDoc = await t.get(counterRef);
            
            let currentNumber = 1;
            const currentCounters = counterDoc.exists ? counterDoc.data() : {};

            if (currentCounters[group]) {
                const lastUpdated = currentCounters[group].updatedAt.toDate();
                const now = new Date();
                const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

                if (now.getTime() - lastUpdated.getTime() > TWELVE_HOURS_MS) {
                    currentNumber = 1; 
                } else {
                    currentNumber = currentCounters[group].currentNumber + 1;
                }
            }
            
            // 2. カウンターを更新
            t.update(counterRef, {
                [group]: { 
                    currentNumber: currentNumber, 
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }
            });

            // 3. 予約ドキュメントを作成
            const newReservationRef = db.collection('reservations').doc();
            
            const groupPrefix = group.replace('-', '');
            const fullReservationNumber = `${groupPrefix}-${currentNumber}`; 
            
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
                notes: userData.notes || "",
                items: userData.items, // 注文内容を追加
            };
            
            t.set(newReservationRef, reservationData);

            return { success: true, number: fullReservationNumber, id: newReservationRef.id }; 
        });

        res.json(result);

    } catch (e) {
        // エラーハンドリングを修正
        console.error("Reservation registration failed:", e.message);
        // 在庫切れなどの具体的なエラーメッセージをクライアントに返す
        if (e.message.includes("exceeds the limit")) {
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
// GET /api/waiting-summary
// ==========================================================
app.get('/api/waiting-summary', async (req, res) => {
    try {
        const waitingSnap = await db.collection('reservations')
            .where('status', '==', 'waiting')
            .get();

        // 団体キーは動的に変わる可能性を考慮し、セットで管理する
        const groups = new Set();
        waitingSnap.forEach(doc => groups.add(doc.data().group));
        
        const summary = {};
        groups.forEach(group => {
            summary[group] = { groups: 0, people: 0 };
        });

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

        const calledNumbers = data.currentCalled;

        // Firestoreのin句制限を回避するため、クエリに渡すリストを最大10個にスライス
        let numbersToQuery = calledNumbers;
        if (numbersToQuery.length > 10) {
            numbersToQuery = numbersToQuery.slice(-10);
        }
        
        // "number" フィールドは複合文字列（例: "55-1"）として保存されていることを前提とする
        const calledReservationSnap = await db.collection('reservations')
            .where('status', 'in', ['called', 'seatEnter']) 
            .where('number', 'in', numbersToQuery)
            .get();
            
        const stillCalledNumbers = new Set();
        const TEN_MINUTES_MS = 10 * 60 * 1000;

        calledReservationSnap.forEach(rDoc => {
            const rData = rDoc.data();
            if (!rData.calledAt) return; 

            const calledAt = rData.calledAt.toDate(); 
            
            if (now.getTime() - calledAt.getTime() < TEN_MINUTES_MS) {
                stillCalledNumbers.add(rData.number);
            }
        });
        
        // 元のリストをフィルタリングして、まだ表示すべき番号だけを残す
        const finalCalledList = calledNumbers.filter(num => stillCalledNumbers.has(num));

        res.json({ currentCalled: finalCalledList, updatedAt: data.updatedAt });

    } catch (e) {
        console.error("Error fetching tv status:", e);
        res.status(500).json({ error: "Failed to fetch status" });
    }
});

// ==========================================================
// GET /api/reservations (管理画面用ルート)
// ==========================================================
// 🚨 このルートは変更不要です。(管理画面で全ての予約を取得し、フロント側でソート/フィルタリングするため)
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
// GET /api/sales-stats: 販売実績を集計 (Admin.js用)
// ==========================================================
app.get('/api/sales-stats', async (req, res) => {
    try {
        // "受取済み" と見なすステータス
        const completedStatuses = ['seatEnter', 'completed'];
        const salesSnap = await db.collection('reservations')
            .where('status', 'in', completedStatuses)
            .get();

        const stats = { nikuman: 0, pizaman: 0, anman: 0, chocoman: 0, oolongcha: 0 };

        salesSnap.forEach(doc => {
            const data = doc.data();
            if (data.items && typeof data.items === 'object') {
                for (const itemKey in stats) {
                    if (data.items[itemKey] && typeof data.items[itemKey] === 'number') {
                        stats[itemKey] += data.items[itemKey];
                    }
                }
            }
        });
        res.json(stats);
    } catch (e) {
        console.error("Error fetching sales stats:", e);
        res.status(500).json({ error: "Failed to fetch sales stats" });
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


// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server is running on port ${PORT}`));
