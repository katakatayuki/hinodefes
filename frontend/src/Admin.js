import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, updateDoc, deleteDoc } from 'firebase/firestore';

// 🚨 動作している予約フォーム (Reception.js) の情報に基づき、APIのベースURLを絶対パスに修正します。
const API_BASE_URL = 'https://hinodefes.onrender.com/api'; 

// ★★★重要★★★: バックエンドと一致する値に変更してください。
const API_SECRET = 'dummy-secret'; 

// ==========================================================
// Firebase接続設定
// ==========================================================
const FIREBASE_CONFIG_JSON = process.env.REACT_APP_FIREBASE_CONFIG;
let firebaseConfig = null;

try {
    // Canvas実行環境では '__firebase_config' が定義されることを想定しています。
    // eslint-disable-next-line no-undef
    const canvasConfig = typeof __firebase_config !== 'undefined' ? __firebase_config : null;

    if (canvasConfig) {
        // eslint-disable-next-line no-undef
        firebaseConfig = JSON.parse(__firebase_config);
    } else if (FIREBASE_CONFIG_JSON) {
        firebaseConfig = JSON.parse(FIREBASE_CONFIG_JSON);
    }
} catch(e) {
    console.error("Firebase config parsing error:", e);
}

const isConfigValid = firebaseConfig && typeof firebaseConfig === 'object' && firebaseConfig.projectId;
const app = isConfigValid ? initializeApp(firebaseConfig) : null;
const db = app ? getFirestore(app) : null;
const isDbReady = !!db;
// ==========================================================

// 1️⃣ ステータスマップ - グラデーション＆アイコン追加
const STATUS_MAP = {
    'waiting': { 
        text: '待機中', 
        color: 'bg-gradient-to-r from-amber-50 to-amber-100 text-amber-900 border border-amber-200',
        icon: '⏱️'
    },
    'called': { 
        text: '呼び出し中', 
        color: 'bg-gradient-to-r from-red-500 to-rose-600 text-white border border-red-600 shadow-lg shadow-red-200 animate-pulse',
        icon: '🔔'
    },
    'seatEnter': { 
        text: '着席済み', 
        color: 'bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-900 border border-emerald-200',
        icon: '✓'
    },
    'missed': { 
        text: '呼出期限切れ', 
        color: 'bg-gradient-to-r from-gray-50 to-gray-100 text-gray-500 border border-gray-200 line-through',
        icon: '×'
    },
};

// 予約リストの行コンポーネント
const ReservationRow = ({ reservation, changeStatus, deleteReservation }) => {
    
    const statusData = STATUS_MAP[reservation.status] || { text: reservation.status, color: 'bg-gray-200 text-gray-700 border-gray-400', icon: '❓' };
    
    // FireStoreのTimestampオブジェクトをDateに変換する処理を安全に実行
    const timestamp = reservation.createdAt;
    const dateValue = (timestamp && timestamp.seconds) ? new Date(timestamp.seconds * 1000) : null;
    
    const formattedDate = dateValue 
        ? dateValue.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : 'N/A';

    return (
        // 2️⃣ テーブル行 - 予約番号の視覚強化＆ホバー効果
        <tr className="group even:bg-white/70 odd:bg-gray-50/70 hover:bg-gradient-to-r hover:from-blue-50/30 hover:to-indigo-50/30 transition-all duration-200 border-b border-gray-100">
            {/* 予約番号 - グラデーションボックスで強調 */}
            <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white font-bold text-xl shadow-md group-hover:shadow-lg group-hover:scale-105 transition-all duration-200">
                    {reservation.number}
                </div>
            </td>
            {/* 団体名 */}
            <td className="px-6 py-4 whitespace-nowrap text-base text-gray-700">{reservation.group || '-'}</td> 
            {/* 氏名 */}
            <td className="px-6 py-4 whitespace-nowrap text-base font-medium text-gray-900">{reservation.name}</td>
            
            {/* 人数 - アイコン付きバッジ化 */}
            <td className="px-6 py-4 whitespace-nowrap">
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 text-gray-900 font-semibold text-sm">
                    <span className="text-gray-500">👥</span>
                    {reservation.people}
                </div>
            </td>

            {/* LINE通知 - グラデーションバッジ */}
            <td className="px-6 py-4 whitespace-nowrap">
                {reservation.wantsLine ? (
                    reservation.lineUserId 
                    ? <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-green-50 to-emerald-50 text-emerald-700 font-medium text-xs border border-emerald-200">
                        <span className="text-emerald-600">✓</span> 紐付け済
                      </div>
                    : <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-orange-50 to-amber-50 text-amber-700 font-medium text-xs border border-amber-200">
                        <span className="text-amber-600">🔔</span> 通知希望
                      </div>
                ) : (
                    <span className="text-gray-400 text-sm">—</span>
                )}
            </td>
            
            {/* ステータス - アイコン＆グラデーション */}
            <td className="px-6 py-4 whitespace-nowrap">
                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold ${statusData.color} transition-all duration-200`}>
                    <span className="text-base">{statusData.icon}</span>
                    {statusData.text}
                </div>
            </td>

            {/* 登録日時 */}
            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formattedDate}</td>
            
            {/* 操作ボタン - グラデーション＆ホバー拡大 */}
            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <div className="flex items-center justify-end gap-2">
                    <button 
                        onClick={() => changeStatus(reservation.id, 'seatEnter')} 
                        className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-green-600 text-white text-xs font-semibold rounded-xl hover:shadow-lg hover:scale-105 transition-all duration-200 disabled:opacity-40 disabled:hover:scale-100 whitespace-nowrap"
                        disabled={reservation.status === 'seatEnter'}
                    >
                        着席完了
                    </button>
                    <button 
                        onClick={() => changeStatus(reservation.id, 'waiting')} 
                        className="px-4 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-xs font-semibold rounded-xl hover:shadow-lg hover:scale-105 transition-all duration-200 disabled:opacity-40 disabled:hover:scale-100 whitespace-nowrap"
                        disabled={reservation.status === 'waiting' || reservation.status === 'seatEnter'}
                    >
                        待機に戻す
                    </button>
                    <button 
                        onClick={() => deleteReservation(reservation.id, reservation.number)} 
                        className="px-4 py-2 bg-gradient-to-r from-rose-500 to-red-600 text-white text-xs font-semibold rounded-xl hover:shadow-lg hover:scale-105 transition-all duration-200 whitespace-nowrap"
                    >
                        削除
                    </button>
                </div>
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
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [modalAction, setModalAction] = useState(null); // { type: 'delete', id: '...', number: 123 }

    // ==========================================================
    // データフェッチ: 待ち状況サマリー
    // ==========================================================
    const fetchWaitingSummary = useCallback(async () => {
        if (!isDbReady) {
            setWaitingSummary({ groups: '未接続', people: '未接続' });
            return;
        }
        try {
            const response = await fetch(`${API_BASE_URL}/waiting-summary`);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error("API Error Response:", errorText);
                throw new Error(`API接続エラー (HTTP ${response.status})。バックエンドを確認してください。`);
            }
            
            const summary = await response.json();
            
            const totalGroups = summary.groups || 0;
            const totalPeople = summary.people || 0;
            
            setWaitingSummary({ groups: totalGroups, people: totalPeople });

        } catch (error) {
            console.error("Error fetching summary:", error);
            setWaitingSummary({ groups: 'APIエラー', people: 'APIエラー' });
            if (error.message.includes('Unexpected token') || error.message.includes('API接続エラー')) {
                setComputeMessage(prev => ({ 
                    text: `❌ APIから無効な応答を受け取りました。バックエンド (${API_BASE_URL}/waiting-summary) が起動しているか確認してください。`, 
                    type: 'error' 
                }));
            }
        }
    }, []);

    // ==========================================================
    // データフェッチ: 全予約リスト
    // ==========================================================
    const fetchReservations = useCallback(async () => {
        if (!isDbReady) {
            setReservationList([]);
            return;
        } 
        setListLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/reservations`);
            
            if (!response.ok) {
                 const errorText = await response.text();
                 console.error("API Error Response:", errorText);
                 throw new Error(`API接続エラー (HTTP ${response.status})。バックエンドを確認してください。`);
            }
            
            const reservations = await response.json();
            
            // 登録日時の降順（新しい順）で並べ替える
            const sortedReservations = reservations.sort((a, b) => {
                const timeA = a.createdAt?.seconds || 0;
                const timeB = b.createdAt?.seconds || 0;
                return timeB - timeA;
            });

            setReservationList(sortedReservations);

        } catch (error) {
            console.error("Error fetching reservations:", error);
            setReservationList([]);
             if (error.message.includes('Unexpected token') || error.message.includes('API接続エラー')) {
                setComputeMessage(prev => ({ 
                    text: `❌ APIから無効な応答を受け取りました。バックエンド (${API_BASE_URL}/reservations) が起動しているか確認してください。`, 
                    type: 'error' 
                }));
            }
        }
        setListLoading(false);
    }, []);

    // 初回ロードと定期更新
    useEffect(() => {
        if (!isDbReady) {
            console.warn("Firestore not initialized. Please set REACT_APP_FIREBASE_CONFIG with projectId.");
            return;
        }

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
        if (!isDbReady) {
            setComputeMessage({ text: '🚨 Firebaseが未接続です。設定を確認してください。', type: 'error' });
            return;
        }

        const availableCount = Number(availablePeople);
        
        if (availableCount <= 0 || isNaN(availableCount)) {
            setComputeMessage({ text: '🚨 空き人数は正の数で入力してください。', type: 'error' });
            return;
        }

        setComputeMessage({ text: `全待機リストから呼び出しを処理中...`, type: 'loading' });

        try {
            const payload = {
                availableCount: availableCount,
                apiSecret: API_SECRET
            };

            // 指数バックオフ付きのフェッチ関数
            const fetchWithBackoff = async (url, options, maxRetries = 5) => {
                for (let i = 0; i < maxRetries; i++) {
                    try {
                        const response = await fetch(url, options);
                        if (response.ok) return response;
                        
                        // 4xx, 5xx の場合はリトライ対象（ただし、403は特別扱い）
                        if (response.status === 403) throw new Error("403 Forbidden");

                        throw new Error(`HTTP Error: ${response.status}`);
                    } catch (error) {
                        if (error.message === "403 Forbidden") throw error; // 403はリトライしない
                        
                        console.warn(`Fetch attempt ${i + 1} failed: ${error.message}. Retrying...`);
                        const delay = Math.pow(2, i) * 1000;
                        if (i < maxRetries - 1) {
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            throw error; // 最終リトライ失敗
                        }
                    }
                }
            };
            
            const response = await fetchWithBackoff(`${API_BASE_URL}/compute-call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const responseBody = await response.text();
            
            if (!response.ok) {
                console.error('API Error Response (Status:', response.status, '):', responseBody);
                
                let errorDetail = `API接続エラー (HTTP ${response.status})。`;
                if (response.status === 403) {
                    errorDetail = `認証エラー (403 Forbidden)。Admin.jsの API_SECRET: '${API_SECRET}' がバックエンドの環境変数と一致しているか確認してください。`;
                } else if (response.status === 500) {
                    errorDetail = `サーバー側で処理エラーが発生しました。バックエンドのログを確認してください。`;
                }

                try {
                    const errorJson = JSON.parse(responseBody);
                    if (errorJson.error) {
                        errorDetail += `詳細: ${errorJson.error}`;
                    }
                } catch(e) {
                    if (responseBody && responseBody.length < 200) {
                        errorDetail += ` (詳細テキスト: ${responseBody.trim()})`;
                    }
                    // バックオフ関数ですべてのリトライに失敗した場合、response.okがfalseでここに来る
                }

                throw new Error(errorDetail);
            }
            
            const result = JSON.parse(responseBody);

            if (result.error) {
                throw new Error(result.error);
            }

            if (result.called && result.called.length > 0) {
                setComputeMessage({ 
                    text: `✅ 呼び出し成功: 番号 ${result.called.join(', ')} の組を呼び出しました。 (合計 ${result.totalNeeded} 人)`, 
                    type: 'success' 
                });
            } else {
                setComputeMessage({ 
                    text: `ℹ️ 待機中の予約がないか、空き人数 ${availableCount}人で呼べる組がいませんでした。`, 
                    type: 'info' 
                });
            }

        } catch (error) {
            console.error('Compute call failed:', error);
            setComputeMessage({ 
                text: `❌ 呼び出し失敗: ${error.message}`, 
                type: 'error' 
            });
        }

        fetchWaitingSummary();
        fetchReservations();
    };

    // ==========================================================
    // ステータス変更処理 (着席、待機に戻す)
    // ==========================================================
    const changeStatus = async (id, newStatus) => {
        if (!isDbReady) {
            setComputeMessage({ text: '🚨 Firebaseが未接続です。操作を実行できません。', type: 'error' });
            return;
        }

        const updateData = { status: newStatus };
        if (newStatus === 'seatEnter') {
            updateData.seatEnterAt = new Date();
            updateData.calledAt = null; 
        } else if (newStatus === 'waiting') {
            updateData.calledAt = null; 
            updateData.seatEnterAt = null;
        }
        
        try {
            const docRef = doc(db, 'reservations', id);
            await updateDoc(docRef, updateData);
            console.log(`Status changed for ${id} to ${newStatus}`);
            fetchReservations(); 
            fetchWaitingSummary();
        } catch(e) {
            console.error('Status change failed:', e);
            setComputeMessage({ text: `❌ ステータス変更失敗: ${e.message}`, type: 'error' });
        }
    };

    // ==========================================================
    // 予約削除処理
    // ==========================================================
    const handleDeleteConfirmation = (id, number) => {
        if (!isDbReady) {
            setComputeMessage({ text: '🚨 Firebaseが未接続です。操作を実行できません。', type: 'error' });
            return;
        }
        setModalAction({ type: 'delete', id, number });
        setShowConfirmModal(true);
    };
    
    const executeDelete = async () => {
        if (!isDbReady || !modalAction || modalAction.type !== 'delete') return;

        const { id } = modalAction;
        
        try {
            const docRef = doc(db, 'reservations', id);
            await deleteDoc(docRef);
            console.log(`Reservation ${id} deleted.`);
            
            fetchReservations(); 
            fetchWaitingSummary();
            setComputeMessage({ text: `✅ 予約No.${modalAction.number} を削除しました。`, type: 'success' });
        } catch(e) {
            console.error('Deletion failed:', e);
            setComputeMessage({ text: `❌ 削除失敗: ${e.message}`, type: 'error' });
        } finally {
            setShowConfirmModal(false);
            setModalAction(null);
        }
    };

    // 7️⃣ メッセージバー - グラデーション＆角丸強化
    const getMessageClass = (type) => {
        switch (type) {
            case 'success':
                return 'mt-4 text-sm font-semibold text-emerald-800 bg-gradient-to-r from-emerald-50 to-green-50 border-l-4 border-emerald-500 p-4 rounded-r-2xl shadow-sm';
            case 'error':
                return 'mt-4 text-sm font-semibold text-red-800 bg-gradient-to-r from-red-50 to-rose-50 border-l-4 border-red-500 p-4 rounded-r-2xl shadow-sm';
            case 'loading':
                return 'mt-4 text-sm text-blue-800 flex items-center bg-gradient-to-r from-blue-50 to-indigo-50 border-l-4 border-blue-500 p-4 rounded-r-2xl shadow-sm';
            case 'info':
            default:
                return 'mt-4 text-sm text-gray-700 bg-gradient-to-r from-gray-50 to-slate-50 border-l-4 border-gray-400 p-4 rounded-r-2xl shadow-sm';
        }
    };
    
    // 8️⃣ モーダル - バックドロップブラー＆アニメーション
    const CustomConfirmModal = ({ isOpen, title, message, onConfirm, onCancel }) => {
        if (!isOpen) return null;

        return (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm overflow-y-auto h-full w-full z-50 flex justify-center items-center p-4 animate-in fade-in duration-200">
                <div className="relative p-8 border-0 w-full max-w-md shadow-2xl rounded-3xl bg-white transform transition-all animate-in zoom-in-95 duration-200">
                    <div className="flex items-center gap-3 mb-6">
                        {/* アイコンボックス */}
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center text-white text-2xl shadow-lg">
                            ⚠️
                        </div>
                        <h3 className="text-2xl font-bold text-gray-900">{title}</h3>
                    </div>
                    <div className="mt-4">
                        <p className="text-sm text-gray-700">{message}</p>
                    </div>
                    <div className="mt-8 flex justify-end gap-3">
                        <button
                            onClick={onCancel}
                            className="px-6 py-3 bg-gray-200 text-gray-700 text-base font-semibold rounded-xl hover:bg-gray-300 transition-all duration-200 hover:scale-105"
                        >
                            キャンセル
                        </button>
                        <button
                            onClick={onConfirm}
                            className="px-6 py-3 bg-gradient-to-r from-red-500 to-rose-600 text-white text-base font-semibold rounded-xl hover:shadow-lg transition-all duration-200 hover:scale-105"
                        >
                            削除実行
                        </button>
                    </div>
                </div>
            </div>
        );
    };


    return (
        // 3️⃣ メインコンテナ - グラスモーフィズム＆グラデーション背景
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-indigo-50/30 p-6 sm:p-10 font-sans">
            <div className="max-w-[1600px] mx-auto">
                {/* ヘッダー - Apple風タイポグラフィ */}
                <div className="mb-10">
                    <h1 className="text-5xl font-bold text-gray-900 mb-2 tracking-tight">
                        順番待ち管理システム
                    </h1>
                    <p className="text-lg text-gray-600 font-medium">受付・呼び出し管理コンソール</p>
                </div>

                {/* 待ち状況サマリー & 呼び出しパネル (グリッド化) */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-10">
                    
                    {/* 4️⃣ 待ち状況カード - グラスモーフィズム＆Material Design影 */}
                    <div className="lg:col-span-1 bg-white/80 backdrop-blur-xl rounded-3xl shadow-xl border border-gray-100 overflow-hidden h-fit hover:shadow-2xl transition-all duration-300">
                        <div className="p-8">
                            <h2 className="text-xl font-bold text-gray-900 mb-6 flex items-center gap-2">
                                <span className="text-2xl">📊</span>
                                現在の待ち状況
                            </h2>
                            <div className="space-y-4">
                                {/* 組数カード */}
                                <div className="p-6 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl border border-blue-100 hover:shadow-md transition-all duration-200">
                                    <p className="text-sm font-semibold text-blue-700 mb-2">待機中の組数</p>
                                    <p className="text-5xl font-bold text-blue-600 tracking-tight">
                                        {waitingSummary.groups}
                                        <span className="text-xl font-normal text-blue-500 ml-2">組</span>
                                    </p>
                                </div>
                                {/* 合計人数カード */}
                                <div className="p-6 bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl border border-indigo-100 hover:shadow-md transition-all duration-200">
                                    <p className="text-sm font-semibold text-indigo-700 mb-2">合計待ち人数</p>
                                    <p className="text-5xl font-bold text-indigo-600 tracking-tight">
                                        {waitingSummary.people}
                                        <span className="text-xl font-normal text-indigo-500 ml-2">人</span>
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* 呼び出しパネル */}
                    <div className="lg:col-span-2 bg-white/80 backdrop-blur-xl p-8 rounded-3xl shadow-xl border border-gray-100">
                        <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-2">
                            <span className="text-2xl">⚡️</span>
                            呼び出し実行パネル
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                            
                            <div className="md:col-span-1"> 
                                <label htmlFor="availablePeople" className="block text-sm font-medium text-gray-700 mb-1">空き人数 (席数)</label>
                                {/* 6️⃣ 入力フィールド - グラデーション背景＆フォーカス効果 */}
                                <input 
                                    type="number" 
                                    id="availablePeople" 
                                    value={availablePeople} 
                                    onChange={(e) => setAvailablePeople(e.target.value)}
                                    min="1" 
                                    className="block w-full border-2 border-gray-200 rounded-2xl shadow-sm p-4 text-3xl font-bold text-center focus:ring-4 focus:ring-blue-100 focus:border-blue-400 transition-all duration-200 bg-gradient-to-br from-white to-gray-50"
                                    style={{MozAppearance: 'textfield'}}
                                />
                            </div>
                            {/* 5️⃣ 呼び出しボタン - 鮮やかなグラデーション＆リップル効果風 */}
                            <button 
                                onClick={sendCompute} 
                                className="md:col-span-2 w-full h-full min-h-[64px] px-8 py-4 bg-gradient-to-r from-red-500 via-rose-500 to-pink-500 text-white font-bold text-lg rounded-2xl shadow-lg hover:shadow-2xl transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                                disabled={computeMessage.type === 'loading' || !isDbReady}
                            >
                                {computeMessage.type === 'loading' ? (
                                    <span className='flex items-center justify-center'>
                                        <svg className="animate-spin h-5 w-5 mr-3 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                        呼び出し処理中...
                                    </span>
                                ) : '🔔 一括呼び出し実行 (全待機)'}
                            </button>
                        </div>
                        {/* メッセージ表示エリア */}
                        {computeMessage.text && (
                            <div className={getMessageClass(computeMessage.type)}>
                                {computeMessage.type === 'loading' && <svg className="animate-spin h-4 w-4 mr-2 text-blue-800" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>}
                                {computeMessage.text}
                            </div>
                        )}
                        {!isDbReady && (
                            <p className="mt-4 text-sm font-bold text-red-800 bg-gradient-to-r from-red-50 to-rose-50 border-l-4 border-red-500 p-4 rounded-r-2xl shadow-sm">🚨 Firebaseが未接続です。設定を確認してください。</p>
                        )}
                    </div>
                </div>

                {/* 9️⃣ テーブルコンテナ - グラスモーフィズム */}
                <div className="bg-white/80 backdrop-blur-xl p-8 rounded-3xl shadow-xl border border-gray-100">
                    <h2 className="text-2xl font-bold text-gray-900 mb-6 flex justify-between items-center">
                        <span className='flex items-center gap-2'>
                           全予約リスト
                        </span>
                        {/* 🔟 更新ボタン - ホバー拡大効果 */}
                        <button 
                            onClick={fetchReservations} 
                            className="px-5 py-2.5 text-sm font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all duration-200 hover:scale-105 flex items-center gap-2" 
                            disabled={!isDbReady}
                        >
                            <span className={listLoading ? 'animate-spin' : ''}>🔄</span>
                            {listLoading ? '更新中...' : 'リストを更新'}
                        </button>
                    </h2>
                    <div className="overflow-x-auto rounded-2xl border border-gray-200 shadow-inner bg-white">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gradient-to-r from-gray-50 to-slate-50 sticky top-0">
                                <tr>
                                    <th className="px-6 py-4 text-center text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[80px]">番号</th>
                                    <th className="px-6 py-4 text-left text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[80px]">団体</th>
                                    <th className="px-6 py-4 text-left text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[120px]">氏名</th>
                                    <th className="px-6 py-4 text-left text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[80px]">人数</th>
                                    <th className="px-6 py-4 text-left text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[120px]">LINE通知</th>
                                    <th className="px-6 py-4 text-left text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[120px]">ステータス</th>
                                    <th className="px-6 py-4 text-left text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[120px]">登録日時</th>
                                    <th className="px-6 py-4 text-right text-xs font-bold text-gray-600 uppercase tracking-wider min-w-[340px]">操作</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {listLoading && reservationList.length === 0 ? (
                                    <tr><td colSpan="8" className="text-center py-8 text-gray-500 bg-white/70">データを読み込み中...</td></tr>
                                ) : reservationList.length === 0 ? (
                                    <tr><td colSpan="8" className="text-center py-8 text-gray-500 bg-white/70">予約データがありません。</td></tr>
                                ) : (
                                    reservationList.map(r => (
                                        <ReservationRow 
                                            key={r.id} 
                                            reservation={r} 
                                            changeStatus={changeStatus} 
                                            deleteReservation={handleDeleteConfirmation}
                                        />
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
                
                {/* 削除確認カスタムモーダル */}
                <CustomConfirmModal
                    isOpen={showConfirmModal}
                    title="予約の削除確認"
                    message={`本当に予約No.${modalAction?.number} を完全に削除しますか？この操作は元に戻せません。`}
                    onConfirm={executeDelete}
                    onCancel={() => setShowConfirmModal(false)}
                />

            </div>
        </div>
    );
}
