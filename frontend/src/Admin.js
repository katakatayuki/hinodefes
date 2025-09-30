import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCcw, Bell, Users } from 'lucide-react';

// サーバーのURLを設定します。
const API_URL_BASE = ''; 

// メインコンポーネント: 待ち状況のサマリーと呼び出しに特化
const App = () => {
    // 認証機能（API Secret）は削除しています。
    
    // サーバーAPIは団体別データを返すため、Summaryは維持
    const [summary, setSummary] = useState({ '5-5': { groups: 0, people: 0 }, '5-2': { groups: 0, people: 0 } });
    
    // 呼び出し対象団体を管理するステートを追加
    const [callGroup, setCallGroup] = useState('5-5'); 
    
    // 呼び出し人数
    const [availableCount, setAvailableCount] = useState(4); 
    
    const [callResult, setCallResult] = useState({ message: '', type: '' });
    const [isLoading, setIsLoading] = useState(false);

    // 総待ち人数を計算
    const totalWaitingPeople = Object.values(summary).reduce((sum, item) => sum + (item.people || 0), 0);
    const totalWaitingGroups = Object.values(summary).reduce((sum, item) => sum + (item.groups || 0), 0);


    // ==========================================================
    // データフェッチ (Summaryのみ)
    // ==========================================================
    const fetchSummary = async () => {
        try {
            const response = await fetch(`${API_URL_BASE}/api/waiting-summary`);
            if (!response.ok) throw new Error('Summary fetch failed');
            const data = await response.json();
            setSummary(data);
        } catch (error) {
            console.error("待ち状況の取得に失敗しました:", error);
        }
    };
    
    const fetchData = useCallback(async () => {
        if (isLoading) return;
        setIsLoading(true);

        try {
            await fetchSummary();
        } catch (error) {
            console.error("データフェッチ中にエラーが発生しました:", error);
        } finally {
            setIsLoading(false);
        }
    }, [isLoading]);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5000); // 5秒ごとに更新
        return () => clearInterval(interval);
    }, [fetchData]);

    // ==========================================================
    // 呼び出し操作
    // ==========================================================
    const handleCall = async () => {
        if (!availableCount || availableCount <= 0 || !callGroup) {
            setCallResult({ message: '空き人数と団体を正しく選択してください。', type: 'error' });
            return;
        }

        setIsLoading(true);
        setCallResult({ message: '呼び出し処理を実行中です...', type: 'info' });

        // サーバーに送信するペイロード
        const payload = {
            callGroup: callGroup, // 🚨 サーバーが要求する団体名
            availableCount: parseInt(availableCount, 10)
        };

        try {
            const response = await fetch(`${API_URL_BASE}/api/compute-call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (response.ok) {
                if (data.called && data.called.length > 0) {
                    setCallResult({ 
                        message: `${data.called.length} 組 (${data.totalNeeded} 人) を呼び出しました: ${data.called.join(', ')} (団体 ${callGroup} 対象)`, 
                        type: 'success' 
                    });
                } else {
                    setCallResult({ message: `団体 ${callGroup} には呼び出し可能な待ち組がいませんでした。`, type: 'warning' });
                }
                fetchData(); 
            } else {
                const errorMessage = data.message || data.error || response.statusText;
                setCallResult({ message: `呼び出し失敗: ${errorMessage}`, type: 'error' });
            }

        } catch (error) {
            console.error("呼び出しAPI通信エラー:", error);
            setCallResult({ message: `通信エラーが発生しました: ${error.message}`, type: 'error' });
        } finally {
            setIsLoading(false);
        }
    };

    // ==========================================================
    // レンダリング
    // ==========================================================
    const renderCallResult = () => {
        if (!callResult.message) return null;

        let bgColor = 'bg-gray-100';
        let textColor = 'text-gray-800';
        
        switch (callResult.type) {
            case 'success':
                bgColor = 'bg-green-100';
                textColor = 'text-green-700';
                break;
            case 'error':
                bgColor = 'bg-red-100';
                textColor = 'text-red-700';
                break;
            case 'warning':
                bgColor = 'bg-yellow-100';
                textColor = 'text-yellow-700';
                break;
            default:
                break;
        }

        return (
            <div className={`mt-4 p-3 rounded-xl font-medium ${bgColor} ${textColor}`}>
                {callResult.message}
            </div>
        );
    };

    const renderSummaryCard = (title, value) => (
        <div key={title} className="bg-indigo-50 p-4 rounded-xl flex justify-between items-center shadow-inner border border-indigo-200">
            <span className="font-medium text-gray-600 flex items-center">
                <Users className="w-5 h-5 mr-2 text-primary" />
                {title}
            </span>
            <span className="text-xl font-bold text-primary">
                {value}
            </span>
        </div>
    );
    
    return (
        <div className="p-4 md:p-8 bg-gray-50 min-h-screen">
            <div className="max-w-4xl mx-auto">
                <h1 className="text-4xl font-extrabold text-gray-800 mb-6 border-b-4 border-primary pb-3 flex items-center">
                    <Bell className="w-8 h-8 mr-3 text-primary" />
                    受付システム 管理ダッシュボード
                </h1>

                {/* 更新ボタンのみ */}
                <div className="bg-white p-6 rounded-xl shadow-lg mb-8 border-t-4 border-indigo-500 flex justify-end">
                    <button 
                        onClick={fetchData} 
                        disabled={isLoading}
                        className="flex items-center justify-center p-3 text-sm font-medium rounded-xl bg-primary hover:bg-indigo-600 text-white transition disabled:opacity-50 w-full md:w-auto"
                    >
                        <RefreshCcw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                        最新情報に更新
                    </button>
                </div>


                {/* 待ち状況と呼び出しコントロール */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                    
                    {/* 待ち状況サマリー */}
                    <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-primary/50">
                        <h2 className="text-2xl font-semibold text-primary mb-4">
                            現在の待ち状況 (総計)
                        </h2>
                        <div className="space-y-4">
                            {renderSummaryCard('総待ち人数', `${totalWaitingPeople} 人`)}
                            {renderSummaryCard('総待ち組数', `${totalWaitingGroups} 組`)}
                        </div>
                        <div className="mt-4 pt-4 border-t border-indigo-200">
                            <h3 className="text-lg font-semibold text-gray-700 mb-2">団体別内訳</h3>
                            <p className="text-sm">
                                5-5: {summary['5-5'].people}人 ({summary['5-5'].groups}組) / 
                                5-2: {summary['5-2'].people}人 ({summary['5-2'].groups}組)
                            </p>
                        </div>
                    </div>

                    {/* 呼び出しコントロール */}
                    <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-green-500">
                        <h2 className="text-2xl font-semibold text-green-700 mb-4">
                            呼び出し実行
                        </h2>
                        <div className="space-y-4">
                            {/* 団体選択ドロップダウン */}
                            <select 
                                value={callGroup}
                                onChange={(e) => setCallGroup(e.target.value)}
                                className="p-3 border-2 border-gray-300 rounded-xl w-full focus:ring-primary focus:border-primary transition duration-150 font-bold text-lg"
                            >
                                <option value="5-5">団体 5-5 を呼び出す</option>
                                <option value="5-2">団体 5-2 を呼び出す</option>
                            </select>

                            <input 
                                type="number" 
                                id="availableCount" 
                                placeholder="空き人数 (例: 4)" 
                                value={availableCount}
                                onChange={(e) => setAvailableCount(e.target.value)}
                                min="1" 
                                className="p-3 border-2 border-gray-300 rounded-xl w-full focus:ring-green-500 focus:border-green-500 transition duration-150"
                            />
                            <button 
                                onClick={handleCall} 
                                id="callButton" 
                                disabled={isLoading}
                                className="bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-4 rounded-xl w-full transition duration-150 ease-in-out shadow-md hover:shadow-lg disabled:opacity-50 flex items-center justify-center"
                            >
                                <Bell className="w-5 h-5 mr-2" />
                                呼び出しを実行 ({callGroup})
                            </button>
                        </div>
                        {renderCallResult()}
                    </div>

                </div>
            </div>
        </div>
    );
};

export default App;
```eof
