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
const COUNTER_DOC = 'settings/counters'; // カウンターを管理する場所

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
// LINE Replyユーティリティ (Webhookイベントの応答用) 
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
// POST /api/reserve: 予約登録と団体別連番採番 (フロントエンドから叩く)
// ==========================================================
app.post('/api/reserve', async (req, res) => {
    
    const userData = req.body;
    
    // 必須チェックにgroupを追加
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

            // 3. 予約ドキュメントを作成 (numberとgroupを付与)
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

            // 戻り値も修正
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

            // 変更を実行
            await docRef.update({
                lineUserId: lineUserId,
                pendingLineUserId: admin.firestore.FieldValue.delete()
            });

            const successMessage = `番号 ${reservationNumber} の通知先を、このアカウントに変更しました！準備ができたら通知します。`;
            await sendLineReply(replyToken, successMessage);
        }

        // -----------------------------------------------------
        // 3. テキストメッセージ受信時 (番号入力)
        // -----------------------------------------------------
        else if (event.type === 'message' && event.message.type === 'text') {

            const reservationNumber = inputText; // 複合番号は文字列のまま

            // A. 入力が空ではないことを確認
            if (!reservationNumber) {
                const message = '申し訳ありません、通知設定には「受付番号」が必要です。番号を再入力してください。例: 55-1';
                await sendLineReply(replyToken, message);
                continue;
            }

            // B. 予約番号の検索
            const reservationSnap = await db.collection('reservations')
                .where('number', '==', reservationNumber)
                .where('status', 'in', ['waiting', 'called']) // waitingとcalledの両方で紐付け可能とする
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

            // C. 既にLINE IDが紐付いているかチェック
            if (docData.lineUserId) {
                if (docData.lineUserId === lineUserId) {
                    // 自分自身のものである場合 (二重通知設定)
                    const message = `番号 ${reservationNumber} は既にあなたのLINEに紐付け済みです。準備ができたら通知します！`;
                    await sendLineReply(replyToken, message);
                } else {
                    // 🚨 別のユーザーのLINE IDが紐付いている場合（変更希望を尋ねる）
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
// POST /api/compute-call (管理画面からの呼び出し実行 - 人数ベースに修正)
// ==========================================================

app.post('/api/compute-call', async (req, res) => {
    
    if (req.body.apiSecret !== process.env.API_SECRET) return res.status(403).send('forbidden');
    
    // availableCountをavailablePeopleに読み替え
    const availablePeople = parseInt(req.body.availableCount, 10); // フロントエンドはavailableCountというキーで人数を送ってくる前提
    
    // availablePeopleでチェック
    if (isNaN(availablePeople) || availablePeople <= 0) { 
        return res.status(400).send('bad available (must be a valid positive number)');
    }

    const waitingSnap = await db.collection('reservations')
      .where('status', '==', 'waiting')
      .orderBy('createdAt', 'asc') // FIFO
      .get();

    let totalNeeded = 0;
    const selected = [];
    waitingSnap.forEach(doc => {
      // totalNeededがavailablePeopleを超えたら終了
      if (totalNeeded >= availablePeople) return; 
      
      const d = doc.data();
      const need = d.people || 1; // 必要なのはその予約の人数そのまま
      
      // 合計人数が空き人数を超えないなら採用
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
    const calledNumbers = [];
    
    selected.forEach(item => {
        // 予約番号は既に文字列（例: "55-1"）
        const reservationNumber = item.data.number !== undefined ? item.data.number : '99-99'; 
        
        const rRef = db.collection('reservations').doc(item.id);
        
        batch.update(rRef, { 
            status: 'called', 
            calledAt: now,
            number: reservationNumber // 文字列をそのまま保存
        });
        
        calledNumbers.push(reservationNumber);
        
        // LINE通知の実行
        if (item.data.wantsLine && item.data.lineUserId) {
            const text = `ご準備ができました。番号 ${reservationNumber} さん、受付へお戻りください。`;
            sendLinePush(item.data.lineUserId, text).catch(e => console.error(e));
        }
    });

    // update /tv/state
    const tvRef = db.doc('tv/state');
    batch.set(tvRef, { currentCalled: calledNumbers, updatedAt: now }, { merge: true });

    await batch.commit();

    await db.collection('logs').add({
        type: 'call',
        reservationIds: selected.map(s=>s.id),
        available: availablePeople, // ログに残す値
        createdAt: now
    });

    res.json({ success: true, called: calledNumbers, totalNeeded });
});

// ==========================================================
// GET /api/waiting-summary: 団体別の待ち状況サマリー 🚨 追加されたエンドポイント
// ==========================================================
app.get('/api/waiting-summary', async (req, res) => {
    try {
        // 待機中の予約のみを取得
        const waitingSnap = await db.collection('reservations')
            .where('status', '==', 'waiting')
            .get();

        const summary = {
            '5-5': { groups: 0, people: 0 },
            '5-2': { groups: 0, people: 0 },
            // その他のグループが追加されたらここに追加可能
        };
        
        waitingSnap.forEach(doc => {
            const data = doc.data();
            const groupKey = data.group; // '5-5' or '5-2'
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
        
        // TVに表示中の番号がない、またはデータがない場合はスキップ
        if (!data.currentCalled || data.currentCalled.length === 0) {
            return res.json({ currentCalled: [], updatedAt: data.updatedAt });
        }

        // 呼び出された予約ドキュメントを再確認する
        const calledReservationSnap = await db.collection('reservations')
            .where('status', 'in', ['called', 'seatEnter']) // called または seatEnter の状態にあるものをチェック
            .where('number', 'in', data.currentCalled) // TVに表示中の番号のみを検索
            .get();
            
        const stillCalledNumbers = [];
        const TEN_MINUTES_MS = 10 * 60 * 1000;

        calledReservationSnap.forEach(rDoc => {
            const rData = rDoc.data();
            // calledAtがない場合は、その予約は表示すべきではないのでスキップ
            if (!rData.calledAt) return; 

            const calledAt = rData.calledAt.toDate(); 
            
            // ロジック: 呼び出し時刻から10分以内なら表示を継続
            if (now.getTime() - calledAt.getTime() < TEN_MINUTES_MS) {
                stillCalledNumbers.push(rData.number);
            }
            // 10分経過した予約はここではステータスを変更せず、単にTVから消すだけにする
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
