import React, { useState } from 'react';
import { Loader, AlertTriangle, CheckCircle } from 'lucide-react';

// 🚨 【要変更】あなたのRenderサーバーのURLに置き換えてください
// window.location.originを使用することで、同一オリジンの場合はパスのみでOK
const SERVER_URL = window.location.origin; 
// 🚨 【要変更】LINE友だち追加QRコード画像のURLに置き換えてください
const LINE_QR_CODE_URL = 'https://hinodefes-57609.web.app/QRCODE.png';

// --- Component: Custom Modal (alert/confirmの代わり) ---
const CustomModal = ({ title, message, isOpen, onClose, isError = false }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden transform transition-all">
                <div className="p-6">
                    <div className="flex items-center mb-4">
                        {isError ? (
                            <AlertTriangle className="h-6 w-6 text-red-500 mr-3" />
                        ) : (
                            <CheckCircle className="h-6 w-6 text-green-500 mr-3" />
                        )}
                        <h3 className="text-xl font-bold text-gray-800">{title}</h3>
                    </div>
                    <p className="text-gray-600 whitespace-pre-wrap border-t pt-4">{message}</p>
                </div>
                <div className="bg-gray-50 px-6 py-4 flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-6 py-2 text-white bg-blue-600 rounded-lg font-semibold shadow-md hover:bg-blue-700 transition"
                    >
                        OK
                    </button>
                </div>
            </div>
        </div>
    );
};

export default function Reception() {
    const [name, setName] = useState('');
    const [people, setPeople] = useState(1);
    const [wantsLine, setWantsLine] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    
    // 団体選択を削除したため、団体名は固定値とする
    const group = "一般"; 

    const [isReserved, setIsReserved] = useState(false);
    const [reservedNumber, setReservedNumber] = useState(null);

    // モーダル管理ステート
    const [modal, setModal] = useState({ isOpen: false, title: '', message: '', isError: false });
    const openModal = (title, message, isError = false) => setModal({ isOpen: true, title, message, isError });
    const closeModal = () => setModal({ isOpen: false, title: '', message: '', isError: false });

    async function handleSubmit(e) {
        e.preventDefault();
        
        if (name.trim() === '') {
            openModal("エラー", "お名前を入力してください。", true);
            return;
        }

        if (people <= 0) {
            openModal("エラー", "人数は1人以上で入力してください。", true);
            return;
        }

        setIsSubmitting(true);
        setIsReserved(false); 
        setReservedNumber(null);

        try {
            const response = await fetch(`${SERVER_URL}/api/reserve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: name.trim(),
                    people: Number(people),
                    wantsLine,
                    group, // 固定の団体名「一般」を送信
                }),
            });

            if (!response.ok) {
                const errorBody = await response.json().catch(() => ({ message: response.statusText }));
                throw new Error(errorBody.message || `API登録に失敗しました: ${response.statusText}`);
            }

            const result = await response.json();
            const number = result.number; // サーバーから複合番号（例: "55-1"）が返ってくる

            // フォームをリセット
            setName('');
            setPeople(1);
            setWantsLine(false);
            
            // 予約成功後の処理を条件分岐
            if (wantsLine) {
                setReservedNumber(number);
                setIsReserved(true);
                openModal("登録完了", `登録しました。\n受付番号は【${number}】番です。\n引き続きLINEの友だち追加をお願いします。`);
            } else {
                openModal("登録完了", `登録しました。\n受付番号は【${number}】番です。`, false);
            }
            
        } catch (error) {
            console.error(error);
            openModal('登録失敗', `登録処理中にエラーが発生しました。\nエラー: ${error.message || 'ネットワークまたはサーバーを確認してください。'}`, true);
        } finally {
            setIsSubmitting(false);
        }
    }

    // 予約完了後のQRコード表示画面
    if (isReserved && reservedNumber !== null) {
        return (
            <div className="bg-white p-6 sm:p-8 rounded-xl shadow-2xl max-w-lg mx-auto border-t-8 border-green-500 text-center min-h-[500px]">
                <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
                <h1 className="text-3xl font-extrabold text-gray-800 mb-2">登録完了！</h1>
                
                <p className="text-xl font-medium text-gray-600 mt-4">受付番号:</p>
                <h2 className="text-5xl font-extrabold text-red-600 mb-6">{reservedNumber}</h2>
                
                <h3 className="text-2xl font-bold text-gray-700 mt-6">LINE通知設定</h3>
                <p className="text-sm text-gray-600 mb-4">準備完了の通知を受け取るため、以下のQRコードをLINEで読み取り、**友だち追加**してください。</p>
                
                <img 
                    src={LINE_QR_CODE_URL} 
                    alt="LINE友だち追加QRコード" 
                    className="w-48 h-48 border border-gray-300 mx-auto my-6 rounded-lg shadow-md"
                    onError={(e) => {e.target.onerror = null; e.target.src="https://placehold.co/250x250/FCA5A5/FFFFFF?text=QR+Code+Error"}} // 画像URLエラー時のフォールバック
                />
                
                <button
                    onClick={() => setIsReserved(false)}
                    className="w-full py-3 px-4 bg-gray-700 text-white font-semibold rounded-lg shadow-md hover:bg-gray-800 transition duration-150 mt-4"
                >
                    受付画面に戻る
                </button>
                <CustomModal 
                    title={modal.title} 
                    message={modal.message} 
                    isOpen={modal.isOpen} 
                    onClose={closeModal} 
                    isError={modal.isError}
                />
            </div>
        );
    }

    // 通常の受付フォーム
    return (
        <div className="min-h-screen bg-gray-100 p-4 sm:p-6 flex flex-col items-center justify-center font-sans">
            <div className="bg-white p-6 sm:p-8 rounded-xl shadow-2xl w-full max-w-lg border-t-8 border-green-500">
                <h1 className="text-3xl font-extrabold text-gray-800 mb-6 text-center">受付</h1>
                
                <form onSubmit={handleSubmit} className="space-y-6">
                    {/* 団体情報 (固定表示) */}
                    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                        <p className="text-sm font-medium text-gray-600">団体名 (固定):</p>
                        <p className="text-xl font-bold text-gray-800">{group}</p>
                    </div>

                    {/* 1. 名前 */}
                    <div>
                        <label htmlFor="name" className="block text-lg font-medium text-gray-700 mb-1">お名前:</label>
                        <input
                            type="text"
                            id="name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-green-500 focus:border-green-500 text-lg"
                            placeholder="お名前（ニックネーム可）"
                            required
                            disabled={isSubmitting}
                        />
                    </div>

                    {/* 2. 人数 */}
                    <div>
                        <label htmlFor="people" className="block text-lg font-medium text-gray-700 mb-1">人数:</label>
                        <input
                            type="number"
                            id="people"
                            value={people}
                            onChange={(e) => setPeople(Math.max(1, Number(e.target.value)))}
                            min="1"
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-green-500 focus:border-green-500 text-lg"
                            required
                            disabled={isSubmitting}
                        />
                    </div>

                    {/* 3. LINE通知希望 */}
                    <div className="flex items-center pt-2">
                        <input
                            id="line-notify"
                            type="checkbox"
                            checked={wantsLine}
                            onChange={(e) => setWantsLine(e.target.checked)}
                            className="h-5 w-5 text-green-600 border-gray-300 rounded focus:ring-green-500"
                            disabled={isSubmitting}
                        />
                        <label htmlFor="line-notify" className="ml-3 text-base font-medium text-gray-700">
                            LINEで通知希望
                        </label>
                    </div>

                    {/* 4. 登録ボタン */}
                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-lg shadow-md text-xl font-semibold text-white bg-green-600 hover:bg-green-700 transition duration-150 ease-in-out disabled:bg-green-400 disabled:cursor-not-allowed mt-8"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader className="animate-spin h-5 w-5 mr-3" />
                                登録中...
                            </>
                        ) : (
                            '登録'
                        )}
                    </button>
                </form>
            </div>
            
            <CustomModal 
                title={modal.title} 
                message={modal.message} 
                isOpen={modal.isOpen} 
                onClose={closeModal} 
                isError={modal.isError}
            />
        </div>
    );
}
