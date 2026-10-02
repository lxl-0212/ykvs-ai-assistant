import 'dotenv/config';
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const readJson = async (name) => JSON.parse(await readFile(path.join(DATA, name), 'utf8'));
const readText = async (name) => readFile(path.join(DATA, name), 'utf8');

let staff;
let classes;
let calendar;
let regulations;
let additional;

async function loadData() {
  [staff, classes, calendar, additional] = await Promise.all([
    readJson('staff_extensions.json'),
    readJson('class_extensions.json'),
    readJson('english_center.json'),
    readJson('additional_regulations.json'),
  ]);
  regulations = {};
  for (const file of [
    'mobile_device_policy.md',
    'conduct_and_class_order.md',
    'student_rewards_discipline.md',
    'student_leave_rules.md',
  ]) {
    regulations[file] = await readText(path.join('regulations', file));
  }
}

const compact = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

function dateTimeTaipei() {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date());
}

function dateQuestion(q) {
  return /星期幾|禮拜幾|週幾|今天幾號|今日幾號|今天日期|今日日期|今天星期|今日星期/.test(q);
}
function timeQuestion(q) {
  return /現在幾點|當地時間|當地幾點/.test(q);
}
function weatherQuestion(q) {
  return /天氣|氣溫|下雨|降雨|天候/.test(q);
}

async function getWeather() {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=24.9548&longitude=121.3491&current=temperature_2m,precipitation,rain,weather_code,wind_speed_10m&timezone=Asia%2FTaipei';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`天氣服務回應 ${r.status}`);
  const d = await r.json();
  const c = d.current;
  const codeMap = {0:'晴朗',1:'大致晴朗',2:'部分多雲',3:'陰天',45:'有霧',48:'霧淞',51:'小雨',53:'小雨',55:'小雨',61:'小雨',63:'中雨',65:'大雨',71:'小雪',73:'中雪',75:'大雪',80:'陣雨',81:'陣雨',82:'強陣雨',95:'雷雨',96:'雷雨伴冰雹',99:'雷雨伴冰雹'};
  return `鶯歌目前天氣：${codeMap[c.weather_code] ?? '天氣狀況未知'}，氣溫 ${c.temperature_2m}°C，降雨量 ${c.precipitation} mm，風速 ${c.wind_speed_10m} km/h。資料來源：Open-Meteo。`;
}

function searchSchool(q) {
  const cq = compact(q);
  const out = [];

  const staffRows = staff['分機紀錄'] ?? [];
  const venueRows = staff['場館分機'] ?? [];
  const contactRows = staff['處室窗口'] ?? [];
  const classRows = classes['班級分機'] ?? {};

  const aliases = {
    '教務處':'教務主任', '學務處':'學務主任', '總務處':'總務主任',
    '實習處':'實習處主任', '輔導室':'輔導主任', '生輔組':'生輔組長', '生活輔導組':'生輔組長'
  };

  if (/分機|校園電話|教師|老師|主任|組長|職稱|單位|姓名/.test(q)) {
    const hits = [];
    for (const [office, role] of Object.entries(aliases)) {
      if (cq.includes(compact(office))) {
        for (const row of staffRows) if (compact(row['職稱']).includes(compact(role))) hits.push(row);
      }
    }
    for (const row of staffRows) {
      if (row['姓名'] && cq.includes(compact(row['姓名']))) hits.push(row);
      if (row['職稱'] && cq.includes(compact(row['職稱'])) && row['職稱'] !== '教師') hits.push(row);
      if (row['單位'] && cq.includes(compact(row['單位']))) hits.push(row);
    }
    const unique = [...new Map(hits.map(x => [JSON.stringify(x), x])).values()].slice(0, 12);
    if (unique.length) out.push('【人員／分機】\n' + unique.map(x => `單位：${x['單位']}；職稱：${x['職稱']}；姓名：${x['姓名'] || '未列'}；分機：${(x['分機'] || []).join('、')}`).join('\n'));

    const placeHits = venueRows.filter(x => x['場所'] && cq.includes(compact(x['場所']))).slice(0, 12);
    if (placeHits.length) out.push('【場館分機】\n' + placeHits.map(x => `${x['大樓']}｜${x['場所']}｜分機 ${(x['分機']||[]).join('、')}`).join('\n'));
  }

  const classHits = Object.entries(classRows).filter(([name]) => cq.includes(compact(name)));
  if (classHits.length) out.push('【班級分機】\n' + classHits.map(([name, ext]) => `${name}：${ext}`).join('\n'));

  if (/行事曆|行事历|行程|日期|115-1|1151/.test(q)) {
    const dateMatch = q.match(/20\d{2}[\/-]\d{1,2}[\/-]\d{1,2}/);
    const date = dateMatch?.[0]?.replaceAll('/', '-');
    const rows = calendar.calendar_weeks ?? [];
    const hits = date ? rows.filter(w => (w['每日日期'] || []).includes(date)) : rows.slice(0, 2);
    if (hits.length) {
      for (const w of hits) {
        out.push(`【115-1 行事曆｜第${w['週別']}週】\n日期：${w['日期起']} ～ ${w['日期迄']}\n` + Object.entries(w['各處室行程'] || {}).map(([k,v]) => `${k}：${v}`).join('\n'));
      }
    }
  }

  // 規範資料可以作為 AI 的內部背景，但只有使用者明確要求「法規／法條／條文」時，才把它當成正式法規查詢來呈現。
  const explicitRegulationRequest = /法規|法條|條文|法令|第\s*\d+\s*條|規章原文|官方文件/.test(q);
  const lawMap = [
    ['手機|行動載具|平板|載具', 'mobile_device_policy.md', '行動載具管理規則'],
    ['品德|生活秩序|秩序競賽|班級競賽', 'conduct_and_class_order.md', '品德教育暨班級生活秩序競賽實施要點'],
    ['獎懲|嘉獎|警告|小過|大過|懲處|銷過', 'student_rewards_discipline.md', '學生獎懲規定'],
    ['請假|病假|事假|公假|補假|喪假|身心調適假', 'student_leave_rules.md', '學生請假規則'],
  ];
  for (const [pattern, file, title] of lawMap) {
    if (new RegExp(pattern).test(q)) {
      const text = regulations[file] || '';
      const body = text.replace(/\s+/g, ' ');
      const idx = Math.max(0, body.toLowerCase().indexOf(cq.slice(0, Math.min(8, cq.length))));
      // 一般自然語言問題也可以使用這些資料做內部理解，但不要讓使用者感覺自己被導去查法規。
      out.push(`${explicitRegulationRequest ? `使用者明確要求法規資料：${title}` : `校務背景資料（供 AI 內部理解）：${title}`}\n${body.slice(idx, idx + 1800)}`);
    }
  }

  for (const row of (additional.records ?? [])) {
    const hay = compact([row.department,row.unit,row.category,row.title,row.section_heading,...(row.keywords||[]),row.content].join(' '));
    const tokens = cq.split('').filter(Boolean).slice(0, 40);
    const score = tokens.filter(t => hay.includes(t)).length;
    if (score >= 4 && ['已人工核對','教師已核可','approved'].includes(String(row.review_status || ''))) {
      out.push(`校務資料參考（僅供 AI 理解）：${row.title}\n${row.content}\n資料來源（只有使用者主動要求來源時才揭露）：${row.source_url || ''}\n最後檢核日期：${row.last_verified_date || ''}`);
    }
  }

  return [...new Set(out)].slice(0, 8).join('\n\n');
}

function buildSystemPrompt(context, userQuestion='') {
  const asksForSource = /來源|依據|出處|哪一條|第\s*\d+\s*條|原文|官方文件|文件連結/.test(userQuestion);
  return `你是「鶯歌工商校務 AI 助理」。請使用繁體中文，以師生容易理解、快速得到重點的方式自然回答。\n\n核心原則：\n1. 使用者只需要用自然語言描述問題，不需要先判斷「要查哪個法規／哪個處室」。你要自己理解問題並從提供的校務資料中找答案。\n2. 校務資料（包含規範、請假、獎懲、行動載具等文件）可以作為 AI 的背景依據，但不要把回答寫成「請自行閱讀法規」或直接丟出法條。先用白話整理成使用者能立即理解的答案。\n3. 除非使用者明確說要查「法規、法條、條文、法令、哪一條、原文、官方文件」等，否則一律把校務規範當成內部背景資料，用自然語言白話回答；不要主動提到「法規查詢」，也不要叫使用者自己找法規。\n4. 開放性問題要先自然理解問題並直接回答，不要因為問題裡出現「成績、學分、學習歷程、請假」等詞就機械式把使用者導去查法規。\n5. 如果校務資料不足，誠實說明「目前資料不足」，不要自行捏造；必要時提醒使用者以學校最新公告為準。\n6. 回答簡潔、口語、條理清楚；能直接回答就不要要求使用者再做一次資料分類。\n7. ${asksForSource ? '使用者有要求來源，因此可以在白話答案後補充相關資料來源。' : '使用者沒有要求來源，因此不要主動揭露資料來源。'}
8. 快速標籤只是自然語言提問範例，不代表法規查詢；即使問題涉及請假、獎懲、手機、成績或學分，也先直接回答使用者的實際問題。只有使用者明確要求法規／條文／依據時，才切換成法規或來源說明模式。\n\n以下是本次問題從校務資料庫取得的背景內容（請把它當作內部參考資料，不要原封不動貼給使用者）：\n${context || '（本次沒有找到直接命中的校務資料。）'}`;
}

async function askGemini(messages, context) {
  const key = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) {
    return context || '目前尚未設定 GEMINI_API_KEY。請在部署平台的環境變數加入 Gemini API Key。';
  }
  const client = new OpenAI({
    apiKey: key,
    baseURL: process.env.OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    maxRetries: 0,
    timeout: 45000,
  });
  const result = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gemini-3.1-flash-lite',
    max_tokens: 2048,
    messages: [
      { role: 'system', content: buildSystemPrompt(context, String(messages.at(-1)?.content ?? '')) },
      ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })).slice(-12)
    ]
  });
  return result.choices?.[0]?.message?.content?.trim() || '目前沒有收到文字回答。';
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ykvs-ai-assistant' }));

app.post('/chat', async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const last = [...messages].reverse().find(m => m?.role === 'user');
    const q = String(last?.content ?? '').trim();
    if (!q) return res.status(400).json({ error: 'messages (array) is required' });

    if (dateQuestion(q)) {
      const reply = `台灣現在是 ${dateTimeTaipei()}。`;
      return res.json({ reply, messages: [...messages, { role:'assistant', content:reply }] });
    }
    if (timeQuestion(q)) {
      const reply = `台灣目前時間：${dateTimeTaipei()}。`;
      return res.json({ reply, messages: [...messages, { role:'assistant', content:reply }] });
    }
    if (weatherQuestion(q)) {
      const reply = await getWeather();
      return res.json({ reply, messages: [...messages, { role:'assistant', content:reply }] });
    }

    const context = searchSchool(q);
    const reply = await askGemini(messages, context);
    res.json({ reply, messages: [...messages, { role:'assistant', content:reply }] });
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ error: err?.message || '伺服器錯誤' });
  }
});

await loadData();
app.listen(PORT, () => console.log(`YKVS AI Assistant running on http://localhost:${PORT}`));
