import React, { useState, useEffect, useMemo } from 'react';

// あなたのRenderサービスのURLに置き換える
const API_BASE_URL = 'https://hinodefes.onrender.com';

export default function Admin() {
  // availableをavailableCountにリネームし、初期値を1に設定
  const [availableCount, setAvailableCount] = useState(1);
  // 🚨 新しいState: 呼び出し対象の団体を追加
  const [callGroup, setCallGroup] = useState('5-5');
  const [reservations, setReservations] = useState([]);
  const [salesStats, setSalesStats] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // 関数名をsendComputeからhandleCallに変更
  async function handleCall() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/compute-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // State名に合わせて更新
          availableCount: Number(availableCount),
          apiSecret: process.env.REACT_APP_API_SECRET,
          // 🚨 callGroupをサーバーに送る
          callGroup: callGroup,
        })
      });

      if (!response.ok) {
        throw new Error(`API呼び出しに失敗しました: ${response.status}`);
      }

      const data = await response.json();
      if (data.called && data.called.length > 0) {
        alert('以下の番号を呼び出しました: ' + data.called.join(', '));
      } else {
        alert('呼び出せるグループがありませんでした。');
      }
    } catch (error) {
      console.error('呼出エラー:', error);
      alert('呼出処理中にエラーが発生しました。コンソールを確認してください。');
    }
  }

  useEffect(() => {
    fetchAdminData();
  }, []);

  async function fetchAdminData() {
    setLoading(true);
    setError(null);
    try {
        const [resReservations, resSales] = await Promise.all([
            fetch(`${API_BASE_URL}/api/reservations`),
            fetch(`${API_BASE_URL}/api/sales-stats`)
        ]);

        if (!resReservations.ok || !resSales.ok) {
            const errorText = await resReservations.text();
            throw new Error(`データの取得に失敗しました: ${errorText}`);
        }

        const reservationsData = await resReservations.json();
        const salesData = await resSales.json();

        // FirestoreのTimestampオブジェクトをDateオブジェクトに変換
        const formattedReservations = reservationsData.map(r => ({
            ...r,
            createdAt: r.createdAt && r.createdAt._seconds ? new Date(r.createdAt._seconds * 1000) : null,
            calledAt: r.calledAt && r.calledAt._seconds ? new Date(r.calledAt._seconds * 1000) : null,
        }));

        setReservations(formattedReservations);
        setSalesStats(salesData);

    } catch (err) {
        setError(err.message);
    } finally {
        setLoading(false);
    }
  }

  const handleStatusUpdate = async (id, number, status) => {
    const statusMap = { called: '呼び出し', completed: '受取済み' };
    if (!window.confirm(`番号【${number}】を「${statusMap[status] || status}」にしますか？`)) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/reservations/${id}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, apiSecret: process.env.REACT_APP_API_SECRET }),
        });
        if (!response.ok) throw new Error('ステータス更新に失敗しました。');
        await fetchAdminData(); // データを再取得してリストを更新
    } catch (err) {
        alert(err.message);
    }
  };

  const handleDelete = async (id, number) => {
    if (!window.confirm(`番号【${number}】を削除しますか？\nこの操作は元に戻せません。`)) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/reservations/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            // DELETEメソッドでもbodyでsecretを送る
            body: JSON.stringify({ apiSecret: process.env.REACT_APP_API_SECRET }),
        });
        if (!response.ok) throw new Error('削除に失敗しました。');
        await fetchAdminData(); // データを再取得してリストを更新
    } catch (err) {
        alert(err.message);
    }
  };
  
  const filteredAndSortedReservations = useMemo(() => {
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const now = new Date();

    const getStatusPriority = (r) => {
        if (r.status === 'called') {
            const calledAtTime = r.calledAt ? new Date(r.calledAt).getTime() : 0;
            return (now.getTime() - calledAtTime) > TEN_MINUTES_MS ? 2 : 1; // 1: 呼び出し中, 2: 呼び出し中(10分以上)
        }
        if (r.status === 'waiting') return 3; // 未呼び出し
        if (r.status === 'completed' || r.status === 'seatEnter') return 4; // 受取済み
        return 5; // その他
    };
    
    return reservations
        .filter(r => {
            const isCompleted = r.status === 'completed' || r.status === 'seatEnter';
            if (!showCompleted && isCompleted) return false;
            
            if (searchTerm === '') return true;

            const number = r.number || '';
            const name = r.name || '';
            return number.toLowerCase().includes(searchTerm.toLowerCase()) || name.toLowerCase().includes(searchTerm.toLowerCase());
        })
        .sort((a, b) => {
            const priorityA = getStatusPriority(a);
            const priorityB = getStatusPriority(b);
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
            // 同じ優先度内では受付が古い順
            const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return timeA - timeB;
        });
  }, [reservations, searchTerm, showCompleted]);

  return (
    <div style={{ padding: '20px', maxWidth: '400px', margin: 'auto' }}>
      <h1>管理者画面</h1>
      <p>完成した商品の個数と対象団体を入力して、呼び出しを実行します。</p>

      {/* 🚨 呼び出し対象の団体選択を追加 */}
      <div style={{ marginBottom: '15px' }}>
        <label>
          呼び出し対象の団体:
          <select
            value={callGroup}
            onChange={(e) => setCallGroup(e.target.value)}
            style={{ padding: '8px', marginLeft: '10px' }}
          >
            <option value="5-5">団体 5-5</option>
            <option value="5-2">団体 5-2</option>
            {/* 必要に応じて他の団体オプションを追加 */}
          </select>
        </label>
      </div>
      
      {/* State名をavailableCountに更新 */}
      <div style={{ marginBottom: '10px' }}>
        <label>
          完成個数：
          <input
            type="number"
            value={availableCount}
            onChange={(e) => setAvailableCount(e.target.value)}
            min={0}
            style={{ width: '100%', padding: '8px' }}
          />
        </label>
      </div>

      <button
        // 関数名をhandleCallに更新
        onClick={handleCall}
        style={{ padding: '10px 20px', backgroundColor: '#007BFF', color: 'white', border: 'none', cursor: 'pointer' }}
      >
        呼出実行
      </button>

      <div style={{ marginTop: '30px', borderTop: '2px solid #ccc', paddingTop: '20px' }}>
        {/* 販売実績セクション */}
        <h2>販売実績</h2>
        {loading && <p>読み込み中...</p>}
        {error && <p style={{ color: 'red' }}>{error}</p>}
        {salesStats && (
            <ul style={{ listStyle: 'none', padding: 0 }}>
                <li>肉まん: <strong>{salesStats.nikuman || 0}</strong>個</li>
                <li>ピザまん: <strong>{salesStats.pizaman || 0}</strong>個</li>
                <li>あんまん: <strong>{salesStats.anman || 0}</strong>個</li>
                <li>チョコまん: <strong>{salesStats.chocoman || 0}</strong>個</li>
                <li>烏龍茶: <strong>{salesStats.oolongcha || 0}</strong>本</li>
            </ul>
        )}
      </div>

      <div style={{ marginTop: '30px', borderTop: '2px solid #ccc', paddingTop: '20px' }}>
          {/* 予約リストセクション */}
          <h2>予約リスト</h2>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
              <input
                  type="text"
                  placeholder="番号 or 名前で検索"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  style={{ padding: '8px', flexGrow: 1 }}
              />
              <button onClick={fetchAdminData} disabled={loading} style={{ padding: '8px 12px' }}>
                  {loading ? '更新中...' : 'リスト更新'}
              </button>
              <label style={{ display: 'flex', alignItems: 'center' }}>
                  <input
                      type="checkbox"
                      checked={showCompleted}
                      onChange={(e) => setShowCompleted(e.target.checked)}
                      style={{ marginRight: '5px' }}
                  />
                  受取済みを表示
              </label>
          </div>

          <div style={{ marginTop: '15px' }}>
              {loading && <p>予約リストを読み込み中...</p>}
              {filteredAndSortedReservations.map((r) => {
                  const statusMap = {
                      waiting: { label: '未呼び出し', color: '#6c757d' },
                      called: { label: '呼び出し中', color: '#ffc107' },
                      seatEnter: { label: '受取済み', color: '#28a745' },
                      completed: { label: '受取済み', color: '#28a745' },
                  };
                  const statusInfo = statusMap[r.status] || { label: r.status, color: 'grey' };
                  const isOvertime = r.status === 'called' && (new Date().getTime() - new Date(r.createdAt).getTime()) > 600000;

                  const itemNames = { nikuman: '肉', pizaman: 'ピザ', anman: 'あん', chocoman: 'チョコ', oolongcha: '茶' };
                  const orderSummary = r.items ? Object.entries(r.items).filter(([, v]) => v > 0).map(([k, v]) => `${itemNames[k] || k}:${v}`).join(', ') : '情報なし';

                  return (
                      <div key={r.id} style={{ border: `2px solid ${statusInfo.color}`, padding: '10px', marginBottom: '10px', borderRadius: '5px', backgroundColor: isOvertime ? '#fff0f1' : 'white' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
                              <span>番号: {r.number} ({r.group})</span>
                              <span>{r.name}様 ({r.people}名)</span>
                              <span style={{ color: statusInfo.color }}>{statusInfo.label}{isOvertime && '(10分以上)'}</span>
                          </div>
                          <p style={{ margin: '5px 0' }}>注文: {orderSummary}</p>
                          <div style={{ marginTop: '10px', display: 'flex', gap: '5px' }}>
                              {r.status === 'waiting' && (
                                  <button onClick={() => handleStatusUpdate(r.id, r.number, 'called')} style={{backgroundColor: '#007bff'}}>呼び出し</button>
                              )}
                              {(r.status === 'waiting' || r.status === 'called') && (
                                  <button onClick={() => handleStatusUpdate(r.id, r.number, 'completed')} style={{backgroundColor: '#28a745'}}>受取済み</button>
                              )}
                              <button onClick={() => handleDelete(r.id, r.number)} style={{ backgroundColor: '#dc3545', color: 'white' }}>削除</button>
                          </div>
                      </div>
                  );
              })}
          </div>
      </div>
    </div>
  );
}
