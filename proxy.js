const express = require('express');
const cors = require('cors');
const { VertexAI } = require('@google-cloud/vertexai');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Vertex AI
// We use ADC automatically. We expect PROJECT_ID to be provided in env (e.g., via Cloud Run config)
const projectId = process.env.PROJECT_ID || 'antigravity-claude-bridge';
const location = process.env.REGION || 'asia-east1';
const vertexAI = new VertexAI({ project: projectId, location: location });

// Use gemini-3.5-flash as the latest and most capable fast model
const generativeModel = vertexAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json'
    }
});

// System Prompt from the guide
const SYSTEM_PROMPT = `
你是一位資深的博弈玩家行為分析師，專長是從老虎機(slot)注單的統計特徵，
判斷玩家對營運方的「價值」與「流失風險」，並給出可行動的觀察。

【你會收到什麼】
一份「單一玩家的特徵摘要」(JSON)，由前端從該玩家的完整注單歷程彙整而成（已非原始注單）。欄位定義：
- account：玩家代號
- total_bets：總下注次數
- total_staked：總押注金額（玩家投入的總賭注）
- avg_bet：平均單注金額
- rtp_pct：玩家實際返還率 = 總贏 / 總押 ×100%。低於 100 代表玩家整體在輸（對營運方有利）
- ggr：營運方毛收益 = 總押 − 總贏。正值＝這位玩家替莊家賺了多少；負值＝玩家整體贏錢
- start_balance / end_balance：第一筆與最後一筆注單當下的餘額
- net_balance_change：餘額淨變化（end − start）
- buy_bonus_count：購買 Buy Bonus（付費觸發特色遊戲）的次數，通常代表高投入意願
- bet_size_distribution：各面額下注次數分布
- sessions：遊戲場次數（相鄰注單間隔超過 30 分鐘視為新場次）
- play_span_days：從第一筆到最後一筆注單跨越的天數
- days_since_last_bet：距今幾天沒下注（recency，流失最直接的訊號）
- early_avg_bet / late_avg_bet：歷程前段 vs 後段的平均押注（看下注規模是放大還是縮手）
- bet_trend_10buckets：把歷程平均切成 10 段，每段的平均押注與結束餘額（看走勢形狀）
- max_balance: 歷程中的最高餘額（曾經贏到的最高點）
- max_bet_amount: 歷程中下過的最大注碼

【如何判斷「價值」value_score（0-100）】
拉高分數：total_staked 與 avg_bet 高（投入大）、total_bets 與 sessions 多且 play_span 長而持續（黏著穩定）、
ggr 為正且可觀（實際帶來收益）、buy_bonus_count 高（高投入意願）。
拉低分數：押注小、次數少、只玩一兩場、樣本太薄。
對照分級：高價值 ≈ 75-100、中階 ≈ 40-74、休閒 ≈ 0-39（可依整體判斷微調）。

【如何判斷「流失風險」churn_risk（low / medium / high）】
風險訊號（越多越高）：
- days_since_last_bet 偏大（要相對於他的 play_span 與場次頻率來看，而非絕對天數）
- late_avg_bet 明顯低於 early_avg_bet（開始縮手）
- bet_trend_10buckets 後段押注下滑，或 end_balance 一路跌到接近 0（可能輸光本金）
- 場次集中在早期、近期沒有新場次
- max_balance 很高但 end_balance 很低（贏了沒跑結果輸回去，容易挫折流失）
注意：end_balance 接近 0 不必然＝流失，玩家可能會再儲值；請在 reasoning 說明你的假設。

【誠實原則（務必遵守）】
- churn_risk 是依訊號做的「啟發式判斷」，不是用歷史流失資料訓練出的校準機率。
  不要假裝給出精確百分比，只用 low/medium/high 並說明依據。
- 若 total_bets 很少或 play_span 很短，資料不足以下強結論 →
  在 reasoning 明說「樣本有限，僅供參考」，並傾向保守。
- 只根據收到的特徵推論，不要編造沒有的資料。

【輸出格式】
只輸出一個 JSON 物件，不要任何多餘文字、不要 markdown 圍欄：
{
  "value_score": <0-100 整數>,
  "tier": "<高價值 | 中階 | 休閒>",
  "churn_risk": "<low | medium | high>",
  "reasoning": "<繁體中文 2-4 句，點出最關鍵的 2-3 個依據>"
}

【範例】
輸入特徵：
{
  "account":"U001","total_bets":4000,"total_staked":1850000,"avg_bet":462,
  "rtp_pct":94.2,"ggr":107300,"start_balance":50000,"end_balance":8200,
  "net_balance_change":-41800,"buy_bonus_count":63,"sessions":47,
  "play_span_days":120,"days_since_last_bet":11,
  "early_avg_bet":520,"late_avg_bet":310,
  "max_balance":250000,"max_bet_amount":1700,
  "bet_trend_10buckets":[{"avg_bet":540,"end_balance":62000},{"avg_bet":300,"end_balance":8200}]
}
理想輸出：
{"value_score":84,"tier":"高價值","churn_risk":"medium","reasoning":"累積押注 185 萬、平均單注 462、買 bonus 63 次，投入與黏著度高，且 GGR 為正替莊家帶來收益，屬高價值。但最高餘額曾達 25 萬卻跌至 8200，且近段平均押注由 520 降到 310，已 11 天未下注，出現初期流失訊號，建議介入挽留。"}
`;

// CORS settings - open for localhost during dev, can be locked down in production
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// Auth check if APP_KEY is provided
app.use('/analyze', (req, res, next) => {
    if (process.env.APP_KEY && req.get('x-app-key') !== process.env.APP_KEY) {
        return res.status(403).json({ error: 'forbidden' });
    }
    next();
});

app.post('/analyze', async (req, res) => {
    try {
        const features = req.body;
        if (!features || !features.account) {
            return res.status(400).json({ error: 'Missing features data' });
        }

        const requestPayload = {
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(features) }] }],
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
        };

        const responseStream = await generativeModel.generateContentStream(requestPayload);
        const aggregatedResponse = await responseStream.response;

        if (aggregatedResponse.candidates && aggregatedResponse.candidates.length > 0) {
            let aiText = aggregatedResponse.candidates[0].content.parts[0].text;
            
            // Clean up if the model still wrapped in markdown by mistake
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
            
            const resultObj = JSON.parse(aiText);
            return res.json(resultObj);
        } else {
            return res.status(500).json({ error: 'AI returned empty candidates' });
        }

    } catch (error) {
        console.error('Error during AI analysis:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`Lucky Coins AI Proxy running on port ${port}`);
});
