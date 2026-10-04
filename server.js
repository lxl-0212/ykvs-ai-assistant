import 'dotenv/config';
import express from 'express';
import { MCPClient } from './mcp-client.js';
import { OpenAILLMClient } from './llm-client-openai.js';
import { getQuickReply } from './quick-reply.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const mcp = new MCPClient();
const llm = new OpenAILLMClient(mcp);
let mcpError = null;

const SCHOOL = /分機|電話|教室|場館|老師|教師|主任|組長|職稱|單位|姓名|行事曆|行程|校規|規定|法規|條文|請假|行動載具|手機|獎懲|成績|考試|補考|學分|編班|轉班|抵免|學習歷程|班級/;

app.get('/healthz', (req, res) => {
  res.json({ ok: true, mcpReady: mcp.ready, mcpTools: mcp.tools.map(x => x.name), mcpError });
});

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({error:'messages (array) is required'});
    const q = String([...messages].reverse().find(x => x?.role === 'user')?.content || '');
    const quick = await getQuickReply(q);
    if (quick !== null) return res.json({ reply: quick, messages: [...messages, {role:'assistant', content:quick}] });
    if (SCHOOL.test(q) && !mcp.ready) {
      return res.status(503).json({error:'校務資料服務尚未完成啟動，請稍後再試。', detail:mcpError});
    }
    const result = await llm.chat(messages, { forceTool: SCHOOL.test(q) });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({error:e.message || '查詢失敗'});
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`YKVS AI Assistant listening on ${port}`));

mcp.connect().catch(err => {
  mcpError = err.message;
  console.error('[MCP STARTUP ERROR]', err);
});
