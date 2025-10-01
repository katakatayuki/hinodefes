import React, { useState, useCallback } from 'react';

// 🚨 【要変更】あなたのRenderサーバーのURLに置き換えてください
const SERVER_URL = "https://hinodefes.onrender.com"; 
// 🚨 【要変更】LINE友だち追加QRコード画像のURLに置き換えてください
const LINE_QR_CODE_URL = 'https://placehold.co/250x250/000000/FFFFFF?text=LINE+QR+CODE'; 

// 注文可能なアイテムリスト
const ORDER_ITEMS = {
    '肉まん': 'pork_bun',
    'ピザまん': 'pizza_bun',
    'あんまん': 'red_bean_bun',
    'チョコまん': 'chocolate_bun',
    '烏龍茶': 'oolong_tea',
};

// モーダルを管理するためのコンポーネント
const CustomModal = ({ title, message, children, onClose }) => {
    return (
        <div 
            style={{ 
                position: 'fixed', 
                top: 0, 
                left: 0, 
                width: '100%', 
                height: '100%', 
                backgroundColor: 'rgba(0, 0, 0, 0.5)', 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                zIndex: 1000 
            }}
        >
            <div 
                style={{ 
                    backgroundColor: 'white', 
                    padding: '30px', 
                    borderRadius: '10px', 
                    maxWidth: '90%', 
                    width: '350px', 
                    boxShadow: '0 4px 10px rgba(0, 0, 0, 0.2)',
                    textAlign: 'center'
                }}
            >
                <h2 style={{ borderBottom: '2px solid #ccc', paddingBottom: '10px' }}>{title}</h2>
                <p style={{ margin: '20px 0' }}>{message}</p>
                {children}
                <button
                    onClick={onClose}
                    style={{ 
                        padding: '10px 20px', 
                        backgroundColor: '#007BFF', 
                        color: 'white', 
                        border: 'none', 
                        borderRadius: '4px', 
                        cursor: 'pointer', 
                        marginTop: '20px',
                        width: '100%'
                    }}
                >
                    閉じる
                </button>
            </div>
        </div>
    );
};


export default function Reception() {
    const [name, setName] = useState('');
    const [people, setPeople] = useState(1);
    const [wantsLine, setWantsLine] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    
    // 🚨 修正: ローカルストレージを使って初期値を設定
    const [group, setGroup] = useState(() => {
        const savedGroup = localStorage.getItem('lastGroup');
        return savedGroup || '5-5'; // 読み込めない場合は '5-5' を初期値とする
    });
    const [isGroupLocked, setIsGroupLocked] = useState(true);

    // 予約が成功し、QRコードを表示すべきか
    const [isReserved, setIsReserved] = useState(false);
    const [reservedNumber, setReservedNumber] = useState(null);

    // 🚨 【追加】商品注文の項目と状態 (キーは日本語名、値は数量)
    const [orders, setOrders] = useState(() => {
        const initialOrders = {};
        Object.keys(ORDER_ITEMS).forEach(item => {
            initialOrders[item] = 0;
        });
        return initialOrders;
    });

    const handleOrderChange = useCallback((item, count) => {
        // 0未満にならないように制限
        const newCount = Math.max(0, parseInt(count) || 0);  
        setOrders(prev => ({
            ...prev,
            [item]: newCount
        }));
    }, []);

    // 団体変更時にローカルストレージに保存するハンドラ
    const handleGroupChange = useCallback((newGroup) => {
        setGroup(newGroup);
        localStorage.setItem('lastGroup', newGroup);
    }, []);

    const resetForm = useCallback(() => {
        setName('');
        setPeople(1);
        setWantsLine(false);
        setOrders(() => {
            const initialOrders = {};
            Object.keys(ORDER_ITEMS).forEach(item => {
                initialOrders[item] = 0;
            });
            return initialOrders;
        });
    }, []);

    const closeModal = useCallback(() => {
        setIsReserved(false);
        setReservedNumber(null);
        setError(null);
    }, []);


    async function handleSubmit(e) {
        e.preventDefault();
        setIsLoading(true); 
        setError(null);
        setIsReserved(false); 
        setReservedNumber(null);

        // 注文が一つもされていないかチェック (今回はチェックなしで0個注文も許容)
        // const totalItems = Object.values(orders).reduce((sum, count) => sum + count, 0);

        try {
            const payload = {
                group: group,
                name: name,
                people: parseInt(people),
                wantsLine: wantsLine,
                // lineUserId は、フロント側で保持せず、LINEメッセージが来た時にサーバー側で紐付ける方式を採用
                lineUserId: null, 
                order: orders, // 🚨 order をペイロードに追加
            };

            const response = await fetch(`${SERVER_URL}/api/reservations`, { // 🚨 サーバー側のルート名に合わせて修正
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`API登録に失敗しました: ${response.statusText}. 詳細: ${errorBody}`);
            }

            const result = await response.json();
            const number = result.number; // サーバーから連番（数値）が返ってくる

            resetForm();
            
            // 予約成功後の処理
            setReservedNumber(number);
            setIsReserved(true);

        } catch (error) {
            console.error(error);
            setError('登録処理中にエラーが発生しました。サーバーまたはネットワークを確認してください。');
        } finally {
            setIsLoading(false);
        }
    }

    // 予約完了後のQRコード表示画面 or 予約完了メッセージ
    if (isReserved && reservedNumber !== null) {
        const totalItems = Object.values(orders).reduce((sum, count) => sum + count, 0);
        
        return (
            <CustomModal 
                title="登録完了！"
                message={`受付番号は【${reservedNumber}】番です。`}
                onClose={closeModal}
            >
                <div style={{ textAlign: 'left', border: '1px solid #ddd', padding: '15px', borderRadius: '4px', marginBottom: '20px', backgroundColor: '#f9f9f9' }}>
                    <h4 style={{ margin: '0 0 10px 0', color: '#333' }}>ご注文内容:</h4>
                    {totalItems > 0 ? (
                        Object.entries(orders).filter(([, count]) => count > 0).map(([item, count]) => (
                            <p key={item} style={{ margin: '5px 0' }}>{item}: {count} 個</p>
                        ))
                    ) : (
                        <p style={{ margin: '5px 0', color: '#999' }}>ご注文はありません</p>
                    )}
                </div>
                {wantsLine && (
                    <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#e6f7ff', border: '1px solid #b3e0ff', borderRadius: '4px' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#007BFF' }}>LINE通知設定</h3>
                        <p style={{ fontSize: '0.9em' }}>準備完了の通知を受け取るため、以下のQRコードをLINEで読み取り、**友だち追加**してください。</p>
                        <img 
                            src={LINE_QR_CODE_URL} 
                            alt="LINE友だち追加QRコード" 
                            style={{ width: '150px', height: '150px', border: '1px solid #ccc', margin: '15px 0' }} 
                        />
                    </div>
                )}
            </CustomModal>
        );
    }
    
    // エラーモーダル
    if (error) {
        return (
            <CustomModal 
                title="エラー"
                message={error}
                onClose={closeModal}
            />
        );
    }

    // 通常の受付フォーム
    return (
        <div style={{ padding: '20px', maxWidth: '450px', margin: 'auto' }}>
            <h1 style={{ textAlign: 'center', color: '#333' }}>受付フォーム</h1>
            {isLoading && (
                <div style={{ textAlign: 'center', padding: '15px', backgroundColor: '#fffbe6', border: '1px solid #ffe58f', borderRadius: '4px', marginBottom: '20px' }}>
                    登録中...
                </div>
            )}
            <form onSubmit={handleSubmit} style={{ border: '1px solid #ddd', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}>
                
                {/* 団体選択 */}
                <div style={{ marginBottom: '15px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                        <label style={{ flexGrow: 1, color: '#555' }}>
                            団体を選択：
                            <select
                                value={group}
                                onChange={(e) => handleGroupChange(e.target.value)} 
                                required
                                disabled={isGroupLocked || isLoading} 
                                style={{ width: '100%', padding: '10px', boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: '4px', marginTop: '5px', fontSize: '1em' }}
                            >
                                <option value="5-5">団体 5-5</option>
                                <option value="5-2">団体 5-2</option>
                            </select>
                        </label>
                        <button
                            type="button"
                            onClick={() => setIsGroupLocked(!isGroupLocked)} 
                            disabled={isLoading}
                            style={{
                                padding: '10px 12px',
                                cursor: 'pointer',
                                backgroundColor: isGroupLocked ? '#f44336' : '#4CAF50', 
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                marginTop: '28px', 
                                whiteSpace: 'nowrap',
                                transition: 'background-color 0.3s'
                            }}
                        >
                            {isGroupLocked ? '🔓 ロック解除' : '🔒 ロック中'}
                        </button>
                    </div>
                </div>
                
                {/* 名前 */}
                <div style={{ marginBottom: '15px' }}>
                    <label style={{ display: 'block', color: '#555' }}>
                        代表者名：
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            disabled={isLoading}
                            style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px', marginTop: '5px', fontSize: '1em' }}
                        />
                    </label>
                </div>
                
                {/* 人数 */}
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', color: '#555' }}>
                        人数：
                        <input
                            type="number"
                            value={people}
                            min={1}
                            onChange={(e) => setPeople(e.target.value)}
                            required
                            disabled={isLoading}
                            style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px', marginTop: '5px', fontSize: '1em' }}
                        />
                    </label>
                </div>

                {/* 🚨 商品注文セクション */}
                <div style={{ marginBottom: '25px', padding: '15px', border: '1px solid #e0e0e0', borderRadius: '4px', backgroundColor: '#f7f7f7' }}>
                    <h3 style={{ marginTop: '0', color: '#333', borderBottom: '1px dashed #ccc', paddingBottom: '10px', marginBottom: '15px' }}>ご注文</h3>
                    {Object.keys(ORDER_ITEMS).map((item) => (
                        <div key={item} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                            <label style={{ color: '#555', flexGrow: 1 }}>{item}</label>
                            <input
                                type="number"
                                value={orders[item]}
                                min={0}
                                onChange={(e) => handleOrderChange(item, e.target.value)}
                                disabled={isLoading}
                                style={{ width: '80px', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', textAlign: 'center' }}
                            />
                        </div>
                    ))}
                </div>
                
                {/* LINE通知希望 */}
                <div style={{ marginBottom: '25px', textAlign: 'center' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', fontSize: '1.1em', color: '#007BFF', fontWeight: 'bold' }}>
                        <input
                            type="checkbox"
                            checked={wantsLine}
                            onChange={(e) => setWantsLine(e.target.checked)}
                            disabled={isLoading}
                            style={{ marginRight: '10px', width: '20px', height: '20px' }}
                        />
                        LINEで通知希望
                    </label>
                </div>
                
                {/* 登録ボタン */}
                <button
                    type="submit"
                    disabled={isLoading}
                    style={{ 
                        padding: '12px 20px', 
                        backgroundColor: isLoading ? '#ccc' : '#4CAF50', 
                        color: 'white', 
                        border: 'none', 
                        cursor: isLoading ? 'not-allowed' : 'pointer', 
                        borderRadius: '4px', 
                        width: '100%',
                        fontSize: '1.2em',
                        fontWeight: 'bold',
                        transition: 'background-color 0.3s'
                    }}
                >
                    {isLoading ? '登録中...' : '受付を登録する'}
                </button>
            </form>
        </div>
    );
}
