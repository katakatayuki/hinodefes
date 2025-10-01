import React, { useState, useEffect } from 'react';

// あなたのRenderサービスのURLに置き換える
const API_BASE_URL = 'https://hinodefes.onrender.com';

// 予約の状態を判別するヘルパー関数
const getReservationStatus = (reservation) => {
    // ステータスを日本語で表示するための定義
    const statusMap = {
        'waiting': '待機中 (未呼出)',
        'called': '呼び出し中',
        'seatEnter': '受け取り済み', // 席に着いた（受け取り済み）として扱う
    };

    const statusText = statusMap[reservation.status] || 'その他';

    // 呼び出し中、かつcalledAtが存在する場合に10分ルールを適用
    if (reservation.status === 'called' && reservation.calledAt) {
        // calledAtはFirestoreのTimestampオブジェクト、またはDateオブジェクトを想定
        const calledAtMs = reservation.calledAt.seconds 
            ? reservation.calledAt.seconds * 1000 // Firestore Timestampの場合
            : new Date(reservation.calledAt).getTime(); // Dateオブジェクトの場合 (APIレスポンスによっては文字列の可能性もあるため、念のため)

        const now = new Date().getTime();
        const TEN_MINUTES_MS = 10 * 60 * 1000;

        if (now - calledAtMs >= TEN_MINUTES_MS) {
            return '🚨 呼び出し期限切れ (10分経過)';
        }
    }
    
    return statusText;
};

// 状態に応じて背景色を設定するヘルパー関数
const getRowColor = (status) => {
    if (status.includes('期限切れ')) {
        return '#ffdddd'; // 薄い赤
    }
    if (status.includes('呼び出し中')) {
        return '#fffacd'; // 薄い黄色
    }
    if (status.includes('受け取り済み')) {
        return '#ddffdd'; // 薄い緑
    }
    return '#ffffff'; // デフォルト
};


export default function Admin() {
    const [availableCount, setAvailableCount] = useState(1);
    const [callGroup, setCallGroup] = useState('5-5');
    // 🚨 追加: 予約一覧の状態
    const [reservations, setReservations] = useState([]);
    // 🚨 追加: ローディング状態
    const [isLoading, setIsLoading] = useState(false);
    // 🚨 追加: 最終更新時刻 (UIでリフレッシュ時刻を示すため)
    const [lastFetchTime, setLastFetchTime] = useState(null);

    // 🚨 関数: 予約一覧を取得
    const fetchReservations = async () => {
        setIsLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/reservations`);
            if (!response.ok) {
                throw new Error(`予約一覧の取得に失敗しました: ${response.status}`);
            }
            const data = await response.json();

            // createdAtでソート (サーバー側で降順に取得しているが、念のため)
            // Firebase Timestamp形式か、文字列/Dateオブジェクトを想定
            data.sort((a, b) => {
                const timeA = a.createdAt?.seconds || new Date(a.createdAt).getTime();
                const timeB = b.createdAt?.seconds || new Date(b.createdAt).getTime();
                return timeB - timeA;
            });

            setReservations(data);
            setLastFetchTime(new Date());

        } catch (error) {
            console.error('予約一覧取得エラー:', error);
            alert('予約一覧の取得中にエラーが発生しました。コンソールを確認してください。');
        } finally {
            setIsLoading(false);
        }
    };

    // 🚨 useEffect: ページ読み込み時と定期的な自動更新
    useEffect(() => {
        fetchReservations(); // 初回読み込み

        // 30秒ごとに自動更新
        const intervalId = setInterval(fetchReservations, 30000); 

        return () => clearInterval(intervalId); // クリーンアップ
    }, []);


    async function handleCall() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/compute-call`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    availableCount: Number(availableCount),
                    apiSecret: process.env.REACT_APP_API_SECRET,
                    callGroup: callGroup,
                })
            });

            if (!response.ok) {
                throw new Error(`API呼び出しに失敗しました: ${response.status}`);
            }

            const data = await response.json();
            if (data.called && data.called.length > 0) {
                alert('以下の番号を呼び出しました: ' + data.called.join(', '));
                fetchReservations(); // 呼び出し後、一覧を更新
            } else {
                alert('呼び出せるグループがありませんでした。');
            }
        } catch (error) {
            console.error('呼出エラー:', error);
            alert('呼出処理中にエラーが発生しました。コンソールを確認してください。');
        }
    }

    // 🚨 関数: 予約の状態を強制的に変更する（呼出 / 受取済）
    const updateReservationStatus = async (id, newStatus) => {
        const newStatusText = newStatus === 'called' ? '呼び出し中' : '受取済み';
        if (!window.confirm(`番号 ${id} のステータスを「${newStatusText}」に変更しますか？`)) return;

        try {
            // 🚨 サーバー側の /api/update-status APIを呼び出すと仮定
            const response = await fetch(`${API_BASE_URL}/api/update-status`, { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    reservationId: id, 
                    newStatus: newStatus,
                    apiSecret: process.env.REACT_APP_API_SECRET, // 管理者権限の認証
                }),
            });
            
            if (!response.ok) {
                throw new Error(`ステータス更新に失敗しました: ${response.status}`);
            }
            
            alert('ステータスが更新されました。');
            fetchReservations(); // 更新後、一覧をリフレッシュ

        } catch (error) {
            console.error('ステータス更新エラー:', error);
            alert('ステータス更新中にエラーが発生しました。サーバー側のエンドポイント実装を確認してください。');
        }
    };
    
    // 🚨 関数: 予約を削除する
    const deleteReservation = async (id, number) => {
        if (!window.confirm(`番号 ${number} の予約を完全に削除しますか？`)) return;

        try {
            // 🚨 サーバー側の DELETE /api/reservations/:id APIを呼び出すと仮定
            const response = await fetch(`${API_BASE_URL}/api/reservations/${id}`, { 
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    apiSecret: process.env.REACT_APP_API_SECRET, // 管理者権限の認証
                }),
            });
            
            if (!response.ok) {
                throw new Error(`削除に失敗しました: ${response.status}`);
            }
            
            alert(`番号 ${number} が削除されました。`);
            fetchReservations(); // 更新後、一覧をリフレッシュ

        } catch (error) {
            console.error('削除エラー:', error);
            alert('削除処理中にエラーが発生しました。サーバー側のエンドポイント実装を確認してください。');
        }
    };


    return (
        <div style={{ padding: '20px', maxWidth: '800px', margin: 'auto' }}>
            <h1>管理者画面</h1>
            
            {/* 呼び出しコントロール */}
            <div style={{ padding: '15px', border: '1px solid #ccc', borderRadius: '5px', marginBottom: '20px', backgroundColor: '#f9f9f9' }}>
                <h2>呼出コントロール</h2>
                
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
                        </select>
                    </label>
                </div>
                
                <div style={{ marginBottom: '10px' }}>
                    <label>
                        完成個数（空き人数）：
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
                    onClick={handleCall}
                    style={{ padding: '10px 20px', backgroundColor: '#007BFF', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px' }}
                    disabled={isLoading}
                >
                    呼出実行
                </button>
            </div>
            
            {/* 予約一覧表 */}
            <hr />
            <h2>予約一覧 ({reservations.length} 件)</h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', fontSize: '14px' }}>
                <span>最終更新: {lastFetchTime ? lastFetchTime.toLocaleTimeString() : 'N/A'}</span>
                <button 
                    onClick={fetchReservations} 
                    disabled={isLoading}
                    style={{ padding: '5px 10px', cursor: 'pointer', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}
                >
                    {isLoading ? '更新中...' : '手動更新'}
                </button>
            </div>

            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                    <thead>
                        <tr style={{ backgroundColor: '#eee' }}>
                            <th style={{ border: '1px solid #ccc', padding: '8px' }}>番号</th>
                            <th style={{ border: '1px solid #ccc', padding: '8px' }}>団体</th>
                            <th style={{ border: '1px solid #ccc', padding: '8px' }}>人数</th>
                            <th style={{ border: '1px solid #ccc', padding: '8px' }}>名前</th>
                            <th style={{ border: '1px solid #ccc', padding: '8px' }}>LINE</th>
                            <th style={{ border: '1px solid #ccc', padding: '8px', minWidth: '150px' }}>状態</th>
                            <th style={{ border: '1px solid #ccc', padding: '8px' }}>登録時刻</th>
                            {/* 🚨 修正: 操作ボタンの列を追加 */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', minWidth: '170px' }}>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {reservations.map((res) => {
                            const status = getReservationStatus(res);
                            const rowColor = getRowColor(status);
                            
                            // Dateオブジェクトを作成。createdAtがTimestamp形式か、Date文字列かによって処理を分ける
                            const createdAtDate = res.createdAt?.seconds 
                                ? new Date(res.createdAt.seconds * 1000)
                                : res.createdAt ? new Date(res.createdAt) : null;
                            const formattedTime = createdAtDate ? createdAtDate.toLocaleTimeString() : 'N/A';
                            
                            return (
                                <tr key={res.id} style={{ backgroundColor: rowColor }}>
                                    <td style={{ border: '1px solid #ccc', padding: '8px', fontWeight: 'bold' }}>{res.number}</td>
                                    <td style={{ border: '1px solid #ccc', padding: '8px' }}>{res.group}</td>
                                    <td style={{ border: '1px solid #ccc', padding: '8px' }}>{res.people}</td>
                                    <td style={{ border: '1px solid #ccc', padding: '8px' }}>{res.name}</td>
                                    <td style={{ border: '1px solid #ccc', padding: '8px', textAlign: 'center' }}>{res.wantsLine ? (res.lineUserId ? '✅' : '待機') : '❌'}</td>
                                    <td style={{ border: '1px solid #ccc', padding: '8px', fontWeight: 'bold' }}>{status}</td>
                                    <td style={{ border: '1px solid #ccc', padding: '8px' }}>{formattedTime}</td>
                                    
                                    {/* 🚨 修正: 操作ボタンを追加 */}
                                    <td style={{ border: '1px solid #ccc', padding: '4px', whiteSpace: 'nowrap' }}>
                                        {/* 呼び出しボタン */}
                                        <button 
                                            onClick={() => updateReservationStatus(res.id, 'called')} 
                                            // 既に呼び出されているか、受け取り済みの場合は無効化
                                            disabled={status.includes('呼び出し中') || res.status === 'seatEnter'} 
                                            style={{ 
                                                marginRight: '5px', 
                                                padding: '4px 8px', 
                                                backgroundColor: '#ffc107', // 黄色
                                                color: 'black', 
                                                border: 'none', 
                                                cursor: 'pointer', 
                                                borderRadius: '3px' 
                                            }}
                                        >
                                            呼出
                                        </button>
                                        
                                        {/* 受取済みボタン */}
                                        <button 
                                            onClick={() => updateReservationStatus(res.id, 'seatEnter')} 
                                            disabled={res.status === 'seatEnter'} 
                                            style={{ 
                                                marginRight: '5px', 
                                                padding: '4px 8px', 
                                                backgroundColor: '#28a745', // 緑
                                                color: 'white', 
                                                border: 'none', 
                                                cursor: 'pointer', 
                                                borderRadius: '3px' 
                                            }}
                                        >
                                            受取済
                                        </button>
                                        
                                        {/* 削除ボタン */}
                                        <button 
                                            onClick={() => deleteReservation(res.id, res.number)} 
                                            style={{ 
                                                padding: '4px 8px', 
                                                backgroundColor: '#dc3545', // 赤
                                                color: 'white', 
                                                border: 'none', 
                                                cursor: 'pointer', 
                                                borderRadius: '3px' 
                                            }}
                                        >
                                            削除
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            
            {reservations.length === 0 && !isLoading && <p style={{ textAlign: 'center', marginTop: '20px' }}>予約はありません。</p>}
            
            <hr style={{ marginTop: '20px' }}/>
            <div style={{ fontSize: '12px', padding: '10px', backgroundColor: '#eee', borderRadius: '4px' }}>
                **状態凡例**:
                <ul>
                    <li>**待機中 (未呼出)**: まだ呼び出し実行されていない予約です。</li>
                    <li>**呼び出し中**: 呼び出し済みで、かつ呼び出しから10分未満の予約です。</li>
                    <li>**🚨 呼び出し期限切れ (10分経過)**: 呼び出し済みで、10分以上経過した予約です。</li>
                    <li>**受け取り済み**: 席に着いた（商品を受け取った）と記録された予約です。</li>
                </ul>
                <p>※一覧は30秒ごとに自動更新されます。</p>
            </div>

        </div>
    );
}
