const TelegramBot = require('node-telegram-bot-api');
const { brand, products } = require('./products');
const fs = require('fs');
const path = require('path');
const http = require('http');
const supabase = require('./lib/supabase');

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

if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) {
  console.error('Missing TELEGRAM_TOKEN or OPENROUTER_API_KEY');
  process.exit(1);
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

// Content planning prompt (new — for /plan)
function buildPlanSystemPrompt() {
  const now = new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const currentMonth = months[now.getMonth()];
  const currentYear = now.getFullYear();

  return `You are a senior social media content strategist for Fanz Sdn Bhd, a Malaysian ceiling fan and air cooler brand.

Your job: Suggest 3-5 content topics for the coming week that are relevant, timely, and aligned with the current month in Malaysia.

CURRENT DATE: ${currentMonth} ${currentYear}

MALAYSIA SEASONAL & CULTURAL CONTEXT (use this to guide your suggestions):
- Hari Raya Aidilfitri (March-April) — home decoration, family gatherings
- Deepavali (Oct-Nov) — festive lighting, home preparation
- Chinese New Year (Jan-Feb) — spring cleaning, home upgrades
- Christmas (Dec) — year-end festive season
- National Day (Aug 31) — Merdeka campaigns
- Malaysia Day (Sep 16) — East Malaysia awareness
- School holidays (March, June, December) — family time at home
- Rainy season (Nov-Feb) — enclosed spaces, ventilation
- Hot season (March-May) — peak fan season, heat relief
- Mid-year sales (June-July) — promotion-friendly period
- Year-end sales (Nov-Dec) — year-end campaigns

BRAND & PRODUCTS:
- 10+ years in Malaysia, 10-year motor warranty
- On-site service across Malaysia & Singapore
- SIRIM certified, DC motor technology, energy efficient
- Products: FS Series (smart, large spaces), Grande L (LED light, living/dining), Smart Series (WiFi app control), AURA (compact, bedrooms)
- We also sell air coolers (pending product expansion details)

YOUR TASK:
Based on the CURRENT DATE and Malaysia context above, suggest 3-5 content topics for Fanz's social media this week.

For each topic, include:
1. A catchy title (mixed Chinese-English, like a real Malaysian post)
2. A one-sentence explanation of why this topic works now
3. A recommended content direction from exactly one of: product, case, promo, story

Your output MUST follow this exact format — one numbered item per line block with clear separators:

===== 1 =====
Title: [catchy title]
Why: [one sentence explaining timeliness/relevance]
Direction: [product|case|promo|story]

===== 2 =====
Title: [catchy title]
Why: [one sentence]
Direction: [product|case|promo|story]

... and so on up to 5.

IMPORTANT:
- Do NOT invent holidays or events that don't exist
- If no major event is near the current date, base suggestions on seasons and general marketing timing
- Keep suggestions practical for a ceiling fan + air cooler brand
- Mixed Chinese-English language throughout
- No post content generation — only topic planning`;
}

// ============================================
// OpenRouter API helper (fetch, no SDK)
// ============================================
async function callOpenRouter(messages) {
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
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
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
// Parse /plan AI response into structured plans
// ============================================
function parsePlanResponse(rawText) {
  const plans = [];
  let currentPlan = null;

  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect new plan block: "===== N =====" or "N." at start
    const blockMatch = trimmed.match(/^=+\s*(\d+)\s*=+/);
    const numberMatch = trimmed.match(/^(\d+)[.)]\s*$/);

    if (blockMatch) {
      // Save previous plan if exists
      if (currentPlan && currentPlan.number) {
        plans.push(currentPlan);
      }
      currentPlan = { number: parseInt(blockMatch[1]), title: '', description: '', direction: '' };
      continue;
    }

    if (!currentPlan) {
      // If we haven't started a block yet, check if line starts with number
      const startMatch = trimmed.match(/^(\d+)[.)]\s+/);
      if (startMatch) {
        if (currentPlan && currentPlan.number) {
          plans.push(currentPlan);
        }
        currentPlan = { number: parseInt(startMatch[1]), title: trimmed.replace(/^\d+[.)]\s*/, ''), description: '', direction: '' };
        continue;
      }
    }

    if (!currentPlan) continue;

    // Parse fields within a plan block
    const titleMatch = trimmed.match(/^Title:\s*(.+)/i);
    const whyMatch = trimmed.match(/^Why:\s*(.+)/i);
    const directionMatch = trimmed.match(/^Direction:\s*(.+)/i);

    if (titleMatch) {
      currentPlan.title = titleMatch[1].trim();
    } else if (whyMatch) {
      currentPlan.description = whyMatch[1].trim();
    } else if (directionMatch) {
      const dir = directionMatch[1].trim().toLowerCase();
      if (['product', 'case', 'promo', 'story'].includes(dir)) {
        currentPlan.direction = dir;
      } else {
        currentPlan.direction = 'product'; // default fallback
      }
    } else if (trimmed && !trimmed.startsWith('===') && !trimmed.startsWith('Title') && !trimmed.startsWith('Why') && !trimmed.startsWith('Direction')) {
      // Free text — could be part of title if title is empty
      if (!currentPlan.title && trimmed.length > 1) {
        currentPlan.title = trimmed;
      }
    }
  }

  // Don't forget the last plan
  if (currentPlan && currentPlan.number && currentPlan.title) {
    plans.push(currentPlan);
  }

  return plans;
}

// ============================================
// BOT INIT
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log(`Fanz Marketing Bot started. Model: ${MODEL}. Commit: ${COMMIT_SHA}`);

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

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP server listening on :${HTTP_PORT} (commit=${COMMIT_SHA})`);
});

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
    await bot.sendMessage(chatId, `❌ Error: ${err.message}. Please try again.`);
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
    await bot.sendMessage(chatId, `❌ Error: ${err.message}. Please try again.`);
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
    await bot.sendMessage(chatId, `❌ Error: ${err.message}. Please try again.`);
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
    await bot.sendMessage(chatId, `❌ Error: ${err.message}. Please try again.`);
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
    await bot.sendMessage(chatId, `❌ Error: ${err.message}. Please try again.`);
  }
});

// Free text input
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip non-text messages
  if (!text) return;

  // === PLAN SELECTION INTERCEPT ===
  // If user is in a plan session and replied with a number, handle selection
  if (/^\d+$/.test(text)) {
    const session = getPlanSession(chatId);
    if (session) {
      const num = parseInt(text, 10);
      const plan = session.plans.find(p => p.number === num);

      if (plan) {
        // Clear the session so the user doesn't accidentally re-trigger
        clearPlanSession(chatId);

        await bot.sendMessage(chatId, `⏳ Generating "${plan.title}" (${plan.direction} direction)...`);

        try {
          const content = await generateContent(plan.direction, plan.title + ' — ' + plan.description);
          await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });

          // Re-prompt: keep the session but the user already selected, so let them know they can /plan again
          await bot.sendMessage(chatId, `✅ Content generated! Send /plan for new suggestions, or use /${plan.direction} to create another post.`);
        } catch (err) {
          console.error('plan selection error:', err);
          await bot.sendMessage(chatId, `❌ Error: ${err.message}. Please try again or send /plan to restart.`);
        }
        return;
      } else {
        // Number out of range
        const range = session.plans.length;
        await bot.sendMessage(chatId, `⚠️ Please reply with a number between 1 and ${range}. Or send /plan to start over.`);
        return;
      }
    }
  }

  // Skip commands (already handled above)
  if (text.startsWith('/')) return;

  await bot.sendMessage(chatId, '⏳ Generating content based on your message...');
  try {
    const content = await generateContent('freetext', text);
    await sendWithSplit(chatId, content, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('freetext error:', err);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}. Please try again.`);
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
      `❌ Image generation failed: ${err.message}\n\nMake sure:\n1. GEMINI_API_KEY is set\n2. A product image exists at images/ceiling-fan-sample.jpg\n3. The Gemini API key has access to ${GEMINI_MODEL}`
    );
  }
});

// ============================================
// HELPERS
// ============================================

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