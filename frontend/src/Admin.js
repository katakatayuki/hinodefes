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

// 🚨 【追加】ソート順を定義するヘルパー関数 (②のプログラム)
// 優先度が高いほど小さい番号を返す
const getSortPriority = (reservation) => {
    const statusText = getReservationStatus(reservation);

    if (statusText === '呼び出し中') {
        return 1; // 呼び出し中
    }
    if (statusText === '🚨 呼び出し期限切れ (10分経過)') {
        return 2; // 呼び出し中（10分以上経過）
    }
    if (statusText === '待機中 (未呼出)') {
        return 3; // 未呼び出し
    }
    // 受け取り済み、その他は最後に
    return 4;
};


// 🚨 修正: reservations をソートする関数 (②のプログラム)
const sortReservations = (resList) => {
    return [...resList].sort((a, b) => {
        // 1. ステータスによるソート (優先度 1 < 2 < 3 < 4)
        const priorityA = getSortPriority(a);
        const priorityB = getSortPriority(b);

        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }

        // 2. ステータスが同じ場合、番号 (number) が小さい順 (早く予約した順)
        return a.number - b.number;
    });
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
    // 🚨 追加: 予約一覧の状態 (既存)
    const [reservations, setReservations] = useState([]);
    // 🚨 追加: ローディング状態 (既存)
    const [isLoading, setIsLoading] = useState(false);
    // 🚨 追加: 最終更新時刻 (UIでリフレッシュ時刻を示すため) (既存)
    const [lastFetchTime, setLastFetchTime] = useState(null);
    
    // 🚨 【追加】apiSecretとmessageの状態 (①のプログラム)
    const [apiSecret, setApiSecret] = useState('');
    const [message, setMessage] = useState('');
    
    // 🚨 【追加】検索とフィルタリング用の状態 (①のプログラム)
    const [searchTerm, setSearchTerm] = useState('');
    const [showReceived, setShowReceived] = useState(false); // 受け取り済み（会計済み）を表示するかどうか

    // 🚨 関数: 予約一覧を取得 (既存)
    const fetchReservations = async () => {
        setIsLoading(true);
        try {
            // 🚨 修正: 予約一覧取得時にも Authorization ヘッダーを付けて認証情報を渡す
            const response = await fetch(`${API_BASE_URL}/api/reservations`, {
                headers: {
                    'Authorization': `Bearer ${process.env.REACT_APP_API_SECRET}` // API Secretをヘッダーに設定
                }
            });

            if (!response.ok) {
                // サーバー側で認証が失敗した場合、ステータスは403になる
                throw new Error(`予約一覧の取得に失敗しました: ${response.status} ${response.statusText || ''}`);
            }
            const data = await response.json();

            // createdAtでソート (サーバー側で降順に取得しているが、念のため) (既存のソートを削除/変更しない)
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
            // 403エラーの場合、認証設定を確認するよう促すメッセージを追加
            if (error.message.includes('403')) {
                alert('予約一覧の取得中にエラーが発生しました。認証エラー (403 Forbidden) の可能性があります。サーバー側のAPI Secret設定と認証ロジックを確認してください。');
            } else {
                alert('予約一覧の取得中にエラーが発生しました。コンソールを確認してください。');
            }
        } finally {
            setIsLoading(false);
        }
    };

    // 🚨 useEffect: ページ読み込み時と定期的な自動更新 (既存)
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

    // 🚨 関数: 予約の状態を強制的に変更する（呼出 / 受取済） (既存)
    const updateReservationStatus = async (id, newStatus) => {
        // NOTE: window.confirm() は非推奨ですが、ここでは既存コードを維持します。
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
            
            // NOTE: alert() は非推奨ですが、ここでは既存コードを維持します。
            alert('ステータスが更新されました。');
            fetchReservations(); // 更新後、一覧をリフレッシュ

        } catch (error) {
            console.error('ステータス更新エラー:', error);
            // NOTE: alert() は非推奨ですが、ここでは既存コードを維持します。
            alert('ステータス更新中にエラーが発生しました。サーバー側のエンドポイント実装を確認してください。');
        }
    };
    
    // 🚨 関数: 予約を削除する (既存)
    const deleteReservation = async (id, number) => {
        // NOTE: window.confirm() は非推奨ですが、ここでは既存コードを維持します。
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
            
            // NOTE: alert() は非推奨ですが、ここでは既存コードを維持します。
            alert(`番号 ${number} が削除されました。`);
            fetchReservations(); // 更新後、一覧をリフレッシュ

        } catch (error) {
            console.error('削除エラー:', error);
            // NOTE: alert() は非推奨ですが、ここでは既存コードを維持します。
            alert('削除処理中にエラーが発生しました。サーバー側のエンドポイント実装を確認してください。');
        }
    };

    // 🚨 【追加】フィルタリング・ソートされたリストを計算 (③のプログラム)
    const filteredAndSortedReservations = sortReservations(reservations)
        // 1. 会計済み(seatEnter)フィルタリング
        .filter(r => showReceived || r.status !== 'seatEnter')
        // 2. 番号検索フィルタリング
        .filter(r => 
            searchTerm === '' || String(r.number).includes(searchTerm)
        );
    
    // 🚨 【追加】注文内容を整形するヘルパー関数 (④のプログラムより抽出)
    const formatOrder = (order) => {
        if (!order || Object.keys(order).length === 0) return 'なし';
        return Object.entries(order)
            .filter(([, count]) => count > 0)
            .map(([item, count]) => `${item}:${count}`)
            .join(' / ');
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
            <h2>予約一覧 ({filteredAndSortedReservations.length} 件 / 全{reservations.length}件)</h2> {/* 🚨 修正: 件数を filteredAndSortedReservations.length に変更し、全件数を追加 */}
            
            {/* 🚨 【追加】検索とフィルタリングUI (④のプログラム) */}
            <div style={{ marginBottom: '20px', display: 'flex', gap: '20px', alignItems: 'center' }}>
                {/* 番号検索入力欄 */}
                <div style={{ flexGrow: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>
                        会計番号で検索:
                    </label>
                    <input
                        type="text"
                        placeholder="番号を入力..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ padding: '8px', border: '1px solid #ccc', borderRadius: '4px', width: '100%', maxWidth: '300px' }}
                    />
                </div>

                {/* 会計済み表示トグルボタン */}
                <div style={{ flexShrink: 0 }}>
                    <button
                        onClick={() => setShowReceived(prev => !prev)}
                        style={{
                            padding: '10px 15px',
                            backgroundColor: showReceived ? '#007bff' : '#6c757d', // 青 (表示中) / 灰色 (非表示中)
                            color: 'white',
                            border: 'none',
                            cursor: 'pointer',
                            borderRadius: '4px',
                            fontWeight: 'bold'
                        }}
                    >
                        {showReceived ? '✅ 受け取り済みを表示中' : '❌ 受け取り済みを非表示中'}
                    </button>
                </div>
            </div>
            {/* 🚨 【追加終わり】 */}
            
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
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', tableLayout: 'fixed' }}> {/* 🚨 修正: tableLayout: 'fixed' を追加 */}
                    <thead>
                        <tr style={{ backgroundColor: '#eee' }}>
                            <th style={{ border: '1px solid #ccc', padding: '8px', width: '60px' }}>番号</th> {/* 🚨 修正: widthを追加 */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', width: '50px' }}>団体</th> {/* 🚨 修正: widthを追加 */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', width: '50px' }}>人数</th> {/* 🚨 修正: widthを変更 */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', width: '100px' }}>名前</th> {/* 🚨 修正: widthを変更 */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', minWidth: '180px' }}>注文内容 🚨</th> {/* 🚨 修正: 注文内容カラムを追加 (④のプログラム) */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', width: '50px' }}>LINE</th> {/* 🚨 修正: widthを追加 (元のコードのLINE) */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', minWidth: '150px' }}>状態</th>
                            <th style={{ border: '1px solid #ccc', padding: '8px', minWidth: '80px' }}>登録時刻</th> {/* 🚨 修正: widthを小さく (元のコードの登録時刻) */}
                            {/* 🚨 修正: 操作ボタンの列を追加 */}
                            <th style={{ border: '1px solid #ccc', padding: '8px', minWidth: '170px' }}>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* 🚨 修正: ループ対象を filteredAndSortedReservations に変更 */}
                        {filteredAndSortedReservations.map((res) => {
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
                                    
                                    {/* 🚨 【追加】注文内容のセル (④のプログラム) */}
                                    <td style={{ border: '1px solid #ccc', padding: '8px', fontSize: '12px', whiteSpace: 'normal' }}>
                                        {formatOrder(res.order)}
                                    </td>
                                    
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
            
            {/* 🚨 修正: 条件を filteredAndSortedReservations.length === 0 に変更 */}
            {filteredAndSortedReservations.length === 0 && !isLoading && <p style={{ textAlign: 'center', marginTop: '20px' }}>予約はありません。</p>}
            
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
