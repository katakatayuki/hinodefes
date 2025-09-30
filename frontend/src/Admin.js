/* global __firebase_config */
import React, { useState, useEffect, useCallback } from 'react';
import { Loader, Users, Clock, Trash2, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';

// RenderのAPIベースURL。同一オリジンのため相対パスも可能ですが、念のためwindow.location.originを使用
const API_BASE_URL = window.location.origin + '/api'; 

// 🚨 サーバーサイドの秘密鍵はクライアントサイドに露出させてはいけないため、
// 実際にはAPI側で認証を行う必要があります。ここではダミーのAPI_SECRETを使用しますが、
// サーバー側でトークン/セッション認証に切り替えることを強く推奨します。
const API_SECRET = 'dummy-secret';

// --- Component: Custom Modal (alert/confirmの代わり) ---

const CustomModal = ({ title, message, isOpen, onClose, onConfirm, isConfirmation = false, isError = false }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden transform transition-all">
                <div className="p-6">
                    <div className="flex items-center mb-4">
                        {isError ? (
                            <AlertTriangle className="h-6 w-6 text-red-500 mr-3" />
                        ) : isConfirmation ? (
                            <AlertTriangle className="h-6 w-6 text-amber-500 mr-3" />
                        ) : (
                            <CheckCircle className="h-6 w-6 text-blue-500 mr-3" />
                        )}
                        <h3 className="text-xl font-bold text-gray-800">{title}</h3>
                    </div>
                    <p className="text-gray-600 whitespace-pre-wrap border-t pt-4">{message}</p>
                </div>
                <div className="bg-gray-50 px-6 py-4 flex justify-end space-x-3">
                    {isConfirmation && (
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg font-semibold hover:bg-gray-300 transition"
                        >
                            キャンセル
                        </button>
                    )}
                    <button
                        onClick={() => { if (onConfirm) onConfirm(); onClose(); }}
                        className={`px-4 py-2 text-white rounded-lg font-semibold shadow-md transition ${
                            isError || isConfirmation ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                        }`}
                    >
                        {isConfirmation ? '実行' : 'OK'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ステータスを日本語名に変換するヘルパー
const STATUS_MAP = {
    'waiting': '待機中',
    'called': '呼び出し中',
    'seatEnter': '着席済み',
    'missed': '呼出期限切れ',
    'done': '完了'
};

// 予約アイテム行コンポーネント
const ReservationRow = React.memo(({ reservation, changeStatus, deleteReservation }) => {
    const statusText = STATUS_MAP[reservation.status] || reservation.status;
    
    let statusColor = 'bg-gray-200 text-gray-800';
    if (reservation.status === 'called') statusColor = 'bg-red-100 text-red-800 font-bold';
    if (reservation.status === 'waiting') statusColor = 'bg-amber-100 text-amber-800';
    if (reservation.status === 'seatEnter') statusColor = 'bg-green-100 text-green-800';
    if (reservation.status === 'done' || reservation.status === 'missed') statusColor = 'bg-indigo-100 text-indigo-800';

    const formatDate = (timestamp) => {
        if (!timestamp) return '---';
        const date = new Date(timestamp._seconds * 1000);
        return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <tr className="hover:bg-gray-50 transition duration-150">
            <td className="px-3 py-2 whitespace-nowrap text-sm font-medium text-amber-700 border-r">{reservation.number || '---'}</td>
            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">{reservation.group}</td>
            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">{reservation.name}</td>
            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">{reservation.people}人</td>
            <td className="px-3 py-2 whitespace-nowrap">
                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColor}`}>
                    {statusText}
                </span>
            </td>
            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">{formatDate(reservation.createdAt)}</td>
            <td className="px-3 py-2 whitespace-nowrap text-sm font-medium">
                <div className="flex space-x-1">
                    {reservation.status === 'waiting' && (
                        <button
                            onClick={() => changeStatus(reservation.id, 'called')}
                            className="text-white bg-red-600 hover:bg-red-700 px-2 py-1 rounded text-xs font-semibold shadow-sm transition"
                        >
                            呼出
                        </button>
                    )}
                    {reservation.status === 'called' && (
                        <>
                            <button
                                onClick={() => changeStatus(reservation.id, 'seatEnter')}
                                className="text-white bg-green-600 hover:bg-green-700 px-2 py-1 rounded text-xs font-semibold shadow-sm transition"
                            >
                                入場
                            </button>
                            <button
                                onClick={() => changeStatus(reservation.id, 'missed')}
                                className="text-white bg-red-400 hover:bg-red-500 px-2 py-1 rounded text-xs font-semibold transition"
                            >
                                呼出済
                            </button>
                        </>
                    )}
                    {reservation.status === 'seatEnter' && (
                        <button
                            onClick={() => changeStatus(reservation.id, 'done')}
                            className="text-white bg-indigo-600 hover:bg-indigo-700 px-2 py-1 rounded text-xs font-semibold shadow-sm transition"
                        >
                            完了
                        </button>
                    )}
                    <button
                        onClick={() => deleteReservation(reservation.id)}
                        className="text-gray-600 hover:text-red-600 p-1 rounded transition"
                        title="予約を削除"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </td>
        </tr>
    );
});

// --- Main Admin Component ---

export default function Admin() {
    const [reservationList, setReservationList] = useState([]);
    const [summary, setSummary] = useState({ groups: '---', people: '---' });
    const [listLoading, setListLoading] = useState(false);
    const [modal, setModal] = useState({ isOpen: false, title: '', message: '', isConfirmation: false, isError: false, onConfirm: null });

    const openModal = (title, message, isError = false) => setModal({ isOpen: true, title, message, isError, isConfirmation: false, onConfirm: null });
    const openConfirmation = (title, message, onConfirm) => setModal({ isOpen: true, title, message, isError: false, isConfirmation: true, onConfirm });
    const closeModal = () => setModal(prev => ({ ...prev, isOpen: false }));

    // 予約サマリー（待ち組数、人数）を取得する
    const fetchSummary = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/waiting-summary`);
            if (!response.ok) throw new Error('Summary API fetch failed');
            const data = await response.json();
            setSummary({
                groups: data.groups || 0,
                people: data.people || 0,
            });
        } catch (error) {
            console.error("Error fetching summary:", error);
            setSummary({ groups: 'エラー組', people: 'エラー人' });
        }
    }, []);

    // 予約リストを全て取得する
    const fetchReservationList = useCallback(async () => {
        setListLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/reservations`);
            if (!response.ok) throw new Error('Reservations API fetch failed');
            const data = await response.json();
            
            // numberで昇順ソート（API側でソートされていなくてもここで対応）
            const sortedData = data.sort((a, b) => (a.number || 99999) - (b.number || 99999));

            setReservationList(sortedData);
        } catch (error) {
            console.error("Error fetching reservation list:", error);
            openModal("データ取得エラー", `予約リストの取得に失敗しました。\nサーバーのログを確認してください。`, true);
            setReservationList([]);
        } finally {
            setListLoading(false);
        }
    }, [openModal]);

    // 初回ロード時と5秒ごとの自動更新
    useEffect(() => {
        fetchSummary();
        fetchReservationList();
        
        const summaryInterval = setInterval(fetchSummary, 5000);
        const listInterval = setInterval(fetchReservationList, 10000); // リストは10秒ごと

        return () => {
            clearInterval(summaryInterval);
            clearInterval(listInterval);
        };
    }, [fetchSummary, fetchReservationList]);


    // ステータス変更処理 (API経由)
    const changeStatus = useCallback(async (id, newStatus) => {
        // 確認モーダルを表示
        const statusText = STATUS_MAP[newStatus] || newStatus;
        openConfirmation(
            "ステータス変更の確認",
            `予約ID: ${id}\nステータスを「${statusText}」に変更しますか？`,
            async () => {
                try {
                    const response = await fetch(`${API_BASE_URL}/update-status`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-SECRET': API_SECRET, // サーバー側で認証に使用
                        },
                        body: JSON.stringify({ id, status: newStatus }),
                    });

                    if (!response.ok) throw new Error('Status update failed');
                    
                    openModal("成功", `ステータスを「${statusText}」に更新しました。`);
                    fetchSummary();
                    fetchReservationList(); // リストを再取得して更新
                } catch (error) {
                    console.error("Error updating status:", error);
                    openModal("エラー", `ステータス変更に失敗しました。\nエラー: ${error.message}`, true);
                }
            }
        );
    }, [openConfirmation, openModal, fetchSummary, fetchReservationList]);

    // 予約削除処理 (API経由)
    const deleteReservation = useCallback(async (id) => {
        openConfirmation(
            "予約削除の確認",
            `予約ID: ${id}\nこの予約を完全に削除しますか？`,
            async () => {
                try {
                    const response = await fetch(`${API_BASE_URL}/delete-reservation`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-SECRET': API_SECRET, // サーバー側で認証に使用
                        },
                        body: JSON.stringify({ id }),
                    });

                    if (!response.ok) throw new Error('Deletion failed');
                    
                    openModal("成功", "予約を削除しました。");
                    fetchSummary();
                    fetchReservationList(); // リストを再取得して更新
                } catch (error) {
                    console.error("Error deleting reservation:", error);
                    openModal("エラー", `予約の削除に失敗しました。\nエラー: ${error.message}`, true);
                }
            }
        );
    }, [openConfirmation, openModal, fetchSummary, fetchReservationList]);

    return (
        <div className="min-h-screen bg-gray-100 p-4 sm:p-6 lg:p-8 font-sans">
            <h1 className="text-3xl font-extrabold text-gray-900 mb-6 border-b pb-2">管理画面</h1>

            {/* サマリーカード */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                {/* 1. 待ち組数 */}
                <div className="bg-white p-5 rounded-xl shadow-lg border-l-4 border-amber-500">
                    <p className="text-sm font-medium text-gray-500">待ち組数</p>
                    <p className="flex items-center mt-1 text-3xl font-bold text-gray-900">
                        <Clock className="h-6 w-6 text-amber-500 mr-2" />
                        {summary.groups} 組
                    </p>
                </div>
                {/* 2. 待ち人数 */}
                <div className="bg-white p-5 rounded-xl shadow-lg border-l-4 border-blue-500">
                    <p className="text-sm font-medium text-gray-500">待ち人数 (合計)</p>
                    <p className="flex items-center mt-1 text-3xl font-bold text-gray-900">
                        <Users className="h-6 w-6 text-blue-500 mr-2" />
                        {summary.people} 人
                    </p>
                </div>
                 {/* 3. 手動更新ボタン */}
                 <div className="flex items-center justify-center p-5">
                    <button
                        onClick={() => { fetchSummary(); fetchReservationList(); }}
                        className="flex items-center justify-center bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-6 rounded-lg shadow-md transition"
                        disabled={listLoading}
                    >
                        <RefreshCw className={`h-5 w-5 mr-2 ${listLoading ? 'animate-spin' : ''}`} />
                        手動更新
                    </button>
                </div>
            </div>

            {/* 予約リストテーブル */}
            <div className="bg-white rounded-xl shadow-lg overflow-hidden">
                <div className="p-4 bg-gray-50 border-b">
                    <h2 className="text-xl font-bold text-gray-800">全予約リスト</h2>
                </div>
                <div className="overflow-x-auto">
                    <div className="min-w-full inline-block align-middle">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-100">
                                <tr>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">No.</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">団体</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">名前</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">人数</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ステータス</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">登録日時</th>
                                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {listLoading && reservationList.length === 0 ? (
                                    <tr><td colSpan="7" className="text-center py-4 text-gray-500">データを読み込み中...</td></tr>
                                ) : reservationList.length === 0 ? (
                                    <tr><td colSpan="7" className="text-center py-4 text-gray-500">予約データがありません。</td></tr>
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
            <CustomModal 
                title={modal.title} 
                message={modal.message} 
                isOpen={modal.isOpen} 
                onClose={closeModal} 
                onConfirm={modal.onConfirm}
                isConfirmation={modal.isConfirmation}
                isError={modal.isError}
            />
        </div>
    );
}
