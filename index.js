const TelegramBot = require('node-telegram-bot-api');
const { brand, products } = require('./products');
const fs = require('fs');
const path = require('path');
const http = require('http');
const supabase = require('./lib/supabase');
const { buildPlanSystemPrompt, parsePlanResponse, validateSelection, createSelectionPayload } = require('./lib/planning');
const { buildCopywritingPrompt, parseCopywritingResponse, validateCopywritingResult } = require('./lib/copywriting');
const { publishToSocial } = require('./lib/publish');
const { generateSceneImage } = require('./lib/scene-gen');

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
// /plan session state
// ============================================
// Map<chatId, { plans: [{number, title, description, direction}], timestamp: Date }>
const planSessions = new Map();

// Map<chatId, { rowId, reviewMsgId }> — set when user clicks "Request Changes",
// cleared after their next text message is consumed as the revision note.
const awaitingReviewNotes = new Map();

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
        { text: '✅ Approve', callback_data: `review_approve:${rowId}` },
        { text: '✏️ Request Changes', callback_data: `review_reject:${rowId}` },
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
//   otherwise         → 'free_text'
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
async function callOpenRouter(messages) {
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
        max_tokens: 1500,
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
}

// ============================================
// HTTP SERVER (Railway health + version probe)
// ============================================
const HTTP_PORT = process.env.PORT || 8080;

const httpServer = http.createServer((req, res) => {
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
  const welcome = `🤖 Welcome to Fanz Marketing Bot!

I help you create professional social media content for Fanz Sdn Bhd.

Available commands:
/plan [context] — AI content planning (suggest topics → pick → generate)
/product [brief] — Generate product promotion post
/case [details] — Generate installation case study post
/promo [details] — Generate promotion / campaign post
/story [context] — Generate brand story post

Just type any message without a command, and I'll treat it as a product promotion brief!

Example: /product Let's promote our new Smart Series fan with WiFi control`;

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

// Free text input
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip non-text messages
  if (!text) return;

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
              [{ text: '🔄 Regenerate with Feedback', callback_data: `redo_copy:${rowId}` }],
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

  // Skip commands (already handled above)
  if (text.startsWith('/')) return;

  await bot.sendMessage(chatId, '⏳ Generating content based on your message...');
  try {
    const content = await generateContent('freetext', text);
    await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('freetext error:', err);
    await bot.sendMessage(chatId, userMessage(err, 'Error generating content. Please try again.'));
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
// REVIEW CALLBACK HANDLER
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
        const { runImageryPipeline } = require('./lib/pipeline');

        const row = await supabase.getContentCalendar(rowId);
        if (row) {
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
  // IMAGE REVIEW CALLBACKS — 配图审核 [I-2 两步审]
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
            [{ text: '🚀 Publish', callback_data: `publish_go:${rowId}` }],
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
                { text: '🔄 Regenerate', callback_data: `image_retry_go:${rowId}:${nextCount}` },
                { text: '⏭️ Skip Image', callback_data: `image_skip:${rowId}` },
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
            [{ text: '🚀 Publish', callback_data: `publish_go:${rowId}` }],
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
// IMAGE REVIEW HELPERS — 配图审核卡 + 技术失败通知 + 重生成
// ============================================

/**
 * Send imagery review card for user to approve/reject the generated scene image.
 * @param {number} [retryCount] - optional retry count for callback_data, default 0
 */
async function sendImageReviewCard(chatId, rowId, imageUrl, status, isDryRun, retryCount) {
  const count = typeof retryCount === 'number' ? retryCount : 0;
  const caption = `🖼️ *Image Review* — Is this suitable for the post?`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve Image', callback_data: `image_approve:${rowId}` },
        { text: '✏️ Regenerate', callback_data: `image_reject:${rowId}:${count}` },
      ],
    ],
  };

  if (isDryRun || !imageUrl || imageUrl.startsWith('(')) {
    // Dry-run or placeholder — send text message
    await bot.sendMessage(chatId,
      `🖼️ *Image Review (dry-run)*\n\nURL: ${imageUrl}\nStatus: ${status}\n\nIs this suitable for the post?`,
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
        `🖼️ *Image Review*\n\nImage URL: ${imageUrl}\nStatus: ${status}\n\nIs this suitable for the post?`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }
  }
}

/**
 * Send technical failure notice when imagery pipeline fails.
 * User can retry or skip imagery.
 */
async function sendTechnicalFailureNotice(chatId, rowId) {
  const message = `⚠️ *Image Generation Failed*\n\nA technical error occurred while generating the scene image.\n\nYou can retry or skip imagery and publish copy-only.`;

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Retry', callback_data: `image_retry_go:${rowId}:0` },
          { text: '⏭️ Skip Image', callback_data: `image_skip:${rowId}` },
        ],
      ],
    },
  });
}

/**
 * Trigger image regeneration when user rejects or retries.
 * Resets image_status and re-runs scene-gen pipeline.
 */
async function triggerImageRegeneration(rowId, chatId, count) {
  try {
    const { runImageryPipeline } = require('./lib/pipeline');

    const supabase = require('./lib/supabase');
    const { resetImageStatus } = require('./lib/image-state');

    // Reset image_status to 'generating'
    await resetImageStatus(rowId);

    // Read row for topic/pillar
    const row = await supabase.getContentCalendar(rowId);
    if (!row) {
      await bot.sendMessage(chatId, '❌ Row not found.');
      return;
    }

    const result = await runImageryPipeline(rowId);

    if (result.success) {
      const retryLabel = count ? ` (retry #${count})` : '';
      await sendImageReviewCard(chatId, rowId, result.imageUrl || '(scene)', 'generated' + retryLabel, result.isDryRun, count);
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
  bot.stopPolling();
  httpServer.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
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
  planSessions,
  PILLAR_EMOJI,
  sendWithSplit,
  sendWithSplitRaw,
};