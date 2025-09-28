// server.js 内の POST /api/compute-call の変更箇所

app.post('/api/compute-call', async (req, res) => {
    
    // ... (認証とavailablePeopleのチェックは省略)
    const availablePeople = parseInt(req.body.availableCount, 10);
    const callGroup = req.body.callGroup; // 🚨 管理画面から送られてきた団体名を取得
    
    // 団体のバリデーション (必須)
    if (!callGroup || (callGroup !== '5-5' && callGroup !== '5-2')) {
        return res.status(400).send('bad callGroup (must be 5-5 or 5-2)');
    }

    // ... (MAX_PER_PERSON_DOCの取得は削除済みとして省略)

    let waitingQuery = db.collection('reservations')
      .where('status', '==', 'waiting')
      .where('group', '==', callGroup) // 🚨 追加: 選択された団体のみを絞り込む
      .orderBy('createdAt', 'asc');
      
    const waitingSnap = await waitingQuery.get();

    let totalNeeded = 0;
    const selected = [];
    waitingSnap.forEach(doc => {
      // 🚨 ロジック変更なし: 空き人数 availablePeople に達するまで人数 (d.people) で呼び出す
      if (totalNeeded >= availablePeople) return; 
      
      const d = doc.data();
      const need = d.people || 1; 
      
      if (totalNeeded + need <= availablePeople) {
        totalNeeded += need; 
        selected.push({ id: doc.id, data: d });
      }
    });

    // ... (以下、バッチ処理やLINE通知は変更なし)
});
