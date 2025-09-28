// server/server.jsの冒頭付近

// 必要なライブラリをインポート
const express = require('express');
const cors = require('cors'); // 必須
const admin = require('firebase-admin');
// 🚨 修正: CommonJS形式でインポートに戻す
const fetch = require('node-fetch'); 

// サーバーを初期化
const app = express();
// ... (他のCORS, app.use(express.json()) の設定はそのまま)

// 環境変数の設定...
// ...
const db = admin.firestore();

const MAX_PER_PERSON_DOC = 'settings/system';

// サーバー起動とルーティングを非同期関数でラップ (fetchのインポートがなくなったのでasyncは不要だが、維持)
async function startServer() {
    // 🚨 削除: fetchのインポートは不要
    // const nodeFetch = await import('node-fetch');
    // const fetch = nodeFetch.default;


    // LINE push 関数（コメントアウトしたままでOK）
    /*
    async function sendLinePush(toUserId, messageText) {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
    // ...
    */
    
    // ... (app.post ルーティング以下はすべてそのまま)
    
    // fetchのインポート後にlistenを開始
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, ()=> console.log('Server on', PORT));
}

// サーバー起動関数を実行し、エラーをキャッチ
startServer().catch(e => {
    console.error("FATAL SERVER CRASH:", e);
    // Renderのログに残すために、ここでアプリを終了させる
    process.exit(1); 
});
