// server.js — 教學範例：Express 主程式
//
// 職責：
//   1. 啟動時連接 MCP 服務、建立 LLM client
//   2. 提供 POST /chat：接收 messages 陣列，回傳 {reply, messages}
//   3. 提供靜態網頁 /，載入 web/index.html

import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MCPClient } from './mcp-client.js';
import { LLMClient } from './llm-client.js';
import { OpenAILLMClient } from './llm-client-openai.js';
import { getQuickReply, quickTagQuery } from './quick-reply.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 切到專案根目錄，讓 config.json 裡的相對路徑（例如 "mcp-server-py"）一致可解析。
process.chdir(ROOT);

// 1. 讀 config 並連接所有 MCP server（啟動時一次完成）
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
const mcp = new MCPClient(config);
await mcp.connect();

// 依環境變數選擇 LLM provider（claude | openai）
// 預設 claude。改用 vLLM/Gemma/本地模型時設 LLM_PROVIDER=openai。
const provider = (process.env.LLM_PROVIDER ?? 'claude').toLowerCase();
const llm = provider === 'openai'
  ? new OpenAILLMClient(mcp)
  : new LLMClient(mcp);

// 高風險校務查詢（尤其分機／電話／教室）先由 MCP 查證，
// 不讓 LLM 在沒有查到資料時自行猜測。回答仍使用自然語言。
function isVerifiedSchoolLookup(query) {
  return /(分機|電話|內線|教室|電腦教室|電腦工場|專題室|選手室|場館)/.test(String(query || ''));
}

function formatVerifiedSchoolLookup(raw, query) {
  let data;
  try { data = JSON.parse(String(raw || '')); } catch { return null; }

  const roomHits = Array.isArray(data?.場館分機) ? data.場館分機 : [];
  const officeHits = Array.isArray(data?.處室窗口) ? data.處室窗口 : [];
  const staffHits = Array.isArray(data?.分機總表紀錄) ? data.分機總表紀錄 : [];
  const classHits = Array.isArray(data?.班級分機) ? data.班級分機 : [];

  if (!roomHits.length && !officeHits.length && !staffHits.length && !classHits.length) {
    return {
      reply: `📌 我有查詢鶯歌工商的校務分機資料，但目前找不到可以直接支持「${query}」的紀錄。\n\n我不會自行猜測分機；你可以改用「6D電腦教室」、「資處科6D」或完整場所名稱再試一次。\n\n🔗 資料來源\n• 鶯歌工商分機公告版：https://www.ykvs.ntpc.edu.tw/`,
      found: false,
    };
  }

  const lines = ['📌 查到了，這是校方分機資料：'];
  if (roomHits.length) {
    for (const row of roomHits.slice(0, 5)) {
      const place = row?.場所 || '';
      const building = row?.大樓 || '';
      const ext = Array.isArray(row?.分機) ? row.分機.join('、') : String(row?.分機 || '');
      lines.push(`• ${building ? building + ' ' : ''}${place}：**${ext}**`);
    }
  }
  if (classHits.length) {
    for (const row of classHits.slice(0, 5)) lines.push(`• ${row?.班級 || ''}：**${row?.分機 || ''}**`);
  }
  if (officeHits.length) {
    for (const row of officeHits.slice(0, 5)) lines.push(`• ${row?.單位 || ''}${row?.職稱 ? `（${row.職稱}）` : ''}：**${Array.isArray(row?.分機) ? row.分機.join('、') : row?.分機 || ''}**`);
  }
  if (staffHits.length) {
    for (const row of staffHits.slice(0, 5)) lines.push(`• ${row?.姓名 || ''}${row?.職稱 ? `（${row.職稱}）` : ''}：**${Array.isArray(row?.分機) ? row.分機.join('、') : row?.分機 || ''}**`);
  }

  lines.push('', '🔗 資料來源', '• 鶯歌工商分機公告版：https://www.ykvs.ntpc.edu.tw/');
  return { reply: lines.join('\n'), found: true };
}

// 2. Express 設定
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(ROOT, 'web')));

app.post('/chat', async (req, res) => {
  const { messages } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages (array) is required' });
  }

  try {
    const lastUserMessage = [...messages].reverse().find(m => m?.role === 'user');
    const rawQuery = String(lastUserMessage?.content ?? '');

    // 日期／時間／天氣仍可走真正的 Quick Reply。
    // 校務快速標籤則只負責「選擇查詢意圖」，實際資料仍交給 LLM + MCP。
    const quickReply = await getQuickReply(rawQuery, mcp);
    if (quickReply !== null) {
      return res.json({
        reply: quickReply,
        messages: [...messages, { role: 'assistant', content: quickReply }],
      });
    }

    // 分機／電話／教室等高風險查詢：先查 MCP，再用固定自然語言格式回覆。
    // 這一層不依賴 Claude 或 Gemini 是否正確選擇 tool，因此可避免
    // 「資處科6D電腦教室」被模型自行解讀成「資處科辦公室」而產生幻覺。
    if (isVerifiedSchoolLookup(rawQuery)) {
      const raw = await mcp.callTool('search_school_info', { query: rawQuery });
      const verified = formatVerifiedSchoolLookup(raw, rawQuery);
      if (verified) {
        return res.json({
          reply: verified.reply,
          messages: [...messages, { role: 'assistant', content: verified.reply }],
        });
      }
    }

    let llmMessages = messages;
    const tagQuery = quickTagQuery(rawQuery);
    if (tagQuery) {
      llmMessages = messages.map((m, index) =>
        index === messages.length - 1 && m?.role === 'user'
          ? { ...m, content: `請用自然語言回答這個校務問題：${tagQuery}` }
          : m
      );
    }

    const result = await llm.chat(llmMessages);
    res.json(result);
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. 啟動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`→ Mini AI Assistant: http://localhost:${PORT}`);
});
