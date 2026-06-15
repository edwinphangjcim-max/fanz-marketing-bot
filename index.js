const TelegramBot = require('node-telegram-bot-api');
const { brand, products } = require('./products');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIG
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
const PRODUCT_IMAGE = path.join(__dirname, 'images', 'ceiling-fan-sample.jpg');

if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) {
  console.error('Missing TELEGRAM_TOKEN or OPENROUTER_API_KEY');
  process.exit(1);
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
// SYSTEM PROMPT
// ============================================
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
|- DO NOT use overly formal/business language — keep it conversational and warm
|- DO NOT make up specific discounts/prices unless the user provides them
|- Mix Chinese and English naturally, like a real Malaysian social media post
|- Each post should feel unique, not a template`;

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
// BOT INIT
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log(`Fanz Marketing Bot started. Model: ${MODEL}`);

// ============================================
// COMMANDS
// ============================================

// /start
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const welcome = `🤖 Welcome to Fanz Marketing Bot!

I help you create professional social media content for Fanz Sdn Bhd.

Available commands:
/product [brief] — Generate product promotion post
/case [details] — Generate installation case study post
/promo [details] — Generate promotion / campaign post
/story [context] — Generate brand story post

Just type any message without a command, and I'll treat it as a product promotion brief!

Example: /product Let's promote our new Smart Series fan with WiFi control`;

  await bot.sendMessage(chatId, welcome);
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

// Free text input (not a command) — treated as product promotion brief
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip if it's a command (already handled above) or non-text message
  if (!text || text.startsWith('/')) return;

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
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  bot.stopPolling();
  process.exit(0);
});
