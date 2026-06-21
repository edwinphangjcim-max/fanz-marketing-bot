const TelegramBot = require('node-telegram-bot-api');
const { brand, products } = require('./products');
const fs = require('fs');
const path = require('path');
const http = require('http');
const supabase = require('./lib/supabase');
const { buildPlanSystemPrompt, parsePlanResponse, validateSelection, createSelectionPayload } = require('./lib/planning');
const { buildCopywritingPrompt, parseCopywritingResponse, validateCopywritingResult } = require('./lib/copywriting');
const { publishToSocial } = require('./lib/publish');

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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
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

// Content execution prompt (existing)
const SYSTEM_PROMPT = `You are a professional social media marketing copywriter for Fanz Sdn Bhd, a Malaysian fan and air cooler brand.

BRAND VOICE:
- Professional and trustworthy, with a personal touch
- Warm and approachable — like a helpful friend who knows their products
- Natural and authentic — NOT robotic, NOT overly salesy
- Confident about quality without being arrogant
- Language: Mixed Chinese and English (马来西亚中英混杂 style, natural like daily conversation)

BRAND IDENTITY:
- We have been providing quality ceiling fans for over 10 years in Malaysia
- Our products come with a 10-year motor warranty — this is a major trust signal
- We offer on-site service across Malaysia & Singapore
- SIRIM certified — Malaysian quality assurance
- DC motor technology — energy efficient, quiet, modern
- Product liability insurance RM 1,000,000
- We stand behind our products

PRODUCT RANGE:
- FS Series 563 L: Smart ceiling fan, 56" L-type blades, DC motor, ideal for large living rooms
- Grande L Series: Ceiling fan with 22W LED light, 56" ABS blades, DC motor, for living & dining rooms
- Smart Series: WiFi-enabled smart ceiling fan, app control, multi-speed, LED brightness
- AURA Series: Compact ceiling fan, perfect for small spaces & low ceilings, bedrooms

When given a user request, you must generate social media content in this EXACT format:

📱 FACEBOOK VERSION
(2-4 sentences, hook + key selling points + CTA, suitable for Facebook audience)

📸 INSTAGRAM VERSION
(Shorter and more lively, perfect for Instagram. Use line breaks for visual appeal. Include relevant emojis naturally)

#⃣ HASHTAGS (8-12 tags, mix of Chinese and English, include brand hashtag)
[list 8-12 hashtags, Chinese-English mixed]

🖼️ IMAGE SUGGESTIONS
(2-3 concrete image ideas for this post)

✅ Boss's mom approved, one-click publish to FB/IG!

IMPORTANT RULES:
- Always highlight the 10-year warranty prominently
- Mention on-site service for Malaysia & Singapore customers
- Reference SIRIM certification naturally
- Highlight DC motor energy efficiency
- DO NOT use overly formal/business language — keep it conversational and warm
- DO NOT make up specific discounts/prices unless the user provides them
- Mix Chinese and English naturally, like a real Malaysian social media post
- Each post should feel unique, not a template`;

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
// Generate marketing content
// ============================================
async function generateContent(command, userText) {
  const productContext = `AVAILABLE PRODUCTS:\n${buildProductContext()}`;

  let prompt = '';

  switch (command) {
    case 'product':
      if (userText) {
        prompt = `Generate social media content for product promotion.\n\nProduct brief from user: "${userText}"\n\nReference our product range and brand identity to create a compelling post.\n\n${productContext}`;
      } else {
        prompt = `Generate a general product showcase social media post. Highlight our product range and what makes Fanz special.\n\n${productContext}`;
      }
      break;

    case 'case':
      if (userText) {
        prompt = `Generate a customer installation case study / testimonial style post.\n\nAdditional context: "${userText}"\n\nCreate a post that feels like a real customer story — build trust through social proof.\n\n${productContext}`;
      } else {
        prompt = `Generate a customer installation story post. Describe a realistic scenario where a Malaysian family chose Fanz and enjoys the benefits (quiet, energy saving, reliable). Build trust through storytelling.\n\n${productContext}`;
      }
      break;

    case 'promo':
      if (userText) {
        prompt = `Generate a promotion / campaign social media post.\n\nPromotion details: "${userText}"\n\nCreate excitement and urgency while maintaining brand trust.\n\n${productContext}`;
      } else {
        prompt = `Generate a general promotional post. Create a compelling offer-oriented post that drives engagement. Include a natural call-to-action.\n\n${productContext}`;
      }
      break;

    case 'story':
      if (userText) {
        prompt = `Generate a brand story social media post.\n\nStory context: "${userText}"\n\nTell Fanz's story in an authentic way — our journey, our commitment to quality, our promise to customers.\n\n${productContext}`;
      } else {
        prompt = `Generate a brand story post. Tell the story of Fanz — over 10 years serving Malaysian homes, our commitment to quality (SIRIM certified), 10-year warranty promise, and door-to-door service. Make it heartfelt and authentic.\n\n${productContext}`;
      }
      break;

    default:
      // Free input treated as product promotion with the text as brief
      prompt = `Generate social media content based on this user message. Treat it as a product promotion brief.\n\nUser: "${userText || 'Generate a general product post'}"\n\n${productContext}`;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt }
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
// IMAGE EDITING (Nano Banana via Gemini API)
// ============================================

// Convert image file to base64
function imageToBase64(filePath) {
  const data = fs.readFileSync(filePath);
  return data.toString('base64');
}

// Call Gemini Nano Banana for image-to-image editing
async function geminiEditImage(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured. Please set this environment variable.');
  }

  if (!fs.existsSync(PRODUCT_IMAGE)) {
    throw new Error(`Product image not found at ${PRODUCT_IMAGE}. Please place a Fanz product image there.`);
  }

  const base64Image = imageToBase64(PRODUCT_IMAGE);
  const mimeType = PRODUCT_IMAGE.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const response = await fetch(
`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Image,
              },
            },
          ],
        }],
        generationConfig: {
          temperature: 1.0,
          topK: 32,
          topP: 1,
          maxOutputTokens: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('Gemini returned no candidates. The model may not support image output.');
  }

  // Find image part in response
  for (const part of data.candidates[0].content.parts) {
    if (part.inline_data && part.inline_data.data) {
      return {
        data: Buffer.from(part.inline_data.data, 'base64'),
        mimeType: part.inline_data.mime_type || 'image/png',
      };
    }
  }

  throw new Error('Gemini response did not contain an image. Try a different prompt.');
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
    const result = await geminiEditImage(prompt);

    // Send the generated photo to Telegram
    await bot.sendPhoto(chatId, result.data, {
      caption: `🎨 "${theme}" — Fanz product in scene\n✅ Generated via Nano Banana (${GEMINI_MODEL})`,
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
      await supabase.updateContentCalendar(rowId, buildApprovePayload());
      await bot.answerCallbackQuery(cb.id, { text: 'Approved ✓' });
      const originalText = (message && message.text) || '';
      await bot.editMessageText(originalText + '\n\n✅ Approved', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Publish', callback_data: `publish_go:${rowId}` }],
          ],
        },
      });
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
      if (row.post_id) {
        await bot.answerCallbackQuery(cb.id, { text: `Already published: ${row.post_id}` });
        return;
      }
      // Status check
      if (row.status !== 'approved') {
        await bot.answerCallbackQuery(cb.id, { text: `Cannot publish — status is "${row.status}"` });
        return;
      }
      // Execute publish
      const result = await publishToSocial(row);
      // Update DB
      await supabase.updateContentCalendar(rowId, { post_id: result.post_id, status: 'published' });
      // Edit message
      const originalText = (message && message.text) || '';
      const suffix = result.dry_run
        ? `\n\n🚀 Published (dry-run: \`${result.post_id}\`)`
        : `\n\n🚀 Published: \`${result.post_id}\``;
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