const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

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
const COUNTER_DOC = 'settings/counter'; // 🚨 カウンターを一つに簡素化

// ==========================================================
// LINE Push通知ユーティリティ
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
// LINE Replyユーティリティ
// ==========================================================

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
// POST /api/reserve: 予約登録と連番採番 (団体機能削除)
// ==========================================================
app.post('/api/reserve', async (req, res) => {
    
    const userData = req.body;
    
    // 必須チェックからgroupを削除
    if (!userData.name || !userData.people || userData.people <= 0) { 
        return res.status(400).send('Invalid reservation data (name or people missing).');
    }
    
    try {
        const result = await db.runTransaction(async (t) => {
            
            // 1. 全体カウンターを取得し、連番を採番
            const counterRef = db.doc(COUNTER_DOC);
            const counterSnap = await t.get(counterRef);
            
            let nextNumber = 1;
            if (counterSnap.exists && counterSnap.data().globalCounter) {
                nextNumber = counterSnap.data().globalCounter + 1;
            }
            
            // 2. カウンターを更新
            t.set(counterRef, { globalCounter: nextNumber }, { merge: true });

            // 3. 予約ドキュメントを作成 (numberは連番のみ)
            const newReservationRef = db.collection('reservations').doc();
            
            // 🚨 予約番号は数値のまま
            const reservationNumber = nextNumber; 
            
            const reservationData = {
                name: userData.name, 
                people: parseInt(userData.people, 10), 
                wantsLine: !!userData.wantsLine,
                lineUserId: userData.lineUserId || null,
                // group: '5-5' 団体名は固定で保存 (旧システム互換のため残しても良いが、今回はロジックから削除)
                number: reservationNumber, // 数値 (例: 1, 2, 3...)
                status: 'waiting',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                calledAt: null,
                seatEnterAt: null,
                notes: userData.notes || ""
            };
            
            t.set(newReservationRef, reservationData);

            // 戻り値も修正 (文字列から数値へ)
            return { success: true, number: reservationNumber, id: newReservationRef.id }; 
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
app.post('/api/line-webhook', async (req, res) => {

    const events = req.body.events;
    if (!events || events.length === 0) return res.sendStatus(200);

    for (const event of events) {
        const lineUserId = event.source.userId;
        const replyToken = event.replyToken;
        // メッセージイベントではない場合、inputTextはnullまたは空文字列になる
        const inputText = (event.type === 'message' && event.message.type === 'text') ? event.message.text.trim() : null;

        // -----------------------------------------------------
        // 🚨 修正: 複合番号(55-1)ではなく、連番(1)を想定
        // -----------------------------------------------------
        
        // 1. 友だち追加時 (follow)
        if (event.type === 'follow') {
            const message = '友だち追加ありがとうございます！\n準備完了の通知をご希望の場合は、お手持ちの「受付番号」をメッセージで送信してください。例: 1';
            await sendLineReply(replyToken, message);
        }

        // 2. 「はい」のメッセージ受信時 (変更承認) は修正不要（pendingLineUserIdで検索するため）

        // 3. テキストメッセージ受信時 (番号入力)
        else if (event.type === 'message' && event.message.type === 'text') {

            const reservationNumber = parseInt(inputText, 10); // 🚨 数値に変換
            
            // A. 入力が有効な数値か確認
            if (isNaN(reservationNumber) || reservationNumber <= 0) {
                const message = '申し訳ありません、通知設定には「受付番号」が必要です。番号を再入力してください。例: 1';
                await sendLineReply(replyToken, message);
                continue;
            }

            // B. 予約番号の検索
            const reservationSnap = await db.collection('reservations')
                .where('number', '==', reservationNumber) // 🚨 numberは数値として検索
                .where('status', 'in', ['waiting', 'called']) 
                .where('wantsLine', '==', true)
                .limit(1)
                .get();

            if (reservationSnap.empty) {
                // 予約が見つからない場合
                const message = `番号 ${reservationNumber} の「待機中」または「呼び出し中」の予約は見つかりませんでした。番号を確認してください。`;
                await sendLineReply(replyToken, message);
                continue;
            }

            const doc = reservationSnap.docs[0];
            const docData = doc.data();
            const docRef = doc.ref;

            // C. 既にLINE IDが紐付いているかチェック (ロジック変更なし)
            if (docData.lineUserId) {
                if (docData.lineUserId === lineUserId) {
                    const message = `番号 ${reservationNumber} は既にあなたのLINEに紐付け済みです。準備ができたら通知します！`;
                    await sendLineReply(replyToken, message);
                } else {
                    const message = `番号 ${reservationNumber} は、既に別のLINEアカウントに紐付けされています。\n\n**この番号の通知先を、このアカウントに変更しますか？**\n\n変更する場合は【はい】と返信してください。`;
                    await sendLineReply(replyToken, message);
                    await docRef.update({
                        pendingLineUserId: lineUserId
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
// POST /api/compute-call (管理画面からの呼び出し実行 - 団体機能削除) 🚨 修正
// ==========================================================

app.post('/api/compute-call', async (req, res) => {
    
    try { 
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        const availablePeople = parseInt(req.body.availableCount, 10); // 空き人数
        
        // 団体バリデーションは不要
        
        if (isNaN(availablePeople) || availablePeople <= 0) {  
            return res.status(400).send('bad available (must be a valid positive number)');
        }


        // 🚨 修正: groupによる絞り込みを削除
        let waitingQuery = db.collection('reservations')
          .where('status', '==', 'waiting')
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

        // Firestoreの更新とLINE通知
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const calledNumbers = []; // 🚨 数値のリストになる
        
        selected.forEach(item => {
            const reservationNumber = item.data.number !== undefined ? item.data.number : 99; // 🚨 数値
            
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

        // 🚨 修正: TV表示リストの追記ロジック (団体削除後も機能維持)
        const tvRef = db.doc('tv/state');
        const tvSnap = await tvRef.get(); 
        const currentCalled = tvSnap.exists && Array.isArray(tvSnap.data().currentCalled)
                              ? tvSnap.data().currentCalled
                              : [];
                              
        const newCalledSet = new Set([...currentCalled, ...calledNumbers]);
        const updatedCalledList = Array.from(newCalledSet); 

        batch.set(tvRef, { 
            currentCalled: updatedCalledList, 
            updatedAt: now 
        }, { merge: true }); 

        await batch.commit();

        await db.collection('logs').add({
            type: 'call',
            reservationIds: selected.map(s=>s.id),
            available: availablePeople,
            createdAt: now
        });

        res.json({ success: true, called: calledNumbers, totalNeeded });

    } catch (e) {
        console.error("CRITICAL ERROR IN COMPUTE-CALL:", e); 
        return res.status(500).send("Internal Server Error. Check Render logs for details.");
    }
});

// ==========================================================
// GET /api/waiting-summary: 団体別の待ち状況サマリーを修正
// ==========================================================
app.get('/api/waiting-summary', async (req, res) => {
    try {
        // 待機中の予約のみを取得
        const waitingSnap = await db.collection('reservations')
            .where('status', '==', 'waiting')
            .get();

        // 🚨 修正: 待ち状況のサマリーを全体で集計
        let totalGroups = 0;
        let totalPeople = 0;
            
        waitingSnap.forEach(doc => {
            const data = doc.data();
            const people = data.people || 1;
            
            totalGroups += 1; // 予約団体数（組数）
            totalPeople += people; // 待ち人数（合計人数）
        });

        // 応答形式を簡素化
        res.json({ groups: totalGroups, people: totalPeople });

    } catch (e) {
        console.error("Error fetching waiting summary:", e);
        res.status(500).json({ error: "Failed to fetch summary" });
    }
});


// ==========================================================
// GET /api/tv-status (TV表示用ルート - 10分ルールを適用) 🚨 修正
// ==========================================================
app.get('/api/tv-status', async (req, res) => {
    try {
        const tvDoc = await db.doc('tv/state').get();
        const tvData = tvDoc.exists ? tvDoc.data() : { currentCalled: [], updatedAt: null };

        // 呼び出し中の番号をリストアップ
        const currentCalledNumbers = Array.isArray(tvData.currentCalled) ? tvData.currentCalled : [];
        
        // 🚨 予約リスト全体（最大100件）を取得
        const allReservationsSnap = await db.collection('reservations')
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();
        
        const reservations = [];
        const TEN_MINUTES_MS = 10 * 60 * 1000;
        const now = new Date();

        allReservationsSnap.docs.forEach(rDoc => {
            const rData = rDoc.data();
            const calledAt = rData.calledAt ? rData.calledAt.toDate() : null;
            
            let displayStatus = rData.status; // 'waiting', 'called', 'seatEnter'

            // 10分ルールの判定
            if (rData.status === 'called' && calledAt) {
                 if (now.getTime() - calledAt.getTime() > TEN_MINUTES_MS) {
                     // 10分以上経過した場合は、TV表示では「Missed」扱いにする
                     displayStatus = 'missed'; 
                 }
            }

            reservations.push({
                id: rDoc.id,
                number: rData.number,
                name: rData.name,
                people: rData.people,
                status: displayStatus,
                createdAt: rData.createdAt ? rData.createdAt.toDate().toISOString() : null,
                calledAt: calledAt ? calledAt.toISOString() : null,
            });
        });

        // 応答: TV表示中の番号と、予約リスト全体を返す
        res.json({ 
            currentCalled: currentCalledNumbers, 
            updatedAt: tvData.updatedAt,
            reservations: reservations // 🚨 予約リストを追加
        });

    } catch (e) {
        console.error("Error fetching tv status:", e);
        res.status(500).json({ error: "Failed to fetch status" });
    }
});

// ==========================================================
// GET /api/reservations (管理画面用ルート)
// ==========================================================
app.get('/api/reservations', async (req, res) => {
    // 変更なし
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


// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server on', PORT));
