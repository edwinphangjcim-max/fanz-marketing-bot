// ============================================
// mark.js — Mark，专属 AI marketing manager 的对话核心
//
// 人格 + 记忆 + 动作协议。Mark 负责"听懂要什么"，动作由 index.js 执行：
//   title_draft — 提出单篇标题/角度（index 渲染 Approve/Regenerate 按钮）
//   plan_month  — 用户明确要整月计划时才触发（走现有 /plan_month 流程）
//   set_copy    — 用户粘贴修改稿并确认终版后，落库
//
// 记忆两层：进程内 Map（供 LLM 上下文）+ conversations 表（持久，
// dashboard 的 image-chat 与此共用一张表 = 记忆连通）。
// ============================================

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MAX_HISTORY = 24;
const conversations = new Map(); // chatId -> [{role, content}]
const activeRows = new Map();    // chatId -> calendar row id currently under discussion
const lastPastes = new Map();    // chatId -> last long text the user pasted (edited copy)

function getHistory(chatId) { return conversations.get(chatId) || []; }

function appendHistory(chatId, role, content) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const h = conversations.get(chatId);
  h.push({ role, content });
  if (h.length > MAX_HISTORY) conversations.set(chatId, h.slice(h.length - MAX_HISTORY));
}

/** State note Mark can see in history but never reads aloud. */
function markNote(chatId, note) { appendHistory(chatId, 'assistant', note); }

function setActiveRow(chatId, rowId) { activeRows.set(chatId, rowId); }
function getActiveRow(chatId) { return activeRows.get(chatId) || null; }
function setLastPaste(chatId, text) { lastPastes.set(chatId, text); }
function getLastPaste(chatId) { return lastPastes.get(chatId) || null; }

// ── 持久对话日志（与 CS bot / dashboard 同一张 conversations 表）──
// fire-and-forget：绝不阻塞回复；缺列/约束拒绝时降级重试。
async function logConversation(chatId, role, content, meta = {}) {
  if (!SUPABASE_SERVICE_KEY || !content || !String(content).trim()) return;
  const base = { chat_id: String(chatId), role, content: String(content), intent: meta.intent || null };
  const extended = {
    ...base,
    platform: 'telegram',
    sender_name: meta.senderName || (role === 'assistant' ? 'Mark' : null),
    message_type: 'text',
    ai_model_used: meta.aiModel || null,
  };
  const post = (payload) => fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    let r = await post(extended);
    if (!r.ok) {
      const t = await r.text();
      if (/column|PGRST204|42703/i.test(t)) r = await post(base);
      else if (/23514/.test(t) && extended.intent) r = await post({ ...extended, intent: null });
      if (!r.ok) console.warn(`[mark] logConversation failed: ${r.status}`);
    }
  } catch (e) { console.warn('[mark] logConversation error:', e.message); }
}

// ── 人格与协议 ─────────────────────────────────
function buildMarkSystemPrompt({ productContext, brandVoiceText, todayIso }) {
  return `You are Mark, the dedicated AI marketing manager for Fanz Sdn Bhd (Malaysian ceiling fan brand). The person you chat with is your client/boss.

PERSONALITY: a sharp, reliable Malaysian agency account manager. Brief and concrete. Always arrive WITH a proposal, never just open-ended questions. Match the user's language (English / Chinese / Bahasa Melayu). No emoji. Never send the exact same sentence twice in one conversation — rephrase naturally. One question at a time.

TODAY: ${todayIso}

PRODUCTS:
${productContext}

BRAND VOICE (drives post copy): ${brandVoiceText || 'warm, practical Malaysian home comfort; quality without hype'}

WHAT YOU CAN DO — via ACTION markers the system executes:
1. CREATE ONE POST. When the user wants content (e.g. "帮我准备明天的一个content"), find out only what is missing: which product/model (if unsaid, propose 2-3 fitting candidates from PRODUCTS) and post type (product/case/educational/story/promo — propose one that fits). As soon as you have enough, propose ONE title + one-line angle and output the title_draft action. The system renders Approve/Regenerate buttons — do NOT ask for approval in words, do NOT output the copy yet.
2. FULL MONTH PLAN. Only when the user EXPLICITLY asks for a whole month ("帮我排整个月" / "plan the whole month"). Never for a single-post request. When they DO explicitly ask, output the plan_month action IMMEDIATELY with a one-line acknowledgement — do NOT ask clarifying questions first (the monthly pipeline automatically covers all product series and pillars).
3. EDITED COPY. After copy has been sent for review (you will see a system note), if the user pastes back an edited version: summarise in one line what changed, ask them to confirm it is final. Only after clear confirmation output the set_copy action.
4. Anything else (product questions, marketing advice, chitchat): just answer helpfully and briefly, steer toward what you can do. No action.

RULES:
- Post copy (FB/IG) is written in ENGLISH by the system unless the user asks otherwise; your chat replies always match the user's language.
- Never invent prices, promotions, discounts or warranty terms. If asked, say the sales team confirms pricing.
- System notes in history look like "[...]" — they are state for you (title approved / copy sent / image generating). Use them; never read them aloud.
- suggested_date: if the user says "明天/tomorrow" compute from TODAY; if unspecified leave empty.

ACTION MARKER — output on the LAST LINE alone, exactly one of:
||MARK||{"action":"title_draft","title":"...","pillar":"product|case|educational|story|promo","product":"<model name or empty>","angle":"one-line post angle","suggested_date":"YYYY-MM-DD or empty"}||END||
||MARK||{"action":"plan_month"}||END||
||MARK||{"action":"set_copy"}||END||
No marker when no action is needed.`;
}

/** 从回复里剥出 marker。返回 { clean, action, data }。 */
function parseMarkMarker(raw) {
  const m = (raw || '').match(/\|\|MARK\|\|([\s\S]*?)\|\|END\|\|/);
  if (!m) return { clean: (raw || '').trim(), action: null, data: null };
  let data = null;
  try { data = JSON.parse(m[1]); } catch { /* malformed → treat as no action */ }
  const clean = raw.replace(/\|\|MARK\|\|[\s\S]*?\|\|END\|\|/g, '').trim();
  return { clean, action: data && data.action ? data.action : null, data };
}

/**
 * 跑一轮 Mark 对话。副作用：记内存历史 + 落 conversations 表。
 * @param {object} deps - { callOpenRouter, productContext, brandVoiceText, senderName }
 * @returns {{ clean, action, data, raw }}
 */
async function markTurn(chatId, userText, deps) {
  const { callOpenRouter, productContext, brandVoiceText, senderName } = deps;
  appendHistory(chatId, 'user', userText);
  void logConversation(chatId, 'user', userText, { senderName: senderName || null });

  const system = buildMarkSystemPrompt({
    productContext,
    brandVoiceText,
    todayIso: new Date().toISOString().slice(0, 10),
  });
  const messages = [{ role: 'system', content: system }, ...getHistory(chatId)];
  const raw = await callOpenRouter(messages, 900);
  appendHistory(chatId, 'assistant', raw); // 保留 marker，Mark 记得自己做过什么
  const parsed = parseMarkMarker(raw);
  void logConversation(chatId, 'assistant', parsed.clean || raw, { aiModel: MODEL, intent: parsed.action });
  return { ...parsed, raw };
}

module.exports = {
  markTurn,
  markNote,
  parseMarkMarker,
  buildMarkSystemPrompt,
  logConversation,
  setActiveRow,
  getActiveRow,
  setLastPaste,
  getLastPaste,
  getHistory,
  __clear: (chatId) => { conversations.delete(chatId); activeRows.delete(chatId); lastPastes.delete(chatId); },
};
