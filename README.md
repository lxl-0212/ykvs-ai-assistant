# 鶯歌工商校務 AI 助理｜動態網站新版

這個版本以 2026-10-02 的 YKVS Mini AI Assistant Notebook 設定為基礎，部署目標是 Render + Node.js + Express。

## 核心設計

- 使用者直接用自然語言提問，不需要先選「法規／處室／資料類型」。
- 校務規範、請假、獎懲、行動載具等資料可以在後端作為 AI 的背景依據。
- AI 優先把資料轉成白話、簡潔、容易理解的回答，不要求師生自行閱讀法規。
- 只有使用者主動要求「來源、依據、哪一條、原文、官方文件」時，才補充來源資訊。
- 開放式問題維持一般 AI 理解，不會因為出現成績、學分、學習歷程、請假等詞就機械式要求查法規。
- `/health` 可供 Render 健康檢查。

## Render

Build Command：`npm install`

Start Command：`npm start`

Environment Variable：`GEMINI_API_KEY`

不要把 API Key 寫進 GitHub。
