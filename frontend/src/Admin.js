/* global __firebase_config */
import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
// getDocs, collection, query, where, orderBy はAdmin.jsx内で使用されていないため削除
import { getFirestore, doc, updateDoc, deleteDoc } from 'firebase/firestore'; 

// RenderのAPIベースURLは、環境に合わせて絶対パスを使用するように修正します
// 相対パスの'/api'をfetchが処理できない環境があるため、window.location.originを付加します。
const API_BASE_URL = window.location.origin + '/api'; 

// 🚨 サーバーサイドの秘密鍵はクライアントサイドに露出させてはいけないため、
// 実際にはAPI側で認証を行う必要があります。ここではダミーのAPI_SECRETを使用しますが、
// サーバー側でトークン/セッション認証に切り替えることを強く推奨します。
const API_SECRET = 'dummy-secret';

// Firebaseの設定をグローバル変数から取得し、初期化を試みる
let app = null;
let db = null;

try {
    const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
    
    // projectIdが存在する場合のみinitializeAppを呼び出すことで、クラッシュを防ぎます
    if (firebaseConfig && firebaseConfig.projectId) {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
    } else {
        console.error("Firebase Initialization Failed: 'projectId' not found in configuration. Firestore features (status change, delete) will not work.");
    }
} catch (e) {
    console.error("Error processing Firebase config:", e);
}


// ステータスを日本語名に変換するヘルパー
const STATUS_MAP = {
    'waiting': '待機中',
    'called': '呼び出し中',
    'seatEnter': '着席済み',
    'missed': '呼出期限切れ',
};

// 予約リストの行コンポーネント
const ReservationRow = ({ reservation, changeStatus, deleteReservation }) => {
    // 状態に基づいたスタイルとテキスト
    const statusText = STATUS_MAP[reservation.status] || reservation.status;
    let statusColor = 'text-gray-500';
    if (reservation.status === 'waiting') statusColor = 'text-amber-600 font-bold';
    if (reservation.status === 'called') statusColor = 'text-red-600 font-bold';
    if (reservation.status === 'seatEnter') statusColor = 'text-green-600 font-bold';
    if (reservation.status === 'missed') statusColor = 'text-gray-400 font-medium line-through'; // 期限切れ

    const formattedDate = reservation.createdAt 
        ? new Date(reservation.createdAt.seconds * 1000).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : 'N/A';

    return (
        <tr className="hover:bg-gray-50 transition duration-100">
            <td className="px-3 py-3 whitespace-nowrap text-lg font-bold">{reservation.number}</td>
            {/* 団体カラムは残すが、値はN/AまたはFirestoreの値を使用 */}
            <td className="px-3 py-3 whitespace-nowrap text-sm text-gray-900">{reservation.group || 'N/A'}</td> 
            <td className="px-3 py-3 whitespace-nowrap text-sm text-gray-900">{reservation.name}</td>
            <td className="px-3 py-3 whitespace-nowrap text-sm text-gray-500">{reservation.people}人</td>
            <td className="px-3 py-3 whitespace-nowrap">
                {reservation.wantsLine ? (reservation.lineUserId ? '✅ 紐付け済' : '🔔 希望') : '❌ 不要'}
            </td>
            <td className="px-3 py-3 whitespace-nowrap text-sm">
                <span className={statusColor}>{statusText}</span>
            </td>
            <td className="px-3 py-3 whitespace-nowrap text-xs text-gray-500">{formattedDate}</td>
            <td className="px-3 py-3 whitespace-nowrap text-right text-sm font-medium">
                <button 
                    onClick={() => changeStatus(reservation.id, 'seatEnter')} 
                    className="text-green-600 hover:text-green-800 mx-1 p-1 rounded hover:bg-green-100 transition"
                    disabled={reservation.status === 'seatEnter'}
                >
                    着席
                </button>
                <button 
                    onClick={() => changeStatus(reservation.id, 'waiting')} 
                    className="text-blue-600 hover:text-blue-800 mx-1 p-1 rounded hover:bg-blue-100 transition"
                    disabled={reservation.status === 'waiting'}
                >
                    待機に戻す
                </button>
                <button 
                    onClick={() => deleteReservation(reservation.id, reservation.number)} 
                    className="text-red-600 hover:text-red-800 mx-1 p-1 rounded hover:bg-red-100 transition"
                >
                    削除
                </button>
            </td>
        </tr>
    );
};

// メインコンポーネント
export default function Admin() {
    const [availablePeople, setAvailablePeople] = useState(1);
    const [computeMessage, setComputeMessage] = useState({ text: '', type: 'info' });
    const [waitingSummary, setWaitingSummary] = useState({ groups: '--', people: '--' });
    const [reservationList, setReservationList] = useState([]);
    const [listLoading, setListLoading] = useState(false);

    // ==========================================================
    // データフェッチ: 待ち状況サマリー
    // ==========================================================
    const fetchWaitingSummary = useCallback(async () => {
        try {
            // サーバー側の実装が全体集計に戻ったと仮定して、waiting-summaryを呼び出す
            const response = await fetch(`${API_BASE_URL}/waiting-summary`);
            if (!response.ok) throw new Error('Failed to fetch summary');
            
            const summary = await response.json();
            
            // 🚨 以前の全体集計の表示ロジックに戻す
            const totalGroups = summary.groups || 0;
            const totalPeople = summary.people || 0;
            
            setWaitingSummary({ groups: totalGroups, people: totalPeople });

        } catch (error) {
            console.error("Error fetching summary:", error);
            setWaitingSummary({ groups: 'エラー', people: 'エラー' });
        }
    }, []);

    // ==========================================================
    // データフェッチ: 全予約リスト
    // ==========================================================
    const fetchReservations = useCallback(async () => {
        setListLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/reservations`);
            if (!response.ok) throw new Error('Failed to fetch reservations');
            
            const reservations = await response.json();
            setReservationList(reservations);

        } catch (error) {
            console.error("Error fetching reservations:", error);
            setReservationList([]);
            // setComputeMessage({ text: '❌ 予約リストの取得に失敗しました。', type: 'error' });
        }
        setListLoading(false);
    }, []);

    // 初回ロードと定期更新
    useEffect(() => {
        fetchWaitingSummary();
        fetchReservations();

        const summaryId = setInterval(fetchWaitingSummary, 5000); // 5秒ごとにサマリー更新
        const listId = setInterval(fetchReservations, 10000); // 10秒ごとにリスト更新

        return () => {
            clearInterval(summaryId);
            clearInterval(listId);
        };
    }, [fetchWaitingSummary, fetchReservations]);

    // ==========================================================
    // 呼び出し実行 (POST /api/compute-call)
    // ==========================================================
    const sendCompute = async () => {
        const availableCount = Number(availablePeople);
        
        if (availableCount <= 0 || isNaN(availableCount)) {
            setComputeMessage({ text: '🚨 空き人数は正の数で入力してください。', type: 'error' });
            return;
        }

        setComputeMessage({ text: `全待機リストから呼び出しを処理中...`, type: 'loading' });

        try {
            const response = await fetch(`${API_BASE_URL}/compute-call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    availableCount: availableCount,
                    apiSecret: API_SECRET
                })
            });

            const result = await response.json();

            if (!response.ok || result.error) {
                throw new Error(result.error || `Server responded with status ${response.status}`);
            }

            if (result.called && result.called.length > 0) {
                setComputeMessage({ 
                    text: `✅ 呼び出し成功: 番号 ${result.called.join(', ')} (合計 ${result.totalNeeded} 人)`, 
                    type: 'success' 
                });
            } else {
                setComputeMessage({ 
                    text: `ℹ️ 待機中の予約がないため、呼び出し対象はいませんでした。`, 
                    type: 'info' 
                });
            }

        } catch (error) {
            console.error('Compute call failed:', error);
            setComputeMessage({ text: `❌ 呼び出し失敗: ${error.message}`, type: 'error' });
        }

        // 成功・失敗に関わらずリストとサマリーを更新
        fetchWaitingSummary();
        fetchReservations();
    };

    // ==========================================================
    // ステータス変更処理 (着席、待機に戻す)
    // ==========================================================
    const changeStatus = async (id, newStatus) => {
        // Firebaseが初期化されていない場合は処理を中断
        if (!db) {
            alert('Firebaseが正しく初期化されていません。設定を確認してください。');
            return;
        }

        const updateData = { status: newStatus };
        if (newStatus === 'seatEnter') {
            updateData.seatEnterAt = new Date();
            updateData.calledAt = null; // 着席したら呼ばれた状態は終了
        } else if (newStatus === 'waiting') {
            updateData.calledAt = null; 
            updateData.seatEnterAt = null;
        }
        
        try {
            const docRef = doc(db, 'reservations', id);
            await updateDoc(docRef, updateData);
            console.log(`Status changed for ${id} to ${newStatus}`);
            // 状態をローカルで更新し、次の定期フェッチで確認
            fetchReservations(); 
            fetchWaitingSummary();
        } catch(e) {
            console.error('Status change failed:', e);
            alert(`ステータス変更失敗: ${e.message}`); // 🚨 本番環境ではカスタムモーダルを使用
        }
    };

    // ==========================================================
    // 予約削除処理
    // ==========================================================
    const deleteReservation = async (id, number) => {
        // Firebaseが初期化されていない場合は処理を中断
        if (!db) {
            alert('Firebaseが正しく初期化されていません。設定を確認してください。');
            return;
        }
        
        // 🚨 本番環境では alert/confirm の代わりにカスタムモーダルを使用
        if (!window.confirm(`本当に予約No.${number}を削除しますか？`)) return; 

        try {
            const docRef = doc(db, 'reservations', id);
            await deleteDoc(docRef);
            console.log(`Reservation ${id} deleted.`);
            
            // 状態をローカルで更新し、次の定期フェッチで確認
            fetchReservations(); 
            fetchWaitingSummary();
        } catch(e) {
            console.error('Deletion failed:', e);
            alert(`削除失敗: ${e.message}`); // 🚨 本番環境ではカスタムモーダルを使用
        }
    };

    // メッセージ表示のスタイル
    const getMessageClass = (type) => {
        switch (type) {
            case 'success':
                return 'mt-4 text-sm font-bold text-green-600';
            case 'error':
                return 'mt-4 text-sm font-bold text-red-600';
            case 'loading':
                return 'mt-4 text-sm text-amber-600';
            case 'info':
            default:
                return 'mt-4 text-sm text-blue-600';
        }
    };

    return (
        <div className="bg-gray-50 p-4 min-h-screen font-sans">
            <div className="max-w-4xl mx-auto">
                <h1 className="text-3xl font-extrabold text-gray-800 mb-6 border-b pb-2">受付・呼び出し管理</h1>

                {/* 待ち状況サマリー (全体) */}
                <div className="bg-blue-50 border-l-4 border-blue-400 p-4 rounded-xl shadow-md mb-8">
                    <h2 className="text-2xl font-bold text-blue-800 mb-2">現在の待ち状況 (全体)</h2>
                    <div className="flex flex-wrap gap-6 text-xl">
                        <p>組数: <span className="font-extrabold text-3xl text-blue-600">{waitingSummary.groups}</span> 組</p>
                        <p>合計人数: <span className="font-extrabold text-3xl text-blue-600">{waitingSummary.people}</span> 人</p>
                    </div>
                </div>

                {/* 呼び出しパネル */}
                <div className="bg-white p-6 rounded-xl shadow-lg mb-8 border-t-4 border-amber-500">
                    <h2 className="text-2xl font-bold text-gray-700 mb-4">次の呼び出し実行 (全待機)</h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                        
                        <div className="w-full md:col-span-2"> 
                            <label htmlFor="availablePeople" className="block text-sm font-medium text-gray-600">空き人数 (席数)</label>
                            <input 
                                type="number" 
                                id="availablePeople" 
                                value={availablePeople} 
                                onChange={(e) => setAvailablePeople(e.target.value)}
                                min="1" 
                                className="mt-1 block w-full border-gray-300 rounded-lg shadow-sm p-2 text-lg focus:ring-amber-500 focus:border-amber-500"
                            />
                        </div>
                        <button 
                            onClick={sendCompute} 
                            className="w-full px-6 py-2 bg-red-600 text-white font-bold rounded-lg shadow-md hover:bg-red-700 transition duration-150 transform hover:scale-105 disabled:opacity-50"
                            disabled={computeMessage.type === 'loading'}
                        >
                            呼び出し実行
                        </button>
                    </div>
                    {computeMessage.text && (
                        <p className={getMessageClass(computeMessage.type)}>
                            {computeMessage.text}
                        </p>
                    )}
                </div>

                {/* 全予約リスト */}
                <div className="bg-white p-6 rounded-xl shadow-lg">
                    <h2 className="text-2xl font-bold text-gray-700 mb-4 flex justify-between items-center">
                        全予約リスト (最新)
                        <button onClick={fetchReservations} className="text-sm text-blue-500 hover:text-blue-700 p-2 rounded-md hover:bg-blue-50 transition">
                            {listLoading ? '🔄 更新中...' : '🔄 リスト更新'}
                        </button>
                    </h2>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">番号</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">団体</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">氏名</th>
                                    <th className-="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">人数</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">LINE通知</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ステータス</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">登録日時</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {listLoading && reservationList.length === 0 ? (
                                    <tr><td colSpan="8" className="text-center py-4 text-gray-500">データを読み込み中...</td></tr>
                                ) : reservationList.length === 0 ? (
                                    <tr><td colSpan="8" className="text-center py-4 text-gray-500">予約データがありません。</td></tr>
                                ) : (
                                    reservationList.map(r => (
                                        <ReservationRow 
                                            key={r.id} 
                                            reservation={r} 
                                            changeStatus={changeStatus} 
                                            deleteReservation={deleteReservation}
                                        />
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

            </div>
        </div>
    );
}
