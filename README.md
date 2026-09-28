# 鶯歌工商校務 AI 助理

這個版本把原本 Colab Notebook 的網站部分整理成「GitHub 專案 + Node/Express 動態後端」。

## 專案結構

- `public/index.html`：原本的 YKVS 網頁介面
- `server.js`：Express 動態後端，提供 `/chat`
- `data/`：原 Notebook 內嵌的校務資料、行事曆、法規
- `.env.example`：環境變數範例
- `render.yaml`：可用 Render 從 GitHub 部署

## 本機執行

需要 Node.js 20 以上。

```bash
npm install
```

把 `.env.example` 複製成 `.env`，填入：

```env
GEMINI_API_KEY=你的_Gemini_API_Key
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
OPENAI_MODEL=gemini-3.1-flash-lite
PORT=3000
```

然後：

```bash
npm start
```

瀏覽器開啟 `http://localhost:3000`。

## GitHub + 網站部署

GitHub 本身只負責保存程式碼；Express 後端不能直接由 GitHub Pages 執行。

建議：

1. 把整個專案上傳到 GitHub。
2. 在 Render 建立 Web Service，選這個 GitHub repository。
3. Build Command：`npm install`
4. Start Command：`npm start`
5. 在 Render Environment Variables 加入 `GEMINI_API_KEY`。
6. 部署完成後使用 Render 提供的 HTTPS 網址。

## 安全

不要把真正的 API Key 寫進 GitHub。
`.env` 已列入 `.gitignore`。
