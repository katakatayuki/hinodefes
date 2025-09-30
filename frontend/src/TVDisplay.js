import React, { useEffect, useState, useCallback, useMemo } from 'react';

// APIのベースURLは、通常はデプロイ環境に応じて相対パスを使用します
const API_BASE_URL = '/api'; 

// ステータスを日本語名に変換するヘルパー
const STATUS_MAP = {
    'waiting': '待機中',
    'called': '呼び出し中',
    'seatEnter': '着席済み',
    'missed': '呼出期限切れ' // 10分ルールで追加
};

// 予約リストのアイテムコンポーネント
const ReservationItem = ({ reservation }) => {
    const statusClass = `status-${reservation.status}`;
    const statusText = STATUS_MAP[reservation.status] || reservation.status;

    // ステータスに応じた文字色を設定
    let textColor = 'text-gray-800';
    if (reservation.status === 'called') textColor = 'text-red-700';
    if (reservation.status === 'seatEnter') textColor = 'text-green-700';
    if (reservation.status === 'missed') textColor = 'text-red-900';

    return (
        <div className={`list-item flex justify-between items-center ${statusClass} shadow-sm`}>
            {/* 番号 */}
            <div className="flex-shrink-0 w-1/4 text-xl lg:text-2xl font-bold">
                {reservation.number}
            </div>
            
            {/* 氏名と人数 */}
            <div className="flex-grow px-2 text-lg lg:text-xl font-medium truncate">
                {reservation.name}様 ({reservation.people}名)
            </div>

            {/* ステータス */}
            <div className="flex-shrink-0 w-1/4 text-center">
                <span className={`text-base font-semibold ${textColor}`}>{statusText}</span>
            </div>
        </div>
    );
};

// メインコンポーネント
export default function TVDisplay() {
    // 呼び出し中の番号リスト
    const [calledNumbers, setCalledNumbers] = useState([]);
    // 待ち状況サマリー (単一の合計のみ)
    const [waitingSummary, setWaitingSummary] = useState({ groups: 0, people: 0 });
    // 予約リスト
    const [reservationList, setReservationList] = useState([]);
    const [loading, setLoading] = useState(true);

    // ==========================================================
    // データフェッチ関数
    // ==========================================================

    const fetchAllData = useCallback(async () => {
        setLoading(true);
        
        // 1. 待ち状況サマリーを取得
        try {
            const res = await fetch(`${API_BASE_URL}/waiting-summary`);
            if (res.ok) {
                const summary = await res.json();
                // サーバー側で単一のサマリーに簡素化されていることを前提とする
                setWaitingSummary(summary);
            }
        } catch (error) {
            console.error('待ち状況サマリーの取得エラー:', error);
        }

        // 2. 呼び出し中番号と予約リストを取得
        try {
            const response = await fetch(`${API_BASE_URL}/tv-status`);
            const data = await response.json();
            
            // calledNumbersとreservationListを更新
            setCalledNumbers(data.currentCalled || []);
            setReservationList(data.reservations || []);
        } catch (error) {
            console.error('TV表示データの取得エラー:', error);
        }

        setLoading(false);
    }, []);


    useEffect(() => {
        // 初回実行
        fetchAllData();
        
        // 5秒ごとにAPIをポーリングして最新の情報を取得
        const id = setInterval(() => {
            fetchAllData(); 
        }, 5000);

        // クリーンアップ
        return () => clearInterval(id);
    }, [fetchAllData]);

    // ==========================================================
    // JSXレンダリング
    // ==========================================================

    const CalledNumbersDisplay = useMemo(() => {
        if (loading && calledNumbers.length === 0) {
            return <div className="text-4xl lg:text-5xl text-gray-400">データを読み込み中...</div>;
        }

        if (calledNumbers.length === 0) {
            return <div className="text-4xl lg:text-5xl text-gray-400">現在、呼び出し中の番号はありません</div>;
        }

        return calledNumbers.map((number, index) => (
            <div 
                key={index} 
                className="called-number text-red-600 border-8 border-transparent rounded-2xl p-6 lg:p-10 bg-red-50 w-full max-w-lg mx-auto"
            >
                {number}
            </div>
        ));
    }, [calledNumbers, loading]);


    return (
        // TV向けレイアウト (16:9比率を想定し、画面中央に配置)
        <div className="tv-layout w-full h-full p-4 lg:p-8 flex flex-col lg:flex-row gap-4 lg:gap-8 bg-gray-100" style={{
             height: '100vh',
             width: '100vw',
             margin: 'auto',
             fontFamily: "'Inter', 'Noto Sans JP', sans-serif"
        }}>
            
            {/* メイン表示エリア (左側: 呼び出し番号) */}
            <div className="flex-grow lg:w-3/5 bg-white shadow-2xl rounded-xl p-6 lg:p-12 flex flex-col">
                <header className="mb-4 lg:mb-8 text-center border-b-4 border-amber-500 pb-4">
                    <h1 className="text-3xl lg:text-5xl font-extrabold text-gray-800">
                        受付へお戻りください
                    </h1>
                    <p className="text-xl lg:text-2xl text-gray-600 mt-2">Ready to Enter / Please Return to Reception</p>
                </header>

                {/* 呼び出し番号表示 */}
                <div id="calledNumbersContainer" className="flex-grow flex flex-col items-center justify-center space-y-4">
                    <div id="calledNumbers" className="text-red-600 text-center space-y-4 w-full">
                        {CalledNumbersDisplay}
                    </div>
                </div>

                {/* 待ち状況サマリー */}
                <div className="mt-auto border-t pt-4">
                    <h3 className="text-xl font-bold text-gray-700 mb-2">現在の待ち状況 (全体)</h3>
                    <div id="waitingSummaryDisplay" className="flex justify-around items-center bg-blue-100 p-4 rounded-lg shadow-md">
                        <p className="text-2xl font-bold text-blue-800">
                            <span className="text-4xl mr-1">{waitingSummary.groups}</span> 組
                        </p>
                        <p className="text-2xl font-bold text-blue-800">
                            合計 <span className="text-4xl mr-1">{waitingSummary.people}</span> 人待ち
                        </p>
                    </div>
                </div>
            </div>

            {/* サブ情報エリア (右側: 予約リスト) */}
            <div className="lg:w-2/5 flex flex-col bg-white shadow-lg rounded-xl p-4 lg:p-6 overflow-hidden">
                <h3 className="text-2xl font-extrabold text-gray-800 mb-4 border-b pb-2">現在の予約リスト</h3>
                <div id="reservationList" className="flex-grow overflow-y-auto space-y-2 pr-2">
                    {reservationList.length > 0 ? (
                        reservationList.map((r) => (
                            <ReservationItem key={r.id} reservation={r} />
                        ))
                    ) : (
                        <p className="text-gray-500 mt-4">現在の予約はありません。</p>
                    )}
                </div>
            </div>

            {/* カスタムCSSスタイルをインラインで追加 */}
            <style jsx global>{`
                /* 呼び出し番号を強調 */
                .called-number {
                    font-size: 8vw; /* ビューポート幅に対する相対サイズ */
                    font-weight: 900;
                    line-height: 1;
                    text-shadow: 4px 4px 8px rgba(0, 0, 0, 0.2);
                    animation: pulse-border 1.5s infinite;
                }
                /* アニメーション */
                @keyframes pulse-border {
                    0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 102, 0, 0.7); }
                    70% { transform: scale(1.02); box-shadow: 0 0 0 20px rgba(255, 102, 0, 0); }
                    100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 102, 0, 0); }
                }
                /* 待ち状況のリストアイテムのスタイル */
                .list-item {
                    padding: 8px 12px;
                    margin-bottom: 4px;
                    border-radius: 8px;
                    transition: all 0.3s ease;
                    font-size: 0.9rem; /* 小さめの画面でも収まるように */
                }
                /* ステータス別の色分け (tv.htmlから移植) */
                .status-waiting { background-color: #fef08a; } /* amber-200 */
                .status-called { background-color: #fecaca; } /* red-200 */
                .status-seatEnter { background-color: #a7f3d0; } /* emerald-200 */
                .status-missed { background-color: #d1d5db; color: #6b7280; text-decoration: line-through; } /* gray-300 */
            `}</style>
        </div>
    );
}
