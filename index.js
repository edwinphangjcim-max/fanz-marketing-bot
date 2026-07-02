const TelegramBot = require('node-telegram-bot-api');
const { brand, products } = require('./products');
const fs = require('fs');
const path = require('path');
const http = require('http');
const supabase = require('./lib/supabase');
const supabasePlans = require('./lib/supabase-plans');
const { buildPlanSystemPrompt, parsePlanResponse, validateSelection, createSelectionPayload } = require('./lib/planning');
const { buildCopywritingPrompt, parseCopywritingResponse, validateCopywritingResult } = require('./lib/copywriting');
const { publishToSocial } = require('./lib/publish');
const { generateSceneImage } = require('./lib/scene-gen');
const { buildMonthlySystemPrompt, parseTargetMonth } = require('./lib/monthly-planning');
const { parseAndValidateMonthlyPlan, mapPillarForDB } = require('./lib/monthly-plan-parser');
const { isFestivalPost, getFestiveSceneDescription } = require('./lib/festival-handler');
const { schedulePlan, formatScheduleTable } = require('./lib/monthly-scheduler');
const { checkTodayPosts, buildReminderMessage } = require('./cron-publish-reminder');
const { classifyIntent } = require('./lib/intent-router');
const worker = require('./lib/worker');

// ============================================
// VERSION / GIT COMMIT SHA
// ============================================
const VERSION_FILE = path.join(__dirname, 'version.txt');

function resolveCommitSha() {
  // 1. Railway provides this automatically at deploy time
  const fromEnv = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  // 2. Read .git/HEAD (handles both detached SHA and ref pointer)
  try {
    const headPath = path.join(__dirname, '.git', 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = path.join(__dirname, '.git', head.slice(5).trim());
      const sha = fs.readFileSync(refPath, 'utf8').trim();
      if (sha) return sha;
    } else if (head) {
      return head;
    }
  } catch (_) {
    // .git not available (e.g., shipped Docker image without git dir)
  }
  // 3. Fallback to an existing version.txt baked into the image
  try {
    const cached = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    if (cached) return cached;
  } catch (_) {
    // no cached file either
  }
  return 'unknown';
}

const COMMIT_SHA = resolveCommitSha();
try {
  fs.writeFileSync(VERSION_FILE, COMMIT_SHA + '\n');
} catch (err) {
  console.error('Could not write version.txt:', err.message);
}

// ============================================
// CONFIG
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o';
const PRODUCT_IMAGE = path.join(__dirname, 'images', 'ceiling-fan-sample.jpg');
const PLAN_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Test hook: skip live bot + HTTP startup so the module is requireable from tests.
const SKIP_BOT_INIT = process.env.SKIP_BOT_INIT === '1';

if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) {
  if (!SKIP_BOT_INIT) {
    console.error('Missing TELEGRAM_TOKEN or OPENROUTER_API_KEY');
    process.exit(1);
  }
}

if (supabase.isConfigured()) {
  console.log('Supabase connected: service_role key loaded');
} else {
  console.warn(
    'Supabase NOT configured — SUPABASE_URL and SUPABASE_SERVICE_KEY missing. ' +
      'content_calendar persistence is disabled.'
  );
}

// ============================================
// callback_data constructor with byte-size guard
// Telegram limit: 64 bytes. We assert <= 60 for margin.
// ============================================
/**
 * Build safe callback_data with automatic byte-size assertion.
 * Throws immediately at construction time if data exceeds 60 bytes,
 * so overflows are caught during dev, not at sendMessage() runtime.
 *
 * @param {string} prefix - short prefix (2-4 chars recommended for headroom)
 * @param  {...(string|number)} parts - additional segments joined with ':'
 * @returns {string} callback_data (< 60 bytes guaranteed)
 */
function cb(prefix, ...parts) {
  const data = parts.length > 0 ? `${prefix}:${parts.join(':')}` : prefix;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > 60) {
    throw new Error(
      `callback_data overflow: "${data}" = ${bytes} bytes ` +
      `(Telegram limit 64, margin kept to 60). ` +
      `Shorten prefix or use a Map lookup instead.`
    );
  }
  return data;
}

// ============================================
// /plan session state
// ============================================
// Map<chatId, { plans: [{number, title, description, direction}], timestamp: Date }>
const planSessions = new Map();

// Map<chatId, { rowId, reviewMsgId }> — set when user clicks "Request Changes",
// cleared after their next text message is consumed as the revision note.
const awaitingReviewNotes = new Map();

// Map<chatId, { planId, postId }> — set when user clicks "Edit" on a monthly plan post,
// cleared after their next text message is consumed as the new topic/angle.
const awaitingMonthEdits = new Map();

// Map<chatId, { planId, postId }> — set when user clicks "Remove" on a monthly plan post,
// cleared after confirmation is resolved.
const awaitingMonthRemoves = new Map();

// Map<chatId, { rowId, planId }> — set when user clicks "batch_reject" on a batch review card,
// cleared when user sends revision notes or session expires.
const awaitingBatchReviewNotes = new Map();
// Map<calId, planId> — stores planId for batch review buttons to stay under Telegram's 64-byte callback_data limit.
const batchActionMap = new Map();

// Map<chatId, { rowId }> — set when user clicks "Upload Own" on an image review card,
// cleared after their next photo is received and processed.
const awaitingImageUpload = new Map();

// Map<calId, planId> — for monthly calendar action callbacks (short format < 64 bytes)
const monthActionMap = new Map();

// Map<chatId, { rowId }> — set when user clicks "Change Scene" on an image review card,
// cleared after their next text message is consumed as the new scene description.
const awaitingSceneChange = new Map();

/**
 * Resolve the planId for a calendar row.
 * monthActionMap/batchActionMap are in-memory and lost on restart, so old
 * inline buttons would resolve to '' and half-fail after a redeploy.
 * Fallback: the row itself carries plan_id in the DB.
 */
async function resolvePlanId(map, rowId) {
  const cached = map.get(rowId);
  if (cached) return cached;
  try {
    const row = await supabase.getContentCalendar(rowId);
    return (row && row.plan_id) || '';
  } catch (err) {
    console.error(`resolvePlanId: DB fallback failed for ${rowId}:`, err.message);
    return '';
  }
}

function getPlanSession(chatId) {
  const session = planSessions.get(chatId);
  if (!session) return null;
  if (Date.now() - session.timestamp > PLAN_SESSION_TTL_MS) {
    planSessions.delete(chatId);
    return null;
  }
  return session;
}

function setPlanSession(chatId, plans) {
  planSessions.set(chatId, { plans, timestamp: Date.now() });
}

function clearPlanSession(chatId) {
  planSessions.delete(chatId);
}

// ============================================
// Review node helpers
// ============================================
const PILLAR_EMOJI = { product: '🛒', case: '🏠', promo: '🎉', story: '📖' };

function buildReviewMessage(parsed, plan) {
  const emoji = PILLAR_EMOJI[plan.direction] || '📝';
  return (
    `🔎 *Review Required*\n\n` +
    `${emoji} *${plan.title}*\n` +
    `Direction: ${plan.direction}\n\n` +
    `📱 *Facebook*\n${parsed.fb_content}\n\n` +
    `📸 *Instagram*\n${parsed.ig_content}\n\n` +
    `#⃣ *Hashtags*\n${parsed.hashtags}`
  );
}

function buildReviewKeyboard(rowId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: cb('review_approve',rowId) },
        { text: '✏️ Request Changes', callback_data: cb('review_reject',rowId) },
      ],
    ],
  };
}

function buildApprovePayload() {
  return { status: 'approved' };
}

function buildRejectPayload(notes) {
  return { status: 'rejected', review_notes: notes };
}

// Pure priority decider so tests can lock in the message-handler intercept order.
//   non-text          → 'skip'
//   digit + plan      → 'plan_selection'
//   awaiting review   → 'review_notes'
//   starts with /     → 'command'
//   otherwise         → 'free_text'  (routed through classifyIntent() for intent-based handling)
//                                      See lib/intent-router.js for intent classification.
//                                      The classifyIntent() call dispatches to:
//                                        chitchat   → consultant reply
//                                        plan_month → monthly planning flow
//                                        generate_post → generateContent(pillar, topic)
//                                        ask_question  → consultant answers
//                                        unclear       → asks clarifying question
function decideMessageIntent(text, hasPlanSession, hasAwaitingReview) {
  if (typeof text !== 'string' || text.length === 0) return 'skip';
  if (/^[1-9]\d{0,2}$/.test(text) && hasPlanSession) return 'plan_selection';
  if (hasAwaitingReview) return 'review_notes';
  if (text.startsWith('/')) return 'command';
  return 'free_text';
}

// ============================================
// PRODUCT CONTEXT (from products.js)
// ============================================
function buildProductContext() {
  return products.map(p =>
    `- ${p.name} (${p.typeZh}/${p.type}): ${p.descriptionZh || p.description}\n  Key features: ${p.keySellingPoints.join(', ')}`
  ).join('\n');
}

// ============================================
// SYSTEM PROMPTS
// ============================================

// System prompt built by lib/copywriting.js which is always imported.
// The old hardcoded SYSTEM_PROMPT was removed — all paths now use
// buildCopywritingPrompt() from lib/copywriting.js for unified brand voice.

// ============================================
// OpenRouter API helper (fetch, no SDK)
// ============================================
async function callOpenRouter(messages, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fanz-marketing-bot.railway.app',
        'X-Title': 'Fanz Marketing Bot'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        max_tokens: maxTokens || 1500,
        temperature: 0.8
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// Generate marketing content — UNIFIED via lib/copywriting.js
// ============================================
async function generateContent(command, userText) {
  // Map command to pillar
  const pillarMap = { product: 'product', case: 'case', promo: 'promo', story: 'story' };
  const pillar = pillarMap[command] || 'product';

  // Build topic with sensible defaults per pillar
  const topic = userText || ({
    product: 'Showcase our ceiling fan collection',
    case: 'Real customer installation — Malaysian home transformation',
    promo: 'Current promotion',
    story: 'Fanz brand story — 10 years of quality and trust',
  }[command] || 'Product promotion');

  // Build system prompt from the shared copywriting module
  const systemPrompt = buildCopywritingPrompt(topic, pillar);

  // User message — short, just the brief
  const userPrompt = userText
    ? `Generate the post based on this brief: "${userText}"`
    : 'Generate the post.';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  return await callOpenRouter(messages);
}

// ============================================
// BOT INIT
// ============================================
// Under SKIP_BOT_INIT, use a no-op proxy so registering handlers and dispatching
// methods is a silent no-op — tests can require the module without polling.
const bot = SKIP_BOT_INIT
  ? new Proxy({}, { get: () => () => Promise.resolve() })
  : new TelegramBot(TELEGRAM_TOKEN, { polling: true });

if (!SKIP_BOT_INIT) {
  console.log(`Fanz Marketing Bot started. Model: ${MODEL}. Commit: ${COMMIT_SHA}`);

  // Background worker: batch imagery for Dashboard-triggered plans (M-5),
  // image_retry consumption, auto-scheduling (M-6), daily reminder (M-7).
  worker.start({
    sendMessage: (chatId, text, opts) => bot.sendMessage(chatId, text, opts),
    sendPhoto: (chatId, photo, opts) => bot.sendPhoto(chatId, photo, opts),
    sendImageReviewCard: (chatId, rowId, imageUrl, status, isDryRun, retryCount) =>
      sendImageReviewCard(chatId, rowId, imageUrl, status, isDryRun, retryCount),
  });
}

// ============================================
// HTTP SERVER (Railway health + version probe)
// ============================================
const HTTP_PORT = process.env.PORT || 8080;

const httpServer = http.createServer((req, res) => {
  // Parse URL for API routes
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // /api/marketing/monthly-plan/:planId
  if (pathParts[0] === 'api' && pathParts[1] === 'marketing' && pathParts[2] === 'monthly-plan' && pathParts[3]) {
    const planId = pathParts[3];
    handleMonthlyPlanApi(req, res, planId);
    return;
  }

  // Legacy routes
  if (req.url === '/version') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(COMMIT_SHA);
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OK');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

async function handleMonthlyPlanApi(req, res, planId) {
  res.setHeader('Content-Type', 'application/json');
  try {
    switch (req.method) {
      case 'GET': {
        // Return plan details + all calendar rows
        const plan = await supabasePlans.getContentPlan(planId);
        if (!plan) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Plan not found' }));
          return;
        }
        const rows = await supabase.listContentCalendarByPlanId(planId);
        res.writeHead(200);
        res.end(JSON.stringify({ plan, calendarRows: rows }));
        break;
      }
      case 'PATCH': {
        // Update individual calendar row
        const body = await parseRequestBody(req);
        if (!body.id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing calendar row id' }));
          return;
        }
        const { id, ...updateData } = body;
        const updated = await supabase.updateContentCalendar(id, updateData);
        res.writeHead(200);
        res.end(JSON.stringify({ updated }));
        break;
      }
      case 'DELETE': {
        // Remove a calendar row from the plan — expects ?rowId=xxx
        const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
        const rowId = url.searchParams.get('rowId');
        if (!rowId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing rowId query parameter' }));
          return;
        }
        // Delete the calendar row
        const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
        const delRes = await fetch(`${supabaseUrl}/rest/v1/content_calendar?id=eq.${encodeURIComponent(rowId)}`, {
          method: 'DELETE',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (!delRes.ok) {
          const errText = await delRes.text();
          res.writeHead(delRes.status);
          res.end(JSON.stringify({ error: `Delete failed: ${errText}` }));
          return;
        }
        // Decrement total_posts on the plan
        const plan = await supabasePlans.getContentPlan(planId);
        if (plan && typeof plan.total_posts === 'number') {
          await supabasePlans.updateContentPlan(planId, { total_posts: Math.max(0, plan.total_posts - 1) });
        }
        res.writeHead(200);
        res.end(JSON.stringify({ deleted: true, rowId }));
        break;
      }
      default: {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      }
    }
  } catch (err) {
    console.error('handleMonthlyPlanApi error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

async function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

if (!SKIP_BOT_INIT) {
  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on :${HTTP_PORT} (commit=${COMMIT_SHA})`);
  });
}

// ============================================
// COMMANDS
// ============================================

// /start
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const welcome = `🤖 *Fanz Marketing Consultant*

I'm your professional marketing colleague from Fanz Sdn Bhd. I can:

📅 Plan monthly content calendars
✍️ Write individual social media posts (FB/IG)
🖼️ Generate product-in-scene images
💡 Give marketing advice & answer product questions

*Available commands:*
/plan [context] — AI content planning (suggest topics → pick → generate)
/product [brief] — Generate product promotion post
/case [details] — Generate installation case study post
/promo [details] — Generate promotion / campaign post
/story [context] — Generate brand story post
/plan_month — Generate a full-month content calendar
/schedule_month — Schedule approved posts

Just send me a message and I'll figure out what you need!

Example: /product Let's promote our new Smart Series fan with WiFi control

同时支持中文交流 🇨🇳`;

  await bot.sendMessage(chatId, welcome);
});

// /plan — Content planning workflow
bot.onText(/^\/plan\b(.*)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const userContext = match[1] ? match[1].trim() : '';

  await bot.sendMessage(chatId, '🧠 Analyzing current date and Malaysia context to plan your week...');

  try {
    const systemPrompt = buildPlanSystemPrompt();
    const userPrompt = userContext
      ? `Generate content plan suggestions. Extra context from user: "${userContext}"`
      : 'Generate content plan suggestions for this week.';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const rawResponse = await callOpenRouter(messages);
    const plans = parsePlanResponse(rawResponse);

    if (plans.length === 0) {
      // If parsing failed, show raw response as fallback
      await bot.sendMessage(chatId, `⚠️ Here's the AI's suggestions (raw):\n\n${rawResponse}\n\nPlease use a command like /product [title] to generate content.`);
      return;
    }

    // Store in session
    setPlanSession(chatId, plans);

    // Build nice output
    let output = '📋 *This Week\'s Content Plan*\n\n';
    for (const plan of plans) {
      const dirEmoji = { product: '🛒', case: '🏠', promo: '🎉', story: '📖' };
      output += `${dirEmoji[plan.direction] || '📝'} *${plan.number}. ${plan.title}*\n`;
      output += `   ${plan.description}\n`;
      output += `   Direction: ${plan.direction}\n\n`;
    }

    output += '—————————————————\n';
    output += 'Reply with a *number* (1-' + plans.length + ') to generate that content now!\n';
    output += 'Or send /plan again for fresh suggestions.';

    await bot.sendMessage(chatId, output, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/plan error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating plan. Please try /plan again.'));
  }
});

// ============================================
// Monthly calendar reshow helper
// ============================================
const PILLAR_EMOJI_MONTHLY = {
  product: '🛒',
  case: '🏠',
  educational: '📚',
  story: '📖',
  promo: '🎉',
  festival: '🎊',
};

async function buildMonthCalendarMessage(planId) {
  const plan = await supabasePlans.getContentPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const rows = await supabase.listContentCalendarByPlanId(planId);
  if (!rows || rows.length === 0) {
    return { text: `📅 *Monthly Plan — ${plan.month}*\n\nNo posts in this plan.`, keyboard: undefined };
  }

  // Only include active posts (not rejected unless we want to show them)
  const activeRows = rows.filter(r => r.status !== 'rejected');

  // Sort by suggested_date
  const sorted = [...activeRows].sort((a, b) => (a.suggested_date || '').localeCompare(b.suggested_date || ''));

  // Group by week
  const weeks = [];
  let currentWeek = [];
  let currentWeekNum = null;

  for (const row of sorted) {
    const d = new Date((row.suggested_date || '') + 'T00:00:00+08:00');
    const startOfYear = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((d - startOfYear) / 86400000) + startOfYear.getDay() + 1) / 7);

    if (currentWeekNum !== null && weekNum !== currentWeekNum) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeekNum = weekNum;
    currentWeek.push(row);
  }
  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }

  let output = `📅 *Monthly Content Plan — ${plan.month}*\n\n`;
  output += `*Status:* ${plan.status} | *Posts:* ${activeRows.length}/${plan.total_posts || activeRows.length}\n\n`;

  for (const week of weeks) {
    output += `━━━ *Week* ━━━\n`;
    for (const row of week) {
      const emoji = PILLAR_EMOJI_MONTHLY[row.pillar] || '📝';
      const dateFormatted = (row.suggested_date || '').replace(/^\d{4}-/, '');
      output += `${dateFormatted} ${emoji} *${row.topic}*\n`;
      output += `   _${row.pillar}_ — ${row.post_angle || ''}\n\n`;
    }
  }

  // Build inline keyboard with per-post action buttons
  const keyboard = [];
  for (const row of sorted) {
    const shortTopic = (row.topic || '').length > 30
      ? (row.topic || '').slice(0, 27) + '...'
      : (row.topic || '');
    monthActionMap.set(row.id, planId);
    keyboard.push([
      { text: `✏️ ${shortTopic}`, callback_data: cb('me',row.id) },
      { text: `❌ Remove`, callback_data: cb('mr',row.id) },
      { text: `🔄 Replace`, callback_data: cb('mrp',row.id) },
    ]);
  }
  keyboard.push(
    [{ text: '✅ Approve this month', callback_data: cb('ma',planId) }]
  );

  return { text: output, keyboard: { inline_keyboard: keyboard } };
}

async function reshowMonthCalendar(chatId, planId) {
  try {
    const { text, keyboard } = await buildMonthCalendarMessage(planId);
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error('reshowMonthCalendar error:', err);
    await bot.sendMessage(chatId, '❌ Failed to reload calendar. Please use /plan_month again.');
  }
}

// ============================================
// /plan_month — Monthly content planning
// ============================================
bot.onText(/^\/plan_month(?:\s+(.*))?$/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const userInput = match[1] ? match[1].trim() : null;

  // Determine target month
  const target = parseTargetMonth(userInput);
  const targetMonthStr = target.monthStr;

  await bot.sendMessage(chatId, `📅 Generating monthly content plan for *${targetMonthStr}*...\nThis will take a moment.`, { parse_mode: 'Markdown' });

  try {
    // Step a: Build prompt and call LLM
    const systemPrompt = buildMonthlySystemPrompt(targetMonthStr);
    const userPrompt = `Generate a full-month content calendar for ${targetMonthStr} with exactly 12 regular posts (4 product, 3 case, 2 educational, 2 story, 1 promo) plus 0-2 festival posts. Ensure all product series are featured.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const rawResponse = await callOpenRouter(messages, 4000);

    // Step b: Parse and validate
    const parsed = parseAndValidateMonthlyPlan(rawResponse, targetMonthStr);

    if (!parsed.valid || parsed.posts.length < 8) {
      let detail = '';
      if (parsed.errors.length > 0) {
        detail += '\n' + parsed.errors.slice(0, 10).map(e => '• ' + e).join('\n');
      }
      if (parsed.warnings && parsed.warnings.length > 0) {
        detail += '\n\n⚠️ Notes:\n' + parsed.warnings.slice(0, 15).map(w => '• ' + w).join('\n');
      }
      await bot.sendMessage(chatId,
        `⚠️ The AI response did not produce a valid monthly plan.${detail}\n\nRaw response:\n\`\`\`\n${rawResponse.slice(0, 3000)}\n\`\`\``);
      return;
    }

    // Step c: Create content_plans row
    let planId = null;
    if (supabase.isConfigured()) {
      try {
        const planRow = await supabasePlans.createContentPlan({
          month: targetMonthStr,
          status: 'pending_approval',
          chat_id: String(chatId),
          total_posts: parsed.regularPosts.length + parsed.festivalPosts.length,
          notes: `Generated via /plan_month`,
        });
        planId = planRow.id;
        console.log(`Created content_plans row: ${planId} for ${targetMonthStr}`);
      } catch (err) {
        console.error('content_plans creation error:', err);
        await bot.sendMessage(chatId, `⚠️ Monthly plan generated but could not save to database. The plan is not persisted.`);
      }
    } else {
      console.warn('Supabase not configured — skipping content_plans write');
    }

    // Step d: Create content_calendar rows linked to plan
    const createdCalendarIds = [];
    if (planId && supabase.isConfigured()) {
      for (const post of parsed.posts) {
        try {
          // Use DB-safe pillar (festival → story)
          const dbPillar = mapPillarForDB(post.pillar);
          const calRow = await supabase.createContentCalendar({
            chat_id: String(chatId),
            pillar: dbPillar,
            topic: post.topic,
            post_angle: post.post_angle,
            suggested_date: post.suggested_date,
            plan_id: planId,
            status: 'planned',
          });
          createdCalendarIds.push(calRow.id);
        } catch (err) {
          console.error(`createContentCalendar error for "${post.topic}":`, err.message);
          createdCalendarIds.push(null); // keep arrays in sync
        }
      }
      console.log(`Created ${createdCalendarIds.length}/${parsed.posts.length} content_calendar rows for plan ${planId}`);
    }

    // Step e: Build and send calendar overview message with per-post buttons
    const sortedPosts = [...parsed.posts].sort((a, b) => a.suggested_date.localeCompare(b.suggested_date));

    // Group by week
    const weeks = [];
    let currentWeek = [];
    let currentWeekNum = null;

    for (const post of sortedPosts) {
      const d = new Date(post.suggested_date + 'T00:00:00+08:00');
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const weekNum = Math.ceil((((d - startOfYear) / 86400000) + startOfYear.getDay() + 1) / 7);

      if (currentWeekNum !== null && weekNum !== currentWeekNum) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
      currentWeekNum = weekNum;
      currentWeek.push(post);
    }
    if (currentWeek.length > 0) {
      weeks.push(currentWeek);
    }

    let output = `📅 *Monthly Content Plan — ${targetMonthStr}*\n\n`;
    output += `*Pillar Breakdown:*\n`;
    for (const [p, count] of Object.entries(parsed.pillarCounts)) {
      if (p === 'festival') continue;
      output += `${PILLAR_EMOJI_MONTHLY[p] || '📝'} ${p}: ${count}\n`;
    }
    if (parsed.festivalPosts.length > 0) {
      output += `${PILLAR_EMOJI_MONTHLY.festival} festival: ${parsed.festivalPosts.length}\n`;
    }
    output += `\n`;

    for (const week of weeks) {
      output += `━━━ *Week* ━━━\n`;

      for (const post of week) {
        const emoji = PILLAR_EMOJI_MONTHLY[post.pillar] || '📝';
        const dateFormatted = post.suggested_date.replace(/^\d{4}-/, '');
        output += `${dateFormatted} ${emoji} *${post.topic}*\n`;
        output += `   _${post.pillar}_ — ${post.post_angle}\n\n`;
      }
    }

    output += `✅ *${parsed.regularPosts.length} regular posts + ${parsed.festivalPosts.length} festival posts generated*`;

    // Build per-post action buttons from created calendar rows
    const keyboardRows = [];
    if (planId && createdCalendarIds.length > 0) {
      for (let i = 0; i < sortedPosts.length; i++) {
        const post = sortedPosts[i];
        const calId = createdCalendarIds[i];
        if (!calId) continue;
        const shortTopic = post.topic.length > 30 ? post.topic.slice(0, 27) + '...' : post.topic;
        monthActionMap.set(calId, planId);
        keyboardRows.push([
          { text: `✏️ ${shortTopic}`, callback_data: cb('me',calId) },
          { text: `❌ Remove`, callback_data: cb('mr',calId) },
          { text: `🔄 Replace`, callback_data: cb('mrp',calId) },
        ]);
      }
      keyboardRows.push(
        [{ text: '✅ Approve this month', callback_data: cb('ma',planId) }]
      );
    }

    await bot.sendMessage(chatId, output, {
      parse_mode: 'Markdown',
      reply_markup: planId ? { inline_keyboard: keyboardRows } : undefined,
    });

  } catch (err) {
    console.error('/plan_month error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating monthly plan. Please try /plan_month again.'));
  }
});

// ============================================
// M-6: /schedule_month — Auto-schedule approved posts
// ============================================
bot.onText(/^\/schedule_month\s+(.+)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const planId = match[1].trim();

  if (!supabase.isConfigured()) {
    await bot.sendMessage(chatId, '⚠️ Supabase not configured. Cannot schedule.');
    return;
  }

  try {
    await bot.sendMessage(chatId, `📅 Scheduling posts for plan ${planId.slice(0, 8)}...`);

    // Manual scheduling accepts any post-copy status — scheduling only
    // assigns dates. The worker's automatic path uses ['approved'] only.
    const scheduledRows = await schedulePlan(planId, {
      statuses: ['approved', 'image_ready', 'image_retry', 'copy_approved'],
    });
    const table = formatScheduleTable(scheduledRows);

    await bot.sendMessage(chatId, table, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/schedule_month error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error scheduling month. Please try again.'));
  }
});

// ============================================
// M-7: /check_today — Manual check of today's pending posts
// ============================================
bot.onText(/^\/check_today/i, async (msg) => {
  const chatId = msg.chat.id;

  if (!supabase.isConfigured()) {
    await bot.sendMessage(chatId, '⚠️ Supabase not configured. Cannot check today posts.');
    return;
  }

  try {
    const result = await checkTodayPosts(
      async (cid, text, opts) => {
        await bot.sendMessage(cid, text, opts);
      },
      async (cid, url, opts) => {
        await bot.sendPhoto(cid, url, opts);
      },
      chatId
    );

    if (result.sent === 0 && result.failed === 0 && (result.skipped || 0) === 0) {
      await bot.sendMessage(chatId, '✅ No pending posts for today.');
    } else {
      await bot.sendMessage(chatId,
`📋 *Check Today Complete*\n\n${result.sent} reminder(s) sent, ${result.failed} failed, ${result.skipped || 0} skipped (no target chat).`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error('/check_today error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error checking today posts. Please try again.'));
  }
});

// ============================================
// M-3: /generate_content — Batch copy generation
// ============================================

/**
 * Shared batch content generation logic.
 * Called both by the /generate_content command and auto-triggered after M-2 month approval.
 */
async function batchGenerateContent(chatId, planId) {
  if (!supabase.isConfigured()) {
    await bot.sendMessage(chatId, '⚠️ Supabase not configured. Cannot generate content.');
    return;
  }

  const allRows = await supabase.listContentCalendarByPlanId(planId);
  const approvedRows = allRows.filter(r => r.status === 'plan_approved');

  if (approvedRows.length === 0) {
    await bot.sendMessage(chatId, '⚠️ No posts with "plan_approved" status found for this plan. Approve the plan first with ✅ Approve this month.');
    return;
  }

  const total = approvedRows.length;
  let successCount = 0;
  let failCount = 0;
  const results = [];

  await bot.sendMessage(chatId, `⏳ Generating content for ${total} posts... This will take a moment.`);

  for (let i = 0; i < approvedRows.length; i++) {
    const row = approvedRows[i];
    try {
      const prompt = buildCopywritingPrompt(row.topic, row.pillar);
      const raw = await callOpenRouter([
        { role: 'system', content: prompt },
        { role: 'user', content: `Generate social media content for this Fanz topic: "${row.topic}". Pillar: ${row.pillar}.` },
      ]);
      const parsed = parseCopywritingResponse(raw);
      if (!parsed) throw new Error('Failed to parse copywriting response');

      const validation = validateCopywritingResult(parsed);
      if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join('; ')}`);

      await supabase.updateContentCalendar(row.id, {
        fb_content: parsed.fb_content,
        ig_content: parsed.ig_content,
        hashtags: parsed.hashtags,
        status: 'copy_done',
      });
      successCount++;
      results.push({ id: row.id, topic: row.topic, success: true });
      await bot.sendMessage(chatId, `✅ ${i+1}/${total}: ${row.topic}`);
    } catch (err) {
      console.error(`batchGenerateContent: row ${row.id} failed:`, err.message);
      failCount++;
      results.push({ id: row.id, topic: row.topic, success: false, error: err.message });
      await bot.sendMessage(chatId, `❌ ${i+1}/${total}: ${row.topic} — Generation failed.`);
    }
  }

  // Summary
  const summary = successCount > 0
    ? `✅ *Generation Complete!* ${successCount}/${total} posts generated, ${failCount} failed.\n\nUse /review_content ${planId} to review all generated content.`
    : `❌ *Generation Failed.* All ${total} posts failed. Please check the errors above and try again.`;

  await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
}

bot.onText(/^\/generate_content\s+(.+)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const planId = match[1].trim();
  try {
    await batchGenerateContent(chatId, planId);
  } catch (err) {
    console.error('/generate_content error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating batch content. Please try again.'));
  }
});

// ============================================
// M-4: /review_content — Batch copy review
// ============================================
bot.onText(/^\/review_content\s+(.+)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const planId = match[1].trim();

  if (!supabase.isConfigured()) {
    await bot.sendMessage(chatId, '⚠️ Supabase not configured.');
    return;
  }

  try {
    await sendBatchReviewMessage(chatId, planId);
  } catch (err) {
    console.error('/review_content error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error loading batch review. Please try again.'));
  }
});

async function sendBatchReviewMessage(chatId, planId) {
  const rows = await supabase.listContentCalendarByPlanId(planId);
  const reviewRows = rows.filter(r => r.status === 'copy_done' || r.status === 'copy_approved');

  if (reviewRows.length === 0) {
    await bot.sendMessage(chatId, '⚠️ No posts ready for review. Generate content first with /generate_content {planId}.');
    return;
  }

  const approved = reviewRows.filter(r => r.status === 'copy_approved').length;
  const pending = reviewRows.length - approved;

  let output = `📝 *Batch Copy Review*\n\n`;
  output += `Progress: ${approved} approved, ${pending} pending\n\n`;

  // Build inline keyboard
  const keyboard = [];
  for (const row of reviewRows) {
    const statusBadge = row.status === 'copy_approved' ? '✅' : '⏳';
    const shortTopic = (row.topic || '').length > 35
      ? (row.topic || '').slice(0, 32) + '...'
      : (row.topic || '');
    const preview = (row.fb_content || '').slice(0, 60).replace(/\n/g, ' ');
    const label = `${statusBadge} ${shortTopic}`;

    if (row.status === 'copy_approved') {
      keyboard.push([{ text: `✅ ${shortTopic} — Approved`, callback_data: cb('bn',row.id) }]);
    } else {
      // Store planId in batchActionMap so callback_data stays under 64-byte limit
      batchActionMap.set(row.id, planId);
      keyboard.push([
        { text: `✅ Approve: ${shortTopic}`, callback_data: cb('ba',row.id) },
        { text: `✏️ Reject`, callback_data: cb('br',row.id) },
      ]);
    }
  }

  if (pending > 0) {
    keyboard.push([{ text: `✅ Approve All Remaining (${pending})`, callback_data: cb('baa',planId) }]);
  }

  // Split message if too long
  const msgLen = output.length;
  if (msgLen > 3000) {
    // Send a truncated version with the keyboard
    const truncated = output.slice(0, 2000) + `\n... (${reviewRows.length} posts)`;
    await bot.sendMessage(chatId, truncated, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
  } else {
    await bot.sendMessage(chatId, output, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
  }
}

// /product
bot.onText(/^\/product\b(.*)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const brief = match[1] ? match[1].trim() : '';
  await bot.sendMessage(chatId, '⏳ Generating product promotion content...');
  try {
    const content = await generateContent('product', brief);
    await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('product error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating content. Please try again.'));
  }
});

// /case
bot.onText(/^\/case\b(.*)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const details = match[1] ? match[1].trim() : '';
  await bot.sendMessage(chatId, '⏳ Generating case study content...');
  try {
    const content = await generateContent('case', details);
    await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('case error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating case study. Please try again.'));
  }
});

// /promo
bot.onText(/^\/promo\b(.*)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const details = match[1] ? match[1].trim() : '';
  await bot.sendMessage(chatId, '⏳ Generating promotion content...');
  try {
    const content = await generateContent('promo', details);
    await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('promo error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating promotion content. Please try again.'));
  }
});

// /story
bot.onText(/^\/story\b(.*)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const context = match[1] ? match[1].trim() : '';
  await bot.sendMessage(chatId, '⏳ Generating brand story content...');
  try {
    const content = await generateContent('story', context);
    await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('story error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating brand story. Please try again.'));
  }
});

// ============================================
// TEXT MESSAGE HANDLER
// ============================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;

  // If user is awaiting image upload, handle the photo even for non-text messages
  if (!text) {
    if (photo && awaitingImageUpload.has(chatId)) {
      // Handled below — continue to the photo upload section
    } else {
      return; // Skip other non-text messages
    }
  }

  // === PLAN SELECTION INTERCEPT ===
  if (/^[1-9]\d{0,2}$/.test(text) && getPlanSession(chatId)) {
    const session = getPlanSession(chatId);
    const validation = validateSelection(session, text);

    if (!validation.valid) {
      await bot.sendMessage(chatId, validation.message);
      return;
    }

    const { number: num, plan } = validation;

    // Prevent double-click: clear session immediately after extracting plan
    clearPlanSession(chatId);

    // Step 1: Generate content FIRST (fail early — no DB side effects)
    let content;
    try {
      content = await generateContent(
        plan.direction,
        (plan.title || '') + ' — ' + (plan.description || '')
      );
    } catch (err) {
      console.error('plan selection content error:', err);
      await bot.sendMessage(chatId, userMessage(err, 'Failed to generate content. Please try again.'));
      return;
    }

    // Step 2: Persist the selection to content_calendar
    let createdRow = null;
    if (supabase.isConfigured()) {
      try {
        createdRow = await supabase.createContentCalendar(createSelectionPayload(plan, chatId));
      } catch (err) {
        console.error('createContentCalendar error:', err);
        // Don't block content delivery — user already has the content
        await bot.sendMessage(chatId, `⚠️ Content generated but could not save to database. The post is not scheduled.`);
      }
    } else {
      console.warn('Supabase not configured — skipping content_calendar write for plan selection');
    }

    // Step 2b: Copywriting pipeline — generate FB/IG/hashtags and persist to the row.
    // Falls through silently on failure; the user still receives the generateContent output.
    if (createdRow && createdRow.id) {
      try {
        const copywritingPrompt = buildCopywritingPrompt(plan.title, plan.direction);
        const copyRaw = await callOpenRouter([
          { role: 'system', content: copywritingPrompt },
          { role: 'user', content: `Generate social media content for this Fanz topic.` },
        ]);
        const parsed = parseCopywritingResponse(copyRaw);
        if (!parsed) {
          console.warn('copywriting parse returned null — falling back to generateContent only');
        } else {
          const validation = validateCopywritingResult(parsed);
          if (validation.valid) {
            await supabase.updateContentCalendar(createdRow.id, {
              fb_content: parsed.fb_content,
              ig_content: parsed.ig_content,
              hashtags: parsed.hashtags,
              status: 'copy_done',
            });

            // Step 2c: Review node — transition copy_done → pending_review and
            // post the review card with inline Approve / Request Changes buttons.
            // Send review card FIRST, then update status. If sendMessage fails,
            // row stays at copy_done — no orphaned pending_review row.
            try {
              const reviewMsg = buildReviewMessage(parsed, plan);
              await bot.sendMessage(chatId, reviewMsg, {
                parse_mode: 'Markdown',
                reply_markup: buildReviewKeyboard(createdRow.id),
              });
              await supabase.updateContentCalendar(createdRow.id, { status: 'pending_review' });
            } catch (err) {
              console.error('review card send error:', err);
            }
          } else {
            console.warn(`copywriting validation failed (${validation.errors.join('; ')}) — falling back to generateContent only`);
          }
        }
      } catch (err) {
        console.error('copywriting pipeline error:', err);
        // Fall back silently — generateContent output still delivered below
      }
    }

    // Step 3: Clear session (idempotent — repeat same number = session expired)
    clearPlanSession(chatId);

    await bot.sendMessage(chatId, `✅ Selected: ${plan.title} (${plan.direction} direction)`);
    await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
    return;
  }

  // === REVIEW NOTES INTERCEPT ===
  // Runs after plan-selection so a stray digit reply still routes to plan selection
  // when both modes are active; runs before the / skip so a "/foo" typed as a note
  // is captured rather than swallowed as a command.
  if (awaitingReviewNotes.has(chatId)) {
    const { rowId } = awaitingReviewNotes.get(chatId);
    const trimmedText = (text || '').trim() || '(no specific notes)';
    try {
      await supabase.updateContentCalendar(rowId, buildRejectPayload(trimmedText));
      awaitingReviewNotes.delete(chatId);
      await bot.sendMessage(
        chatId,
        '✏️ Revision notes saved. The content has been moved back for revision.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Regenerate with Feedback', callback_data: cb('redo_copy',rowId) }],
            ],
          },
        }
      );
    } catch (err) {
      console.error('review notes save error:', err);
      awaitingReviewNotes.delete(chatId);
      await bot.sendMessage(chatId, userMessage(err, 'Failed to save revision notes. Please try again.'));
    }
    return;
  }

  // === BATCH REVIEW NOTES INTERCEPT ===
  // When user clicks "batch_reject" on a batch review card, they are prompted for revision notes.
  if (awaitingBatchReviewNotes.has(chatId)) {
    const { rowId, planId } = awaitingBatchReviewNotes.get(chatId);
    const trimmedText = (text || '').trim() || '(no specific notes)';
    try {
      // Set review_notes on the row; keep status as copy_done for regeneration
      await supabase.updateContentCalendar(rowId, { review_notes: trimmedText });
      awaitingBatchReviewNotes.delete(chatId);
      await bot.sendMessage(
        chatId,
        '✏️ Revision notes saved. You can regenerate this post with the feedback.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Regenerate with Feedback', callback_data: cb('brg',rowId) }],
            ],
          },
        }
      );
    } catch (err) {
      console.error('batch review notes save error:', err);
      awaitingBatchReviewNotes.delete(chatId);
      await bot.sendMessage(chatId, userMessage(err, 'Failed to save revision notes. Please try again.'));
    }
    return;
  }

  // === MONTHLY PLAN EDIT INTERCEPT ===
  // When user clicks "Edit" on a monthly plan post, they are prompted for new text.
  if (awaitingMonthEdits.has(chatId)) {
    const { planId, postId } = awaitingMonthEdits.get(chatId);
    const newTopic = (text || '').trim();
    if (!newTopic) {
      await bot.sendMessage(chatId, 'Please send a non-empty topic/angle for this post.');
      return;
    }
    try {
      await supabase.updateContentCalendar(postId, { topic: newTopic });
      awaitingMonthEdits.delete(chatId);
      await bot.sendMessage(chatId, '✅ Post updated! Reloading calendar...');
      // Reshow the updated calendar
      await reshowMonthCalendar(chatId, planId);
    } catch (err) {
      console.error('month edit save error:', err);
      awaitingMonthEdits.delete(chatId);
      await bot.sendMessage(chatId, userMessage(err, 'Failed to update post. Please try again.'));
    }
    return;
  }

  // === MONTHLY PLAN REMOVE INTERCEPT ===
  // When user clicks "Remove" and confirms with "Yes"
  if (awaitingMonthRemoves.has(chatId)) {
    const { planId, postId } = awaitingMonthRemoves.get(chatId);
    const trimmed = (text || '').trim().toLowerCase();
    if (trimmed === 'yes' || trimmed === 'y' || trimmed === 'confirm') {
      try {
        // Delete the calendar row (state machine doesn't allow planned→rejected, so delete instead)
        const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
        const delRes = await fetch(`${supabaseUrl}/rest/v1/content_calendar?id=eq.${encodeURIComponent(postId)}`, {
          method: 'DELETE',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (!delRes.ok) {
          throw new Error(`DELETE failed with HTTP ${delRes.status}: ${await delRes.text()}`);
        }
        // Decrement total_posts on the plan
        const plan = await supabasePlans.getContentPlan(planId);
        if (plan && typeof plan.total_posts === 'number') {
          await supabasePlans.updateContentPlan(planId, { total_posts: Math.max(0, plan.total_posts - 1) });
        }
        awaitingMonthRemoves.delete(chatId);
        await bot.sendMessage(chatId, '✅ Post removed from plan! Reloading calendar...');
        await reshowMonthCalendar(chatId, planId);
      } catch (err) {
        console.error('month remove error:', err);
        awaitingMonthRemoves.delete(chatId);
        await bot.sendMessage(chatId, userMessage(err, 'Failed to remove post. Please try again.'));
      }
    } else if (trimmed === 'no' || trimmed === 'n') {
      awaitingMonthRemoves.delete(chatId);
      await bot.sendMessage(chatId, '❌ Removal cancelled.');
    } else {
      await bot.sendMessage(chatId, 'Please reply with "Yes" to confirm removal or "No" to cancel.');
    }
    return;
  }

  // === IMAGE SCENE CHANGE INTERCEPT ===
  // When user clicks "Change Scene" on an image review card, they type a new scene description
  if (awaitingSceneChange.has(chatId)) {
    const { rowId } = awaitingSceneChange.get(chatId);
    const newScene = (text || '').trim();
    if (!newScene) {
      await bot.sendMessage(chatId, 'Please describe the new scene you would like (e.g., "a beachside patio at sunset").');
      return;
    }
    try {
      awaitingSceneChange.delete(chatId);
      await bot.sendMessage(chatId, `🎬 Changing scene to: "${newScene}" — regenerating image...`);

      // Read the row
      const row = await supabase.getContentCalendar(rowId);
      if (!row) {
        await bot.sendMessage(chatId, '❌ Row not found.');
        return;
      }

      // Call scene-gen with the custom scene description injected
      const { generateSceneImage } = require('./lib/scene-gen');
      const { PRODUCTS_DIR, selectProductImage, writeSourceProductImage } = require('./lib/select-product');

      const sourceImage = row.source_product_image || null;
      const customTopic = `${row.topic || ''} — ${newScene}`;

      const result = await generateSceneImage(
        rowId,
        customTopic,
        row.pillar || 'product',
        sourceImage,
        PRODUCTS_DIR
      );

      if (result.success) {
        await sendImageReviewCard(chatId, rowId, result.sceneImageUrl || '(scene)', 'generated', result.dryRun);
      } else {
        await sendTechnicalFailureNotice(chatId, rowId);
      }
    } catch (err) {
      console.error('scene change error:', err);
      awaitingSceneChange.delete(chatId);
      await bot.sendMessage(chatId, userMessage(err, 'Failed to change scene. Please try again.'));
    }
    return;
  }

  // === IMAGE UPLOAD INTERCEPT ===
  // Handle photo upload when user clicks "Upload Own"
  if (awaitingImageUpload.has(chatId) && photo) {
    const { rowId } = awaitingImageUpload.get(chatId);
    try {
      awaitingImageUpload.delete(chatId);
      await bot.sendMessage(chatId, '📤 Uploading your image...');

      // Get the largest photo (best quality)
      const largestPhoto = photo[photo.length - 1];
      const fileId = largestPhoto.file_id;

      // Download the photo via Telegram bot API
      const fileLink = await bot.getFileLink(fileId);
      const photoResp = await fetch(fileLink);
      if (!photoResp.ok) {
        throw new Error(`Failed to download photo: ${photoResp.status}`);
      }
      const photoBuffer = Buffer.from(await photoResp.arrayBuffer());

      // Save to local assets directory
      const assetsDir = path.join(__dirname, 'assets', 'user-uploads');
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }
      const filename = `user-upload-${rowId.slice(0, 8)}-${Date.now()}.jpg`;
      const filepath = path.join(assetsDir, filename);
      fs.writeFileSync(filepath, photoBuffer);

      // Try to upload to Supabase Storage, fallback to local path
      let imageUrl = filename;
      try {
        const { uploadFile, buildStoragePath } = require('./lib/store-image');
        const storagePath = buildStoragePath(rowId, '.jpg');
        const { publicUrl } = await uploadFile(filepath, storagePath);
        imageUrl = publicUrl;
      } catch (storageErr) {
        console.warn('Supabase Storage upload failed, using local path:', storageErr.message);
      }

      // Update the row: status=approved, image_source=user_uploaded
      await supabase.updateContentCalendar(rowId, {
        status: 'approved',
        image_url: imageUrl,
        image_source: 'user_uploaded',
      });

      await bot.sendMessage(chatId,
        `✅ Image uploaded successfully!\n\nThe post is now approved and ready to publish.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 Publish', callback_data: cb('publish_go',rowId) }],
            ],
          },
        }
      );
    } catch (err) {
      console.error('image upload error:', err);
      awaitingImageUpload.delete(chatId);
      await bot.sendMessage(chatId, userMessage(err, 'Failed to upload image. Please try again.'));
    }
    return;
  }

  // Skip commands (already handled above)
  if (text && text.startsWith('/')) return;

  // === FREE TEXT — ROUTE THROUGH INTENT CLASSIFIER ===
  try {
    const brandContext = buildProductContext();
    const classification = await classifyIntent(text, brandContext);

    switch (classification.intent) {
      case 'chitchat':
      case 'greeting':
        // Consultant-style friendly response
        await bot.sendMessage(chatId, classification.response || 'Hi! How can I help you with your Fanz marketing today?');
        break;

      case 'plan_month':
        // Trigger the monthly planning flow (same as /plan_month command)
        await bot.sendMessage(chatId, '📅 Starting monthly content planning...');
        // Simulate the /plan_month command by running the handler logic inline.
        // We create a mock msg object and invoke the same code path.
        {
          const mockMatch = [null, '']; // match[1] = optional month input
          const target = require('./lib/monthly-planning').parseTargetMonth(null);
          const targetMonthStr = target.monthStr;

          await bot.sendMessage(chatId, `📅 Generating monthly content plan for *${targetMonthStr}*...\nThis will take a moment.`, { parse_mode: 'Markdown' });

          const systemPrompt = require('./lib/monthly-planning').buildMonthlySystemPrompt(targetMonthStr);
          const userPrompt = `Generate a full-month content calendar for ${targetMonthStr} with exactly 12 regular posts (4 product, 3 case, 2 educational, 2 story, 1 promo) plus 0-2 festival posts. Ensure all product series are featured.`;

          const rawResponse = await callOpenRouter([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ], 4000);

          const { parseAndValidateMonthlyPlan, mapPillarForDB } = require('./lib/monthly-plan-parser');
          const parsed = parseAndValidateMonthlyPlan(rawResponse, targetMonthStr);

          if (!parsed.valid || parsed.posts.length < 8) {
            let detail = '';
            if (parsed.errors.length > 0) {
              detail += '\n' + parsed.errors.slice(0, 10).map(e => '• ' + e).join('\n');
            }
            if (parsed.warnings && parsed.warnings.length > 0) {
              detail += '\n\n⚠️ Notes:\n' + parsed.warnings.slice(0, 15).map(w => '• ' + w).join('\n');
            }
            await bot.sendMessage(chatId,
              `⚠️ The AI response did not produce a valid monthly plan.${detail}\n\nRaw response:\n\`\`\`\n${rawResponse.slice(0, 3000)}\n\`\`\``);
            break;
          }

          let planId = null;
          if (require('./lib/supabase').isConfigured()) {
            try {
              const planRow = await require('./lib/supabase-plans').createContentPlan({
                month: targetMonthStr,
                status: 'pending_approval',
                chat_id: String(chatId),
                total_posts: parsed.regularPosts.length + parsed.festivalPosts.length,
                notes: `Generated via intent router`,
              });
              planId = planRow.id;
            } catch (err) {
              console.error('content_plans creation error:', err);
              await bot.sendMessage(chatId, `⚠️ Monthly plan generated but could not save to database.`);
            }
          }

          const createdCalendarIds = [];
          if (planId && require('./lib/supabase').isConfigured()) {
            for (const post of parsed.posts) {
              try {
                const dbPillar = mapPillarForDB(post.pillar);
                const calRow = await require('./lib/supabase').createContentCalendar({
                  chat_id: String(chatId),
                  pillar: dbPillar,
                  topic: post.topic,
                  post_angle: post.post_angle,
                  suggested_date: post.suggested_date,
                  plan_id: planId,
                  status: 'planned',
                });
                createdCalendarIds.push(calRow.id);
              } catch (err) {
                console.error('createContentCalendar error:', err.message);
                createdCalendarIds.push(null);
              }
            }
          }

          const sortedPosts = [...parsed.posts].sort((a, b) => a.suggested_date.localeCompare(b.suggested_date));
          const weeks = [];
          let currentWeek = [];
          let currentWeekNum = null;

          for (const post of sortedPosts) {
            const d = new Date(post.suggested_date + 'T00:00:00+08:00');
            const startOfYear = new Date(d.getFullYear(), 0, 1);
            const weekNum = Math.ceil((((d - startOfYear) / 86400000) + startOfYear.getDay() + 1) / 7);
            if (currentWeekNum !== null && weekNum !== currentWeekNum) {
              weeks.push(currentWeek);
              currentWeek = [];
            }
            currentWeekNum = weekNum;
            currentWeek.push(post);
          }
          if (currentWeek.length > 0) weeks.push(currentWeek);

          let output = `📅 *Monthly Content Plan — ${targetMonthStr}*\n\n`;
          output += `*Pillar Breakdown:*\n`;
          for (const [p, count] of Object.entries(parsed.pillarCounts)) {
            if (p === 'festival') continue;
            output += `📝 ${p}: ${count}\n`;
          }
          if (parsed.festivalPosts.length > 0) {
            output += `🎊 festival: ${parsed.festivalPosts.length}\n`;
          }
          output += `\n`;

          for (const week of weeks) {
            output += `━━━ *Week* ━━━\n`;
            for (const post of week) {
              const dateFormatted = post.suggested_date.replace(/^\d{4}-/, '');
              output += `${dateFormatted} 📝 *${post.topic}*\n`;
              output += `   _${post.pillar}_ — ${post.post_angle}\n\n`;
            }
          }
          output += `✅ *${parsed.regularPosts.length} regular posts + ${parsed.festivalPosts.length} festival posts generated*`;

          const keyboardRows = [];
          if (planId && createdCalendarIds.length > 0) {
            for (let i = 0; i < sortedPosts.length; i++) {
              const post = sortedPosts[i];
              const calId = createdCalendarIds[i];
              if (!calId) continue;
              const shortTopic = post.topic.length > 30 ? post.topic.slice(0, 27) + '...' : post.topic;
              monthActionMap.set(calId, planId);
              keyboardRows.push([
                { text: `✏️ ${shortTopic}`, callback_data: cb('me',calId) },
                { text: `❌ Remove`, callback_data: cb('mr',calId) },
                { text: `🔄 Replace`, callback_data: cb('mrp',calId) },
              ]);
            }
            keyboardRows.push(
              [{ text: '✅ Approve this month', callback_data: cb('ma',planId) }]
            );
          }

          await bot.sendMessage(chatId, output, {
            parse_mode: 'Markdown',
            reply_markup: planId ? { inline_keyboard: keyboardRows } : undefined,
          });
        }
        break;

      case 'generate_post':
        // Generate content with detected pillar and topic
        {
          const pillar = classification.params && classification.params.pillar ? classification.params.pillar : 'product';
          const topic = classification.params && classification.params.topic ? classification.params.topic : text;
          await bot.sendMessage(chatId, `⏳ Generating ${pillar} post based on your request...`);
          const content = await generateContent(pillar, topic);
          await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
        }
        break;

      case 'ask_question':
        // Answer as marketing consultant
        {
          const answer = classification.response || 
            (classification.params && classification.params.question 
              ? `Great question about "${classification.params.question}"! Let me help with that.`
              : 'Thanks for your question!');
          await bot.sendMessage(chatId, answer);
        }
        break;

      case 'unclear':
      default:
        // Ask clarifying question using the response field
        await bot.sendMessage(chatId, classification.response || 
          'I\'m not sure what you need. I can help with:\n\n📅 Monthly content planning\n✍️ Writing social media posts\n💡 Marketing advice & product questions\n\nWhat would you like?');
        break;
    }
  } catch (err) {
    console.error('intent router error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Sorry, I had trouble processing your message. Please try again or use a command like /product or /plan.'));
  }
});

// ============================================
// IMAGE EDITING (GPT Image 2 via OpenAI images.edit)
// ============================================

// Call GPT Image 2 for image-to-image editing
async function gptImage2Edit(prompt) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured. Please set this environment variable.');
  }

  if (!fs.existsSync(PRODUCT_IMAGE)) {
    throw new Error(`Product image not found at ${PRODUCT_IMAGE}. Please place a Fanz product image there.`);
  }

  const OpenAI = require('openai');
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const imageBuffer = fs.readFileSync(PRODUCT_IMAGE);
  const mimeType = PRODUCT_IMAGE.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const imageFile = new File([imageBuffer], 'product-image.png', { type: mimeType });

  const response = await openai.images.edit({
    model: 'gpt-image-2',
    image: imageFile,
    prompt: prompt,
    size: '1024x1024',
    quality: process.env.GPT_IMAGE_QUALITY || 'medium',
    n: 1,
  });

  if (!response.data || response.data.length === 0) {
    throw new Error('GPT Image 2 returned no data');
  }

  const firstResult = response.data[0];
  if (firstResult.b64_json) {
    return {
      data: Buffer.from(firstResult.b64_json, 'base64'),
      mimeType: 'image/png',
    };
  } else if (firstResult.url) {
    const imgResp = await fetch(firstResult.url);
    if (!imgResp.ok) {
      throw new Error(`Failed to download generated image: ${imgResp.status}`);
    }
    return {
      data: Buffer.from(await imgResp.arrayBuffer()),
      mimeType: 'image/png',
    };
  }

  throw new Error('GPT Image 2 response did not contain an image.');
}

// /image command — generate product-in-scene image
bot.onText(/^\/image\b(.*)/is, async (msg, match) => {
  const chatId = msg.chat.id;
  const theme = (match[1] || '').trim() || 'modern living room';

  const prompt = `Put this ceiling fan into a ${theme} scene. Keep the ceiling fan itself visually unchanged — do not alter its shape, blades, or design. Only change the background environment. The result should be photorealistic, as if the fan was photographed installed in that setting.`;

  // Send typing indicator
  bot.sendChatAction(chatId, 'upload_photo');

  // Send initial status
  const statusMsg = await bot.sendMessage(chatId, `⏳ Generating image — putting fan in "${theme}" scene...`);

  try {
    const result = await gptImage2Edit(prompt);

    // Send the generated photo to Telegram
    await bot.sendPhoto(chatId, result.data, {
      caption: `🎨 "${theme}" — Fanz product in scene\n✅ Generated via GPT Image 2`,
    });

    // Delete status message
    await bot.deleteMessage(chatId, statusMsg.message_id);

  } catch (err) {
    console.error('image error:', err);
    await bot.sendMessage(
      chatId,
      userMessage(err, 'Image generation failed. Check your API key and try again.')
    );
  }
});

// ============================================
// CALLBACK QUERY HANDLERS
// ============================================
bot.on('callback_query', async (cb) => {
  const data = (cb && cb.data) || '';
  const message = cb && cb.message;
  const chatId = message && message.chat && message.chat.id;
  const messageId = message && message.message_id;

  if (data.startsWith('review_approve:')) {
    const rowId = data.slice('review_approve:'.length);
    try {
      // Step 2d: Copy approved → copy_approved (not 'approved' anymore — imagery phase follows)
      await supabase.updateContentCalendar(rowId, { status: 'copy_approved' });
      await bot.answerCallbackQuery(cb.id, { text: '✅ Copy approved — generating imagery...' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n✅ Copy Approved\n⏳ Generating imagery...', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });

      // Trigger imagery pipeline (I-2 → I-3 → I-4) via orchestrator
      if (supabase.isConfigured()) {
        const row = await supabase.getContentCalendar(rowId);
        if (row) {
          // Festival post handling: if pillar='story' and contains festival keywords,
          // skip product scene generation and use a festive design
          if (isFestivalPost(row)) {
            const festiveScene = getFestiveSceneDescription(row);
            console.log(`Festival post detected for row ${rowId}: "${festiveScene}" — using festive design`);
            // Use scene-gen directly with the festive scene as the topic
            const { generateSceneImage } = require('./lib/scene-gen');
            const { PRODUCTS_DIR } = require('./lib/select-product');

            const sourceImage = row.source_product_image || null;
            generateSceneImage(
              rowId,
              festiveScene,
              'story',
              sourceImage,
              PRODUCTS_DIR
            ).then(async (sceneResult) => {
              if (sceneResult.success) {
                console.log(`festival imagery: success for row ${rowId} — ${sceneResult.sceneImageUrl}`);
                await sendImageReviewCard(chatId, rowId, sceneResult.sceneImageUrl || '(festive)', 'generated', sceneResult.dryRun);
              } else {
                console.error(`festival imagery: failed for row ${rowId} — ${sceneResult.error}`);
                await sendTechnicalFailureNotice(chatId, rowId);
              }
            }).catch(async (err) => {
              console.error(`festival imagery: uncaught error for row ${rowId}:`, err.message);
              await sendTechnicalFailureNotice(chatId, rowId);
            });
          } else {
            // Standard imagery pipeline
            const { runImageryPipeline } = require('./lib/pipeline');
            runImageryPipeline(rowId).then(async (result) => {
              if (result.success) {
                if (result.isDryRun) {
                  console.log(`imagery-pipeline: dry-run for row ${rowId} — ${result.imageUrl}`);
                  await sendImageReviewCard(chatId, rowId, result.imageUrl || '(dry-run)', 'generated', true);
                } else {
                  console.log(`imagery-pipeline: success for row ${rowId} — ${result.imageUrl}`);
                  await sendImageReviewCard(chatId, rowId, result.imageUrl, 'generated');
                }
              } else {
                console.error(`imagery-pipeline: failed for row ${rowId} — ${result.error}`);
                await sendTechnicalFailureNotice(chatId, rowId);
              }
            }).catch(async (err) => {
              console.error(`imagery-pipeline: uncaught error for row ${rowId}:`, err.message);
              await sendTechnicalFailureNotice(chatId, rowId);
            });
          }
        }
      }
    } catch (err) {
      console.error('approve callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  if (data.startsWith('review_reject:')) {
    const rowId = data.slice('review_reject:'.length);
    try {
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n✏️ Please send your revision notes below:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
      awaitingReviewNotes.set(chatId, { rowId, reviewMsgId: messageId });
      await bot.answerCallbackQuery(cb.id, { text: 'Please send revision notes' });
    } catch (err) {
      console.error('reject callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // ma:planId — approve a monthly plan
  if (data.startsWith('ma:')) {
    const planId = data.slice('ma:'.length);
    try {
      // Update the content_plans row status from pending_approval to plan_approved
      await supabasePlans.updateContentPlan(planId, { status: 'plan_approved' });

      // Update all content_calendar rows linked to this plan from planned to plan_approved
      const calRows = await supabase.listContentCalendarByPlanId(planId);
      let failedCount = 0;
      let successCount = 0;
      for (const row of (calRows || [])) {
        if (row.status === 'rejected') continue; // Skip rejected rows
        try {
          await supabase.updateContentCalendar(row.id, { status: 'plan_approved' });
          successCount++;
        } catch (err) {
          console.error(`month_approve: failed to update calendar row ${row.id}:`, err.message);
          failedCount++;
        }
      }

      await bot.answerCallbackQuery(cb.id, { text: '✅ Monthly plan approved! Generating content...' });
      const originalText = (message && message.text) || '';
      const statusLine = failedCount > 0
        ? `\n\n✅ *Plan Approved!* ${successCount} posts approved, ${failedCount} failed. Starting batch content generation...`
        : `\n\n✅ *Plan Approved!* All ${successCount} posts approved. Starting batch content generation...`;
      await bot.editMessageText(originalText + statusLine, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] },
      });

      // Auto-trigger M-3: batch content generation for all approved posts
      await batchGenerateContent(chatId, planId);
    } catch (err) {
      console.error('month_approve callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // me:calId — Edit topic/angle
  if (data.startsWith('me:')) {
    const calId = data.slice('me:'.length);
    const planId = await resolvePlanId(monthActionMap, calId);
    try {
      awaitingMonthEdits.set(chatId, { planId, postId: calId });
      await bot.answerCallbackQuery(cb.id, { text: 'Send the new topic/angle' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n✏️ Send the new topic/angle for this post:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      console.error('month_edit_topic callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed.' });
      } catch (_) {}
    }
    return;
  }

  // mr:postId — Remove post from plan
  if (data.startsWith('mr:')) {
    const postId = data.slice('mr:'.length);
    const planId = await resolvePlanId(monthActionMap, postId);
    try {
      // Read the post for confirmation context
      const row = await supabase.getContentCalendar(postId);
      const topic = row ? row.topic || 'this post' : 'this post';
      awaitingMonthRemoves.set(chatId, { planId, postId });
      await bot.answerCallbackQuery(cb.id, { text: 'Confirm removal?' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + `\n\n❓ Remove *${topic}* from the plan? Reply "Yes" to confirm, "No" to cancel.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      console.error('month_remove callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed.' });
      } catch (_) {}
    }
    return;
  }

  // mrp:calId — Regenerate a single post
  if (data.startsWith('mrp:')) {
    const calId = data.slice('mrp:'.length);
    const planId = await resolvePlanId(monthActionMap, calId);
    const postId = calId;
    try {
      await bot.answerCallbackQuery(cb.id, { text: 'Regenerating post...' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n⏳ Regenerating this post...', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });

      // Read the current row
      const row = await supabase.getContentCalendar(postId);
      if (!row) {
        await bot.sendMessage(chatId, '❌ Post not found.');
        return;
      }

      // Read the plan for context
      const plan = await supabasePlans.getContentPlan(planId);
      const targetMonthStr = plan ? plan.month : 'this month';

      // Call LLM to regenerate just this one post
      const regeneratePrompt = `You are a social media content strategist for Fanz Sdn Bhd, a Malaysian ceiling fan brand.

Generate a single social media post for ${targetMonthStr}.

The current post needs a fresh topic and angle. Here's the context:
- Current pillar: ${row.pillar || 'product'}
- Current topic: ${row.topic || '(none)'}

Requirements:
- Return ONLY valid JSON (no markdown, no explanation)
- Format: { "topic": "Catchy post title", "post_angle": "One-sentence angle explanation", "pillar": "${row.pillar || 'product'}", "suggested_date": "${row.suggested_date || ''}" }
- The topic should be 5-12 words, catchy and engaging
- The post_angle should explain the creative angle
- Keep the same pillar: ${row.pillar || 'product'}
- Keep the same suggested_date: ${row.suggested_date || ''}
- Must mention Fanz brand identity (Malaysian ceiling fan brand, 10-year motor warranty, SIRIM certified, DC motor technology)`;

      const messages = [
        { role: 'system', content: regeneratePrompt },
        { role: 'user', content: `Generate a fresh ${row.pillar || 'product'} post for Fanz.` },
      ];

      const rawResponse = await callOpenRouter(messages);

      // Parse the response
      let replaced;
      try {
        const cleaned = rawResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        replaced = JSON.parse(cleaned);
      } catch (e) {
        const arrayMatch = rawResponse.match(/\{.*\}/s);
        if (arrayMatch) {
          try {
            replaced = JSON.parse(arrayMatch[0]);
          } catch (e2) {
            throw new Error(`Failed to parse replacement JSON: ${e2.message}`);
          }
        } else {
          throw new Error('No valid JSON in replacement response');
        }
      }

      // Update the calendar row with new topic/angle
      await supabase.updateContentCalendar(postId, {
        topic: replaced.topic || replaced.title || '(new topic)',
        post_angle: replaced.post_angle || replaced.angle || '',
      });

      await bot.sendMessage(chatId, `✅ Post regenerated: *${replaced.topic || '(new topic)'}*`, {
        parse_mode: 'Markdown',
      });
      // Reshow the updated calendar
      await reshowMonthCalendar(chatId, planId);
    } catch (err) {
      console.error('month_replace callback error:', err);
      await bot.sendMessage(chatId, userMessage(err, 'Failed to regenerate post. Please try again.'));
    }
    return;
  }

  // publish_go:rowId — Publish content
  if (data.startsWith('publish_go:')) {
    const rowId = data.slice('publish_go:'.length);
    try {
      // Read current row
      const row = await supabase.getContentCalendar(rowId);
      if (!row) {
        await bot.answerCallbackQuery(cb.id, { text: 'Row not found.' });
        return;
      }
      // Idempotency check: already published?
      const chartIds = [];
      if (row.fb_post_id) chartIds.push('FB: ' + row.fb_post_id);
      if (row.ig_post_id) chartIds.push('IG: ' + row.ig_post_id);
      if (chartIds.length > 0) {
        await bot.answerCallbackQuery(cb.id, { text: 'Already published: ' + chartIds.join(', ') });
        return;
      }
      // Status check
      if (row.status !== 'approved') {
        await bot.answerCallbackQuery(cb.id, { text: 'Cannot publish — status is "' + row.status + '"' });
        return;
      }
      // Execute publish
      const result = await publishToSocial(row);
      // Update DB — write fb_post_id + ig_post_id separately (table has no single post_id column)
      await supabase.updateContentCalendar(rowId, {
        fb_post_id: result.fb_post_id,
        ig_post_id: result.ig_post_id,
        status: 'published',
      });
      // Edit message
      const originalText = (message && message.text) || '';
      const publishedRefs = [];
      if (result.fb_post_id) publishedRefs.push('FB: `' + result.fb_post_id + '`');
      if (result.ig_post_id) publishedRefs.push('IG: `' + result.ig_post_id + '`');
      const suffix = result.dry_run
        ? '\n\n🚀 Published (dry-run: ' + publishedRefs.join(', ') + ')'
        : '\n\n🚀 Published: ' + publishedRefs.join(', ');
      await bot.editMessageText(originalText + suffix, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
      await bot.answerCallbackQuery(cb.id, { text: result.dry_run ? 'Published (dry-run)' : 'Published!' });
    } catch (err) {
      console.error('publish callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Publish failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // ============================================
  // IMAGE REVIEW CALLBACKS
  // ============================================

  // image_approve:rowId — approve imagery, move to 'approved' (all gates passed)
  if (data.startsWith('image_approve:')) {
    const rowId = data.slice('image_approve:'.length);
    try {
      await supabase.updateContentCalendar(rowId, { status: 'approved' });
      await bot.answerCallbackQuery(cb.id, { text: '✅ Image approved — ready to publish!' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n✅ Image Approved\n🚀 Ready to publish!', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Publish', callback_data: cb('publish_go',rowId) }],
          ],
        },
      });
    } catch (err) {
      console.error('image_approve callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // image_reject:rowId:count — reject imagery, move to image_retry for regeneration
  if (data.startsWith('image_reject:')) {
    const parts = data.split(':');
    const rowId = parts[1];
    const currentCount = parseInt(parts[2] || '0', 10);
    const nextCount = currentCount + 1;

    try {
      if (nextCount >= 3) {
        // Max retries reached — show skip button alongside retry
        await supabase.updateContentCalendar(rowId, { status: 'image_retry' });
        await bot.answerCallbackQuery(cb.id, { text: `Rejected (${nextCount}/3). Image can be regenerated or skipped.` });
        const originalText = (message && message.text) || '';
        await bot.editMessageText(originalText + `\n\n✏️ Image Rejected (${nextCount}/3)\n🔄 Regenerate or ⏭️ Skip image to publish copy-only`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 Regenerate', callback_data: cb('image_retry_go',rowId,nextCount) },
                { text: '⏭️ Skip Image', callback_data: cb('image_skip',rowId) },
              ],
            ],
          },
        });
      } else {
        // Under retry limit — auto-regenerate
        await supabase.updateContentCalendar(rowId, { status: 'image_retry' });
        await bot.answerCallbackQuery(cb.id, { text: `Rejected (${nextCount}/3). Regenerating...` });
        const originalText = (message && message.text) || '';
        await bot.editMessageText(originalText + `\n\n✏️ Image Rejected (${nextCount}/3)\n⏳ Regenerating...`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        });

        // Trigger re-generation
        triggerImageRegeneration(rowId, chatId, nextCount);
      }
    } catch (err) {
      console.error('image_reject callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // image_retry_go:rowId:count — manual retry of image generation
  if (data.startsWith('image_retry_go:')) {
    const parts = data.split(':');
    const rowId = parts[1];
    const count = parseInt(parts[2] || '0', 10);
    try {
      await bot.answerCallbackQuery(cb.id, { text: 'Regenerating image...' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n⏳ Regenerating image...', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
      triggerImageRegeneration(rowId, chatId, count);
    } catch (err) {
      console.error('image_retry_go error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // image_skip:rowId — skip imagery entirely, publish copy-only
  if (data.startsWith('image_skip:')) {
    const rowId = data.slice('image_skip:'.length);
    try {
      await supabase.updateContentCalendar(rowId, { status: 'approved' });
      await bot.answerCallbackQuery(cb.id, { text: 'Image skipped. Ready to publish copy-only!' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n⏭️ Image Skipped\n📝 Publishing copy-only\n🚀 Ready to publish!', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Publish', callback_data: cb('publish_go',rowId) }],
          ],
        },
      });
    } catch (err) {
      console.error('image_skip callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // image_retry:rowId:count — regenerate image with same parameters
  if (data.startsWith('image_retry:')) {
    const parts = data.split(':');
    const rowId = parts[1];
    const count = parseInt(parts[2] || '0', 10);
    try {
      await supabase.updateContentCalendar(rowId, { status: 'image_retry' });
      await bot.answerCallbackQuery(cb.id, { text: 'Regenerating image...' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n⏳ Regenerating image...', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
      triggerImageRegeneration(rowId, chatId, count + 1);
    } catch (err) {
      console.error('image_retry callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // image_change_scene:rowId:count — user wants to change the scene description
  if (data.startsWith('image_change_scene:')) {
    const parts = data.split(':');
    const rowId = parts[1];
    try {
      awaitingSceneChange.set(chatId, { rowId });
      await bot.answerCallbackQuery(cb.id, { text: 'Please describe the new scene' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n🎬 Please describe the new scene you want (e.g., "a beachside villa at sunset"):', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      console.error('image_change_scene callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed.' });
      } catch (_) {}
    }
    return;
  }

  // image_change_product:rowId:count — cycle to next product image and regenerate
  if (data.startsWith('image_change_product:')) {
    const parts = data.split(':');
    const rowId = parts[1];
    const count = parseInt(parts[2] || '0', 10);
    try {
      await supabase.updateContentCalendar(rowId, { status: 'image_retry' });
      await bot.answerCallbackQuery(cb.id, { text: 'Switching product image and regenerating...' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n🔄 Switching product image and regenerating...', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });

      // Read current row
      const row = await supabase.getContentCalendar(rowId);
      if (!row) {
        await bot.sendMessage(chatId, '❌ Row not found.');
        return;
      }

      // Get all product images and cycle to the next one
      const { listProductImages, writeSourceProductImage } = require('./lib/select-product');
      const allImages = listProductImages();
      const currentImage = row.source_product_image || '';
      let nextIndex = 0;
      for (let i = 0; i < allImages.length; i++) {
        if (allImages[i].filename === currentImage) {
          nextIndex = (i + 1) % allImages.length;
          break;
        }
      }
      const nextImage = allImages[nextIndex].filename;

      // Write the new source_product_image
      await writeSourceProductImage(rowId, nextImage);

      // Regenerate with new product image
      triggerImageRegeneration(rowId, chatId, count + 1);
    } catch (err) {
      console.error('image_change_product callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // image_upload_own:rowId — user wants to upload their own image
  if (data.startsWith('image_upload_own:')) {
    const rowId = data.slice('image_upload_own:'.length);
    try {
      awaitingImageUpload.set(chatId, { rowId });
      await bot.answerCallbackQuery(cb.id, { text: 'Please send your own image' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n📤 Please send your own image as a photo message. It will be used for this post.', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      console.error('image_upload_own callback error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed.' });
      } catch (_) {}
    }
    return;
  }

  // redo_copy:rowId — regenerate content with feedback
  if (data.startsWith('redo_copy:')) {
    const rowId = data.slice('redo_copy:'.length);
    try {
      await bot.answerCallbackQuery(cb.id, { text: 'Regenerating...' });

      const row = await supabase.getContentCalendar(rowId);
      if (!row) {
        await bot.answerCallbackQuery(cb.id, { text: 'Row not found.' });
        return;
      }

      const topic = row.topic || 'Fanz ceiling fan promotion';
      const pillar = row.pillar || 'product';
      const reviewNotes = (row.review_notes || '').trim() || null;

      const copywritingPrompt = buildCopywritingPrompt(topic, pillar, reviewNotes);
      const copyRaw = await callOpenRouter([
        { role: 'system', content: copywritingPrompt },
        { role: 'user', content: 'Generate social media content for this Fanz topic, incorporating the revision feedback.' },
      ]);

      const parsed = parseCopywritingResponse(copyRaw);
      if (!parsed) {
        throw new Error('Failed to parse copywriting response');
      }

      const validation = validateCopywritingResult(parsed);
      if (!validation.valid) {
        throw new Error(`Copywriting validation failed: ${validation.errors.join('; ')}`);
      }

      await supabase.updateContentCalendar(rowId, {
        fb_content: parsed.fb_content,
        ig_content: parsed.ig_content,
        hashtags: parsed.hashtags,
        status: 'copy_done',
      });

      const plan = { title: topic, direction: pillar };
      const reviewMsg = buildReviewMessage(parsed, plan);

      try {
        await bot.sendMessage(message.chat.id, reviewMsg, {
          parse_mode: 'Markdown',
          reply_markup: buildReviewKeyboard(rowId),
        });
        await supabase.updateContentCalendar(rowId, { status: 'pending_review' });
      } catch (err) {
        console.error('redo_copy review card send error:', err);
      }

      await bot.editMessageText(
        (message.text || '') + '\n\n🔄 Content regenerated with feedback!',
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        }
      );
      await bot.answerCallbackQuery(cb.id, { text: 'Regenerated ✓' });
    } catch (err) {
      console.error('redo_copy error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Regeneration failed. Try again.' });
      } catch (_) {}
    }
    return;
  }

  // ============================================
  // M-4: Batch copy review callbacks
  // ============================================

  // bn:rowId — no-op for already-approved row in batch review
  if (data.startsWith('bn:')) {
    await bot.answerCallbackQuery(cb.id, { text: 'Already approved.' });
    return;
  }

  // mp:rowId — Mark as Published (from the daily reminder card, M-7)
  if (data.startsWith('mp:')) {
    const rowId = data.slice('mp:'.length);
    try {
      const row = await supabase.getContentCalendar(rowId);
      if (!row) {
        await bot.answerCallbackQuery(cb.id, { text: 'Post not found.' });
        return;
      }
      if (row.status === 'published') {
        await bot.answerCallbackQuery(cb.id, { text: 'Already marked as published.' });
        return;
      }
      if (row.status !== 'approved') {
        await bot.answerCallbackQuery(cb.id, { text: `Cannot mark published — status is "${row.status}"` });
        return;
      }
      await supabase.updateContentCalendar(rowId, { status: 'published' });
      await bot.answerCallbackQuery(cb.id, { text: 'Marked as published!' });
      try {
        // Reminder cards can be photo messages (caption) or text messages.
        const suffix = '\n\n✅ Marked as published';
        if (message && message.caption !== undefined && message.caption !== null) {
          await bot.editMessageCaption((message.caption || '') + suffix, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          });
        } else {
          await bot.editMessageText(((message && message.text) || '') + suffix, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          });
        }
      } catch (editErr) {
        console.error('mp: message edit error (status already updated):', editErr.message);
      }
    } catch (err) {
      console.error('mp: (mark published) error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // ba:rowId — Approve copy in batch review
  if (data.startsWith('ba:')) {
    const rowId = data.slice('ba:'.length);
    const planId = await resolvePlanId(batchActionMap, rowId);
    try {
      await supabase.updateContentCalendar(rowId, { status: 'copy_approved' });
      await bot.answerCallbackQuery(cb.id, { text: '✅ Copy approved!' });
      // Refresh the batch review card
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (_) {}
      await sendBatchReviewMessage(chatId, planId);
    } catch (err) {
      console.error('ba: (batch_approve) error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed. Please try again.' });
      } catch (_) {}
    }
    return;
  }

  // br:rowId — Reject copy, ask for revision notes
  if (data.startsWith('br:')) {
    const rowId = data.slice('br:'.length);
    const planId = await resolvePlanId(batchActionMap, rowId);
    try {
      awaitingBatchReviewNotes.set(chatId, { rowId, planId });
      await bot.answerCallbackQuery(cb.id, { text: 'Please send revision notes' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n✏️ Please send your revision notes for this post:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      console.error('br: (batch_reject) error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed.' });
      } catch (_) {}
    }
    return;
  }

  // baa:planId — Approve all remaining copy_done posts
  if (data.startsWith('baa:')) {
    const planId = data.slice('baa:'.length);
    try {
      await bot.answerCallbackQuery(cb.id, { text: 'Approving all remaining...' });

      // Find all copy_done rows for this plan
      const allRows = await supabase.listContentCalendarByPlanId(planId);
      const pendingRows = allRows.filter(r => r.status === 'copy_done');

      let successCount = 0;
      let failCount = 0;
      for (const row of pendingRows) {
        try {
          await supabase.updateContentCalendar(row.id, { status: 'copy_approved' });
          successCount++;
        } catch (err) {
          console.error(`batch_approve_all: row ${row.id} failed:`, err.message);
          failCount++;
        }
      }

      await bot.sendMessage(chatId,
        `✅ *Batch Approve Complete!* ${successCount} approved, ${failCount} failed.`,
        { parse_mode: 'Markdown' }
      );

      // Refresh the batch review card
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (_) {}
      await sendBatchReviewMessage(chatId, planId);
    } catch (err) {
      console.error('batch_approve_all error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Operation failed.' });
      } catch (_) {}
    }
    return;
  }

  // brg:rowId — Regenerate copy for a rejected post
  if (data.startsWith('brg:')) {
    const rowId = data.slice('brg:'.length);
    const planId = await resolvePlanId(batchActionMap, rowId);
    try {
      await bot.answerCallbackQuery(cb.id, { text: 'Regenerating with feedback...' });

      const row = await supabase.getContentCalendar(rowId);
      if (!row) {
        await bot.answerCallbackQuery(cb.id, { text: 'Row not found.' });
        return;
      }

      const topic = row.topic || 'Fanz ceiling fan promotion';
      const pillar = row.pillar || 'product';
      const reviewNotes = (row.review_notes || '').trim() || null;

      const prompt = buildCopywritingPrompt(topic, pillar, reviewNotes);
      const raw = await callOpenRouter([
        { role: 'system', content: prompt },
        { role: 'user', content: 'Generate social media content for this Fanz topic, incorporating the revision feedback.' },
      ]);
      const parsed = parseCopywritingResponse(raw);
      if (!parsed) throw new Error('Failed to parse copywriting response');

      const validation = validateCopywritingResult(parsed);
      if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join('; ')}`);

      await supabase.updateContentCalendar(rowId, {
        fb_content: parsed.fb_content,
        ig_content: parsed.ig_content,
        hashtags: parsed.hashtags,
        status: 'copy_done',
        review_notes: null,
      });

      await bot.sendMessage(chatId, `🔄 Regenerated: ${topic}`);
      // Refresh
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (_) {}
      await sendBatchReviewMessage(chatId, planId);
    } catch (err) {
      console.error('batch_regen error:', err);
      try {
        await bot.answerCallbackQuery(cb.id, { text: 'Regeneration failed. Try again.' });
      } catch (_) {}
    }
    return;
  }
});

// ============================================
// HELPERS
// ============================================

function userMessage(err, fallback) {
  console.error('Operation failed:', err);
  return `❌ ${fallback || 'An unexpected error occurred. Please try again.'}`;
}

// Split message if over Telegram's 4096 char limit
function splitMessage(text, maxLen = 4096) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks;
}

async function sendWithSplit(chatId, text, options) {
  try {
    await sendWithSplitRaw(chatId, text, options);
  } catch (err) {
    if (options && options.parse_mode) {
      console.warn('Markdown send failed, falling back to plain text:', err.message);
      await sendWithSplitRaw(chatId, text);
    } else {
      throw err;
    }
  }
}

async function sendWithSplitRaw(chatId, text, options) {
  if (text.length <= 4096) {
    await bot.sendMessage(chatId, text, options);
  } else {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, options);
    }
  }
}

// ============================================
// IMAGE REVIEW HELPERS
// ============================================

async function sendImageReviewCard(chatId, rowId, imageUrl, status, isDryRun, retryCount) {
  const count = typeof retryCount === 'number' ? retryCount : 0;
  let caption = `🖼️ *Image Review* — Is this suitable for the post?`;

  // Soft prompt after 3 regenerate attempts
  if (count >= 3) {
    caption += `\n\n💡 *Tip:* Still not happy? Try changing the scene description, using a different product image, or uploading your own photo.`;
  }

  // 6-exit keyboard layout: 3 rows × 2 buttons
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: cb('image_approve',rowId) },
        { text: '✏️ Regenerate', callback_data: cb('image_retry',rowId,count) },
      ],
      [
        { text: '🎬 Change Scene', callback_data: cb('image_change_scene',rowId,count) },
        { text: '🖼️ Change Product', callback_data: cb('image_change_product',rowId,count) },
      ],
      [
        { text: '📤 Upload Own', callback_data: cb('image_upload_own',rowId) },
        { text: '⏭️ Skip Image', callback_data: cb('image_skip',rowId) },
      ],
    ],
  };

  if (isDryRun || !imageUrl || imageUrl.startsWith('(') || imageUrl.startsWith('DRYRUN')) {
    // Dry-run or placeholder — send text message
    await bot.sendMessage(chatId,
      `🖼️ *Image Review (dry-run)*\n\nURL: ${imageUrl}\nStatus: ${status}\n\n${caption}`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  } else {
    // Send actual photo with inline buttons
    try {
      await bot.sendPhoto(chatId, imageUrl, {
        caption: caption + '\n\n' + (status ? `_Status: ${status}_` : ''),
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (photoErr) {
      // If sendPhoto fails (e.g. URL not accessible), fallback to text
      console.error('sendPhoto failed, falling back to text:', photoErr.message);
      await bot.sendMessage(chatId,
        `🖼️ *Image Review*\n\nImage URL: ${imageUrl}\nStatus: ${status}\n\n${caption}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }
  }
}

/**
 * Send technical failure notice when imagery pipeline fails.
 */
async function sendTechnicalFailureNotice(chatId, rowId) {
  const message = `⚠️ *Image Generation Failed*\n\nA technical error occurred while generating the scene image.\n\nYou can retry or skip imagery and publish copy-only.`;

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Retry', callback_data: cb('image_retry_go',rowId,0) },
          { text: '⏭️ Skip Image', callback_data: cb('image_skip',rowId) },
        ],
      ],
    },
  });
}

/**
 * Trigger image regeneration when user rejects or retries.
 */
async function triggerImageRegeneration(rowId, chatId, count) {
  try {
    const supabase = require('./lib/supabase');
    const row = await supabase.getContentCalendar(rowId);
    if (!row) {
      await bot.sendMessage(chatId, '❌ Row not found.');
      return;
    }

    // Unified path: worker.processRow handles the shared processing-set
    // claim, the cross-process image_status claim, review_notes markers
    // (scene / product-next), fresh regeneration, and failure accounting.
    const result = await worker.processRow(row, true);

    if (result.success) {
      const retryLabel = count ? ` (retry #${count})` : '';
      await sendImageReviewCard(chatId, rowId, result.imageUrl || '(scene)', 'generated' + retryLabel, result.isDryRun, count);
    } else if (result.contention) {
      await bot.sendMessage(chatId, '⏳ This image is already being regenerated. The new version will arrive shortly.');
    } else {
      // Still failed
      await sendTechnicalFailureNotice(chatId, rowId);
    }
  } catch (err) {
    console.error('triggerImageRegeneration error:', err);
    try {
      await bot.sendMessage(chatId, `❌ ${'Failed to regenerate image. Please try again.'}`);
    } catch (_) {}
  }
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  worker.stop();
  bot.stopPolling();
  httpServer.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  worker.stop();
  bot.stopPolling();
  httpServer.close();
  process.exit(0);
});

// ============================================
// EXPORTS (for tests)
// ============================================
module.exports = {
  buildReviewMessage,
  buildReviewKeyboard,
  buildApprovePayload,
  buildRejectPayload,
  decideMessageIntent,
  awaitingReviewNotes,
  awaitingMonthEdits,
  awaitingMonthRemoves,
  awaitingBatchReviewNotes,
  awaitingImageUpload,
  awaitingSceneChange,
  planSessions,
  PILLAR_EMOJI,
  sendWithSplit,
  sendWithSplitRaw,
  buildMonthCalendarMessage,
  reshowMonthCalendar,
  callOpenRouter,
  sendBatchReviewMessage,
  sendImageReviewCard,
  sendTechnicalFailureNotice,
  triggerImageRegeneration,
  monthActionMap,
  batchActionMap,
};
