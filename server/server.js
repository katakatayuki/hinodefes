const express = require('express');
const cors = require('cors'); 
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

// CORSを詳細に設定
app.use(cors({
    origin: '*',  // すべてのドメインからのアクセスを許可
    methods: ['GET', 'POST', 'DELETE'] // DELETEメソッドも追加
}));

app.use(express.json());

// Firebaseの初期化
try {
    // 🚨 環境変数からサービスアカウントキーを読み込む
    // サービスアカウントキーは実行環境の環境変数 'FIREBASE_SERVICE_ACCOUNT' にJSON文字列として設定されている必要があります。
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error("Firebase initialization failed. Check FIREBASE_SERVICE_ACCOUNT variable.");
    // 開発環境によっては初期化失敗を許容する場合もありますが、ここでは終了します。
    process.exit(1);
}

const db = admin.firestore();
// 団体ごとの連番カウンターを管理するドキュメント
const COUNTER_DOC = 'settings/counters';

// ==========================================================
// LINE Push通知ユーティリティ
// ==========================================================

/**
 * 指定されたLINEユーザーIDへプッシュ通知を送信します。
 * @param {string} toUserId - LINEユーザーID
 * @param {string} messageText - 送信するメッセージ
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
        console.error('LINE push failed:', res.status, await res.text());
    }
}


// ==========================================================
// LINE Replyユーティリティ (Webhookイベントの応答用) 
// ==========================================================

/**
 * LINE Webhookイベントに対して応答メッセージを送信します。
 * @param {string} replyToken - Webhookイベントに含まれる応答トークン
 * @param {string} messageText - 送信するメッセージ
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
            replyToken: replyToken, // Webhookイベントの応答トークン
            messages: [{ type: 'text', text: messageText }]
        })
    });
    if (!res.ok) {
        console.error('LINE reply failed:', res.status, await res.text());
    }
}


// ==========================================================
// POST /api/reserve: 予約登録と団体別連番採番 (フロントエンドから叩く)
// ==========================================================
app.post('/api/reserve', async (req, res) => {
    
    const userData = req.body;
    
    // 必須チェック (名前、人数、団体名)
    if (!userData.name || !userData.people || userData.people <= 0 || !userData.group) { 
        return res.status(400).send('Invalid reservation data (name, people, or group missing).');
    }
    
    // 団体名からプレフィックスを取得 (例: '5-5' -> 55, '5-2' -> 52)
    const groupPrefix = userData.group.replace('-', '');
    const groupCounterKey = `counter_${groupPrefix}`; // 例: counter_55

    try {
        const result = await db.runTransaction(async (t) => {
            
            // 1. 団体別カウンターを取得し、連番を採番
            const counterRef = db.doc(COUNTER_DOC);
            const counterSnap = await t.get(counterRef);
            
            let nextNumber = 1;
            if (counterSnap.exists && counterSnap.data()[groupCounterKey]) {
                nextNumber = counterSnap.data()[groupCounterKey] + 1;
            }
            
            // 2. カウンターを更新
            const updateData = {};
            updateData[groupCounterKey] = nextNumber;
            t.set(counterRef, updateData, { merge: true });

            // 3. 予約ドキュメントを作成
            const newReservationRef = db.collection('reservations').doc();
            
            // 予約番号の最終形式は文字列 (例: "55-1", "52-3")
            const fullReservationNumber = `${groupPrefix}-${nextNumber}`; 
            
            const reservationData = {
                name: userData.name, 
                people: parseInt(userData.people, 10), 
                wantsLine: !!userData.wantsLine,
                lineUserId: userData.lineUserId || null,
                group: userData.group, // 団体名も保存
                number: fullReservationNumber, // 複合番号を保存
                status: 'waiting',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                calledAt: null,
                seatEnterAt: null,
                notes: userData.notes || ""
            };
            
            t.set(newReservationRef, reservationData);

            // クライアントへ返す結果
            return { success: true, number: fullReservationNumber, id: newReservationRef.id }; 
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
        // LINEユーザーIDと応答トークンを取得
        const lineUserId = event.source.userId;
        const replyToken = event.replyToken;
        // メッセージイベントではない場合、inputTextはnullまたは空文字列になる
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
            // 保留中のLINE IDを持つ「待機中」の予約を探す
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

            // 変更を実行: lineUserIdを確定させ、pendingLineUserIdを削除
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

            const reservationNumber = inputText; // 複合番号 (例: 55-1)

            if (!reservationNumber) {
                const message = '申し訳ありません、通知設定には「受付番号」が必要です。番号を再入力してください。例: 55-1';
                await sendLineReply(replyToken, message);
                continue;
            }

            // 予約番号の検索: 待機中または呼び出し中のものを探す
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
                    // 自分自身のものである場合 (二重通知設定)
                    const message = `番号 ${reservationNumber} は既にあなたのLINEに紐付け済みです。準備ができたら通知します！`;
                    await sendLineReply(replyToken, message);
                } else {
                    // 別のユーザーのLINE IDが紐付いている場合（変更希望を尋ねる）
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

    res.sendStatus(200);
});


// ==========================================================
// POST /api/compute-call (管理画面からの呼び出し実行 - 団体別・人数ベース) 🚨 TV表示修正
// ==========================================================

app.post('/api/compute-call', async (req, res) => {
    
    try {
        // APIシークレットによる認証
        if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
        
        // パラメータの取得
        const availablePeople = parseInt(req.body.availableCount, 10); // 空き人数
        const callGroup = req.body.callGroup; // 呼び出し対象の団体名 (例: '5-5')
        
        // バリデーション
        if (isNaN(availablePeople) || availablePeople <= 0) { 
            return res.status(400).send('bad available (must be a valid positive number)');
        }
        if (!callGroup || (callGroup !== '5-5' && callGroup !== '5-2')) {
            return res.status(400).send('bad callGroup (must be 5-5 or 5-2)');
        }

        // 選択された団体の「待機中」の予約を古い順に取得
        let waitingQuery = db.collection('reservations')
          .where('status', '==', 'waiting')
          .where('group', '==', callGroup) // 団体で絞り込む
          .orderBy('createdAt', 'asc');
          
        const waitingSnap = await waitingQuery.get();

        let totalNeeded = 0;
        const selected = [];
        
        // 待ち人数ベースで、空き人数を超えない範囲で予約を選択
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

        // 呼び出し対象の予約ドキュメントを更新するバッチ処理を開始
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const calledNumbers = [];
        const tvRef = db.doc('tv/state');
        
        // 1. 現在のTV表示ステータスを取得 (バッチ外で実行が必要)
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

        // 2. 既存のリストに新しい番号を追記し、重複を削除する (念のためSetを使用)
        const newCalledSet = new Set([...currentCalled, ...calledNumbers]);
        const updatedCalledList = Array.from(newCalledSet); 

        // 3. バッチでTV表示用のドキュメントを更新 (追記)
        batch.set(tvRef, { 
            currentCalled: updatedCalledList, 
            updatedAt: now 
        }, { merge: true }); 

        await batch.commit();

        // ログを記録
        await db.collection('logs').add({
            type: 'call',
            reservationIds: selected.map(s=>s.id),
            available: availablePeople,
            callGroup: callGroup, // 呼び出した団体名
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
// GET /api/waiting-summary: 団体別の待ち状況サマリー
// ==========================================================
app.get('/api/waiting-summary', async (req, res) => {
    try {
        // 待機中の予約のみを取得
        const waitingSnap = await db.collection('reservations')
            .where('status', '==', 'waiting')
            .get();

        const summary = {
            '5-5': { groups: 0, people: 0 }, // 団体 5-5 のサマリー
            '5-2': { groups: 0, people: 0 }, // 団体 5-2 のサマリー
        };
        
        waitingSnap.forEach(doc => {
            const data = doc.data();
            const groupKey = data.group; 
            const people = data.people || 1;
            
            // 定義されたグループのみをカウント対象とする
            if (summary.hasOwnProperty(groupKey)) {
                summary[groupKey].groups += 1; // 予約団体数（組数）
                summary[groupKey].people += people; // 待ち人数（合計人数）
            }
        });

        res.json(summary);

    } catch (e) {
        console.error("Error fetching waiting summary:", e);
        res.status(500).json({ error: "Failed to fetch summary" });
    }
});

// ==========================================================
// POST /api/update-status (管理画面からのステータス強制変更)
// ==========================================================
app.post('/api/update-status', async (req, res) => {
    
    const { reservationId, newStatus, apiSecret } = req.body;

    // 1. 認証チェック
    if (apiSecret !== process.env.API_SECRET) {
        return res.status(403).send('forbidden');
    }

    // 2. パラメータチェック
    if (!reservationId || !newStatus || !['called', 'seatEnter', 'waiting'].includes(newStatus)) {
        return res.status(400).send('Invalid parameters (reservationId or newStatus).');
    }

    try {
        const docRef = db.collection('reservations').doc(reservationId);
        const updateData = {
            status: newStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // ステータスに応じて特定のタイムスタンプを更新
        const now = admin.firestore.FieldValue.serverTimestamp();
        
        if (newStatus === 'called') {
            updateData.calledAt = now;
            // seatEnterAt を null に戻す（再呼び出しの可能性を考慮）
            updateData.seatEnterAt = null; 
        } else if (newStatus === 'seatEnter') {
            updateData.seatEnterAt = now;
        } else if (newStatus === 'waiting') {
            // waitingに戻す操作は、calledAtやseatEnterAtは更新しないが、ステータスは変更する
            // 必要に応じて、calledAtやseatEnterAtをリセットしないようにする
        }

        await docRef.update(updateData);
        
        // 🚨 ステータスが変更された場合、TV表示のリストも調整する（特に called の場合）
        if (newStatus === 'called') {
            // compute-call と同様に、TV表示リストに追加する処理を安全に行う
            const reservationSnap = await docRef.get();
            // ドキュメントが存在し、numberフィールドがあることを確認
            const reservationNumber = reservationSnap.exists ? reservationSnap.data().number : null;

            if (reservationNumber) {
                const tvRef = db.doc('tv/state');
                
                await db.runTransaction(async (t) => {
                    const tvSnap = await t.get(tvRef);
                    const currentCalled = tvSnap.exists && tvSnap.data().currentCalled ? tvSnap.data().currentCalled : [];
                    
                    const newCalledSet = new Set([...currentCalled, reservationNumber]);
                    const updatedCalledList = Array.from(newCalledSet); 

                    t.set(tvRef, { 
                        currentCalled: updatedCalledList, 
                        updatedAt: now 
                    }, { merge: true }); 
                });
            }
        } else {
             // 'seatEnter' や 'waiting' に変更された場合、TV表示リストから削除する必要がある
             const reservationSnap = await docRef.get();
             const reservationNumber = reservationSnap.exists ? reservationSnap.data().number : null;

             if (reservationNumber) {
                const tvRef = db.doc('tv/state');
                
                await db.runTransaction(async (t) => {
                    const tvSnap = await t.get(tvRef);
                    const currentCalled = tvSnap.exists && tvSnap.data().currentCalled ? tvSnap.data().currentCalled : [];
                    
                    // 削除対象番号を除外した新しいリストを作成
                    const updatedCalledList = currentCalled.filter(n => n !== reservationNumber);

                    t.set(tvRef, { 
                        currentCalled: updatedCalledList, 
                        updatedAt: now 
                    }, { merge: true }); 
                });
             }
        }
        
        res.json({ success: true, status: newStatus });

    } catch (e) {
        console.error("Error updating status:", e);
        res.status(500).json({ error: "Failed to update reservation status" });
    }
});

// ==========================================================
// DELETE /api/reservations/:id (管理画面からの予約削除)
// ==========================================================
// :id は予約のドキュメントID
app.delete('/api/reservations/:id', async (req, res) => {
    
    const reservationId = req.params.id;
    const { apiSecret } = req.body; 

    // 1. 認証チェック (DELETEリクエストでもbodyを使ってapiSecretをチェック)
    if (apiSecret !== process.env.API_SECRET) {
        return res.status(403).send('forbidden');
    }

    // 2. パラメータチェック
    if (!reservationId) {
        return res.status(400).send('Reservation ID is missing.');
    }

    try {
        const docRef = db.collection('reservations').doc(reservationId);
        
        // 削除対象の番号を取得し、TV表示リストから削除する処理を行う
        const snap = await docRef.get();
        // ドキュメントが存在しない場合は何もしない
        const reservationNumber = snap.exists ? snap.data().number : null;

        await docRef.delete();

        // 🚨 削除が成功した場合、TV表示のリストから該当番号を削除する処理を行う
        if (reservationNumber) {
            const tvRef = db.doc('tv/state');
            const now = admin.firestore.FieldValue.serverTimestamp();
            
            await db.runTransaction(async (t) => {
                const tvSnap = await t.get(tvRef);
                const currentCalled = tvSnap.exists && tvSnap.data().currentCalled ? tvSnap.data().currentCalled : [];
                
                // 削除対象番号を除外した新しいリストを作成
                const updatedCalledList = currentCalled.filter(n => n !== reservationNumber);

                t.set(tvRef, { 
                    currentCalled: updatedCalledList, 
                    updatedAt: now 
                }, { merge: true }); 
            });
        }

        res.json({ success: true, message: `Reservation ${reservationId} deleted.` });

    } catch (e) {
        console.error("Error deleting reservation:", e);
        res.status(500).json({ error: "Failed to delete reservation" });
    }
});


// ==========================================================
// GET /api/tv-status (TV表示用ルート - 10分ルールを適用)
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

        // TVに表示中の番号を再確認し、10分ルールを適用
        const calledReservationSnap = await db.collection('reservations')
            // 呼び出し中または着席入力済みのものをチェック
            .where('status', 'in', ['called', 'seatEnter']) 
            .where('number', 'in', data.currentCalled) 
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


// サーバーの待ち受け開始
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server on', PORT));
