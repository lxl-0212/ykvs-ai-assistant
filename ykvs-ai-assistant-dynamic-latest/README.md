# 鶯歌工商 YKVS Mini AI Assistant

這是一個可部署到 Render 的動態網站版本。

## 架構
- 前端：`public/index.html`
- 後端：Node.js + Express (`server.js`)
- 校務資料：`data/`
- AI：Gemini OpenAI-compatible API
- `/chat`：動態問答 API
- `/health`：健康檢查

## Render 環境變數
- `GEMINI_API_KEY`：Gemini API Key
- `OPENAI_BASE_URL`：`https://generativelanguage.googleapis.com/v1beta/openai/`（可省略，server 有預設值）
- `OPENAI_MODEL`：例如 `gemini-3.1-flash-lite`（可省略）

## 本機執行
```bash
npm install
npm start
```

開啟 `http://localhost:3000`。

> 注意：不要把 API Key 寫進 GitHub，也不要把 `.env` 上傳。
