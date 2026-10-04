import OpenAI from 'openai';

const SYSTEM = `你是「鶯歌工商校務 AI 助理」。
- 一般問題用自然、簡潔的繁體中文回答。
- 涉及學校事實（老師、處室、分機、教室、場館、班級、行事曆、校規等）只能使用 MCP 查到的資料，不得猜測。
- 人名、職稱、分機尤其禁止自行補寫。
- 查不到時明確說「目前找不到可以直接支持這個問題的校方資料」。
- 使用者不必知道資料格式；要理解自然語言、省略樓層、口語說法與同義詞。
- 只有使用者明確詢問規定、法規、條文、原文或正式文件時才展開法規內容。
- 校務回答最後列出「🔗 資料來源」，只能使用工具回傳的來源。`;

function fallbackNatural(q, raw) {
  let d = {}; try { d = JSON.parse(raw); } catch { return '目前找不到可以直接支持這個問題的校方資料。'; }
  if (d.場館分機?.length) {
    return d.場館分機.map(r => `「${r.場所 || ''}」的分機是 ${Array.isArray(r.分機) ? r.分機.join('、') : r.分機 || '未提供'}。`).join('\n') + `\n\n🔗 資料來源\n• ${d.分機資料來源?.校方網站 || '鶯歌工商校方資料'}`;
  }
  if (d.分機總表紀錄?.length) {
    return d.分機總表紀錄.map(r => `${r.姓名 || r.職稱 || r.單位 || '查詢對象'}：分機 ${Array.isArray(r.分機) ? r.分機.join('、') : r.分機 || '未提供'}。`).join('\n') + `\n\n🔗 資料來源\n• ${d.分機資料來源?.校方網站 || '鶯歌工商校方資料'}`;
  }
  if (d.班級分機?.length) return d.班級分機.map(r => `${r.班級}：分機 ${Array.isArray(r.分機) ? r.分機.join('、') : r.分機}。`).join('\n');
  if (d.行事曆) return `查到 ${d.行事曆.length} 筆相關行事曆資料。\n\n🔗 資料來源\n• ${d.來源 || '鶯歌工商校方公告'}`;
  if (d.法規結果?.length) return d.法規結果.map(x => `${x.文件}\n${x.原文摘錄}`).join('\n\n') + '\n\n🔗 資料來源\n• https://www.ykvs.ntpc.edu.tw/';
  return `${d.結果 || '目前找不到可以直接支持這個問題的校方資料。'}\n\n🔗 資料來源\n• ${d.官方首頁 || 'https://www.ykvs.ntpc.edu.tw/'}`;
}

export class OpenAILLMClient {
  constructor(mcp) {
    this.mcp = mcp;
    const key = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
    this.enabled = Boolean(key);
    this.openai = this.enabled ? new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: key,
      timeout: 45000,
      maxRetries: 0
    }) : null;
    this.model = process.env.OPENAI_MODEL || 'gemini-3.1-flash-lite';
  }

  async chat(messages, {forceTool=false}={}) {
    const user = String([...messages].reverse().find(x => x?.role === 'user')?.content || '');
    if (!this.enabled) {
      const raw = await this.mcp.callTool('search_school_info', {query:user});
      const answer = fallbackNatural(user, raw);
      return {reply:answer, messages:[...messages,{role:'assistant',content:answer}]};
    }
    const history = [{role:'system',content:SYSTEM}, ...messages.map(m => ({role:m.role, content:Array.isArray(m.content) ? m.content.filter(x=>x?.type==='text').map(x=>x.text).join('') : m.content}))];
    const first = await this.openai.chat.completions.create({model:this.model,messages:history,tools:this.mcp.getOpenAITools(),tool_choice:forceTool?'required':'auto',max_tokens:1200});
    const msg = first.choices?.[0]?.message || {};
    history.push(msg);
    if (!msg.tool_calls?.length) return {reply:String(msg.content||''),messages:history};
    for (const tc of msg.tool_calls) {
      let args={}; try { args=JSON.parse(tc.function.arguments||'{}'); } catch {}
      const out=await this.mcp.callTool(tc.function.name,args);
      history.push({role:'tool',tool_call_id:tc.id,content:out});
    }
    const final=await this.openai.chat.completions.create({model:this.model,messages:history,max_tokens:1200});
    let answer=String(final.choices?.[0]?.message?.content||'');
    const sources=[];
    for(const m of history.filter(x=>x.role==='tool')) { try { const d=JSON.parse(m.content); if(d.分機資料來源?.校方網站)sources.push(d.分機資料來源.校方網站); if(d.來源)sources.push(d.來源); if(d.官方首頁)sources.push(d.官方首頁); if(d.法規結果?.[0]?.來源)sources.push(d.法規結果[0].來源); } catch {} }
    const uniq=[...new Set(sources)];
    if(uniq.length && !answer.includes('資料來源')) answer += `\n\n🔗 資料來源\n${uniq.map(x=>`• ${x}`).join('\n')}`;
    return {reply:answer,messages:history};
  }
}
