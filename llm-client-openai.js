// llm-client-openai.js — 對 OpenAI 兼容 endpoint 的 adapter
//
// 適用情境：
//   - 自架 vLLM serve（預設 http://localhost:8000/v1）
//   - Ollama 啟用 OpenAI 相容模式
//   - LiteLLM 代理
//   - 真的 OpenAI / Azure OpenAI
//
// 與 llm-client.js（Claude 版）的差異：
//   1. Tool format：{type:'function', function:{name, description, parameters}}
//      而非 Claude 的 {name, description, input_schema}
//   2. Tool call 在 message.tool_calls（object array），而非 Claude content block
//   3. Tool result 用 role='tool' + tool_call_id，而非 Claude 的 tool_result content block
//   4. 停止條件：!message.tool_calls || finish_reason==='stop'
//
// 這個檔案和 llm-client.js 並存，由 server.js 根據 LLM_PROVIDER 環境變數選擇。

import OpenAI from 'openai';

const SCHOOL_AI_SYSTEM_PROMPT = `你是鶯歌工商校務 AI 助理。你的核心任務是「理解學生的問題，而不是要求學生理解學校行政架構」。

【一、自然語言理解】
1. 學生不需要知道處室、組別或行政流程。先理解問題，再使用 MCP 校方資料查找。
2. 快速標籤只是查詢入口；回答一律用自然、白話、手機容易閱讀的繁體中文。不要把使用者導向「法規查詢」或要求他自己閱讀文件。
3. 只有使用者明確要求「法規、法條、第幾條、原文、官方文件、依據」時，才特別展開法規內容；平常即使答案依據校規，也先用白話解釋。

【二、校務資料與防幻覺】
4. 只要問題涉及鶯歌工商的「人名、職稱、單位、分機、班級、場館、行事曆、校務規定、辦理方式」等校本事實，必須先使用 MCP 校方資料。不要靠模型記憶補答案。
5. 人名與分機是高風險欄位：只能使用 MCP 回傳的姓名、職稱、單位與分機；資料沒有就明確說沒有找到，絕對不要猜。
6. 如果 MCP 找不到足以支持答案的資料，請明確說「目前找不到可以直接支持這個問題的校方資料」，不要用常識補成校方規定。
7. 一般常識或非校務問題可以正常使用模型知識，但不要把一般常識說成鶯歌工商的正式規定。

【三、回答方式】
8. 預設先給 2～5 句「📌 簡單說」，讓師生快速理解。必要時再列出步驟或注意事項。
9. 不要整段貼出法規原文，除非使用者明確要求原文／法條。
10. 回答校務事實時，在答案最後一定保留「🔗 資料來源」區塊；來源只能使用 MCP 工具實際回傳的來源資訊，不得自行編造 URL、文件名稱或日期。
11. 如果 MCP 有來源 URL，可以列出可點擊的 URL；如果只有文件名稱或來源描述，就照實列出，不要自行補網址。
12. 不要用「📖 法規依據」作為所有校務問題的固定格式；一般問題只需要自然語言＋資料來源。
13. 保持繁體中文、乾淨條理、適合手機閱讀。`;

export class OpenAILLMClient {
  constructor(mcpClient, {
    baseURL = process.env.OPENAI_BASE_URL ?? 'http://localhost:8000/v1',
    apiKey = process.env.OPENAI_API_KEY ?? 'dummy',  // vLLM 不驗證
    model = process.env.OPENAI_MODEL ?? 'gemma-4',
    maxTokens = 2048,
  } = {}) {
    // Gemini 相容端點曾多次回傳 503；不要讓 SDK 自動重試拉長等待時間。
    // 單次模型請求最多 45 秒，逾時/503 會清楚回報，重試可由使用者自行發起。
    this.openai = new OpenAI({ baseURL, apiKey, maxRetries: 0, timeout: 45_000 });
    this.mcp = mcpClient;
    this.model = model;
    this.maxTokens = maxTokens;
    console.log(`[LLM] OpenAI-compatible: ${baseURL} (model=${model})`);
  }

  // 剝除 Gemma 4 的 thinking channel 標記。
  //
  // 為何需要？Gemma 4 chat_template 在「不啟用 thinking」時會強制 prepend
  //   <|channel>thought\n<channel|>
  // 來把 model 從 "thought" channel 切到 "final" channel（見模型 tokenizer_config）。
  // vLLM 0.19.x 的 gemma4_tool_parser 暫未 strip 這些 channel 標記，會原封不動
  // 漏到 message.content。等上游 parser 處理後可拔掉這個 method。
  //
  // 範例：  "<|channel>thought<channel|>實際內容"  →  "實際內容"
  _stripThinkingMarkers(text) {
    return text
      .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
      .replace(/<\|channel>final[\s\S]*?<channel\|>/g, '')
      .trim();
  }

  // 把外部傳進來的 messages 正規化成 OpenAI 格式
  // 前端可能傳純文字 {role, content:string}；歷史可能含 tool_calls / role=tool
  _normalize(messages) {
    return messages.map(m => {
      // 若 content 是 array（Claude 格式殘留），抽出文字
      if (Array.isArray(m.content)) {
        const text = m.content
          .filter(b => b && b.type === 'text')
          .map(b => b.text)
          .join('');
        return { role: m.role, content: text };
      }
      return m;
    });
  }

  _collectSources(toolOutputs) {
    const sources = [];
    const seen = new Set();
    const add = (label, url) => {
      const cleanUrl = String(url ?? '').trim();
      const cleanLabel = String(label ?? '').trim();
      if (!cleanLabel && !cleanUrl) return;
      const key = `${cleanLabel}|${cleanUrl}`;
      if (seen.has(key)) return;
      seen.add(key);
      sources.push({ label: cleanLabel || cleanUrl, url: cleanUrl });
    };

    for (const raw of toolOutputs) {
      let data;
      try { data = JSON.parse(String(raw ?? '')); } catch { continue; }
      const walk = (node, context = '') => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(item => walk(item, context)); return; }

        if (node.分機資料來源) {
          const s = node.分機資料來源;
          add(s.文件 || '鶯歌工商分機資料', s.校方網站 || '');
        }
        if (node.來源 && typeof node.來源 === 'string') {
          add(context || '校務資料來源', node.來源);
        }
        if (node.官方來源 && typeof node.官方來源 === 'string') {
          add(node.標題 || context || '校務規定', node.官方來源);
        }
        if (node.官方首頁 && typeof node.官方首頁 === 'string') {
          add('鶯歌工商官方網站', node.官方首頁);
        }
        if (node.來源檔案 && typeof node.來源檔案 === 'string') {
          add(node.文件 || context || '校務資料', node.來源檔案);
        }
        if (node.生輔組規定清單) {
          for (const item of node.生輔組規定清單) add(item.文件 || '生輔組規定', item.來源 || '');
        }
        if (node.法規結果) {
          for (const item of node.法規結果) add(item.文件 || '校務規定', item.來源 || '');
        }
        for (const [key, value] of Object.entries(node)) {
          if (key === '分機資料來源' || key === '法規結果' || key === '生輔組規定清單') continue;
          if (value && typeof value === 'object') walk(value, key);
        }
      };
      walk(data);
    }
    return sources;
  }

  _appendSources(answer, toolOutputs) {
    const sources = this._collectSources(toolOutputs);
    if (!sources.length) return answer;
    const lines = sources.map(s => s.url
      ? `• ${s.label}：${s.url}`
      : `• ${s.label}`);
    return `${String(answer ?? '').trim()}\n\n🔗 資料來源\n${lines.join('\n')}`.trim();
  }

  async chat(messages, { maxIterations = 5 } = {}) {
    const history = this._normalize(messages);
    if (!history.some(m => m?.role === 'system')) {
      history.unshift({ role: 'system', content: SCHOOL_AI_SYSTEM_PROMPT });
    }
    const deadline = Date.now() + 60_000;
    const toolOutputs = [];

    for (let i = 0; i < maxIterations; i++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('查詢已超過 60 秒，模型服務可能繁忙；請稍後重試。');
      }
      const resp = await this.openai.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        tools: this.mcp.getOpenAITools(),
        messages: history,
      }, { timeout: Math.min(45_000, remainingMs) });

      const msg = resp.choices[0].message;
      history.push(msg);

      // 沒有 tool call → 結束
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const clean = this._stripThinkingMarkers(msg.content ?? '');
        const grounded = this._appendSources(clean, toolOutputs);
        return { reply: grounded, messages: history };
      }

      console.log(`  [tool_use] ${msg.tool_calls.map(tc => tc.function.name).join(', ')}`);

      // 並行執行所有 tool calls
      const toolResults = await Promise.all(
        msg.tool_calls.map(async tc => {
          let args;
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch (e) {
            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: model returned invalid JSON arguments: ${e.message}`,
            };
          }

          try {
            const output = await this.mcp.callTool(tc.function.name, args);
            if (tc.function.name === 'search_school_info') toolOutputs.push(output);
            return { role: 'tool', tool_call_id: tc.id, content: output };
          } catch (e) {
            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: ${e.message}`,
            };
          }
        }),
      );

      history.push(...toolResults);
    }

    throw new Error(`Tool-calling exceeded ${maxIterations} iterations`);
  }
}
