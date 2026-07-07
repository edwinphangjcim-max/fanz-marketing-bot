// ============================================
// background-gen.js — 纯背景生成节点（新配图管线第 1 步）
//
// 旧管线用 images.edit 把产品图整张喂给 AI（产品会被扭曲）。
// 新管线：LLM 从已批准文案导出场景描述 → 纯背景生成（画面里
// 严禁出现风扇/文字）→ 上传 Supabase Storage（Railway 磁盘
// 重启即失，背景进云端才能随时重合成）。产品/logo/文字由
// compose.js 确定性叠加。
//
// provider 可切换：IMAGE_PROVIDER env（默认 gpt-image-2），
// 接口只收 prompt 返回 Buffer，即梦/nano banana 后续加一个
// 函数注册即可。
//
// dry-run 红线：只限"调图像 API 那一下"，其余逻辑全真。
// ============================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PILLAR_SCENE, FESTIVAL_SCENE } = require('./scene-gen');
const { uploadFile } = require('./store-image');

const API_TIMEOUT_MS = 150_000;
const PROMPT_TIMEOUT_MS = 30_000;
const GPT_IMAGE_QUALITY = process.env.GPT_IMAGE_QUALITY || 'medium';

// 硬约束：确定性追加，不信任 LLM 会自己带上
const HARD_CONSTRAINTS =
  'Photorealistic interior background photograph. STRICT RULES: absolutely NO ceiling fan ' +
  'or any kind of fan in the image. NO text, letters, numbers, watermarks or logos. ' +
  'NO people in the foreground. Show a clean, visible ceiling with generous empty space ' +
  'in the upper half of the frame (a product will be placed there later), and keep the ' +
  'lower third of the frame simple and uncluttered (text will be placed there later).';

function isDryRun() {
  return !process.env.OPENAI_API_KEY;
}

// ============================================
// Step 1 — 从文案导出场景描述（LLM，失败退回映射表）
// ============================================

/**
 * Deterministic fallback: pillar/festival keyword tables (pre-redesign logic).
 */
function fallbackSceneDescription(pillar, topic) {
  const topicLower = (topic || '').toLowerCase();
  for (const [keyword, scene] of Object.entries(FESTIVAL_SCENE)) {
    if (topicLower.includes(keyword)) return scene;
  }
  return PILLAR_SCENE[pillar] || PILLAR_SCENE.product;
}

/**
 * Derive a scene description from the approved copy via OpenRouter.
 *
 * @param {object} row - content_calendar row (topic, pillar, fb_content)
 * @param {string} [sceneHint] - reviewer's "change scene" request, takes priority
 * @returns {Promise<{description: string, source: 'llm'|'hint'|'fallback'}>}
 */
async function deriveSceneDescription(row, sceneHint) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const copy = (row.fb_content || row.ig_content || '').slice(0, 600);

  if (!apiKey || (!copy && !sceneHint)) {
    return { description: fallbackSceneDescription(row.pillar, row.topic), source: 'fallback' };
  }

  const userParts = [
    `Post topic: ${row.topic || '(none)'}`,
    `Content pillar: ${row.pillar || 'product'}`,
  ];
  if (copy) userParts.push(`Approved post copy:\n${copy}`);
  if (sceneHint) userParts.push(`Reviewer's requested scene (FOLLOW THIS): ${sceneHint}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fanz-marketing-bot.railway.app',
        'X-Title': 'Fanz Marketing Bot - Background Prompt',
      },
      body: JSON.stringify({
        model: process.env.BG_PROMPT_MODEL || process.env.MODEL || 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'You write scene descriptions for AI background-image generation for a Malaysian ' +
              'ceiling fan brand\'s social media. Given a post\'s copy, describe ONE interior scene ' +
              'that matches the post\'s mood and occasion (festival, weather, family moment, etc). ' +
              '2-3 sentences, concrete and visual (room type, lighting, decor, atmosphere, ' +
              'Malaysian home context). Describe ONLY the environment — never mention fans, ' +
              'products, text or people\'s faces. Reply with the description only.',
          },
          { role: 'user', content: userParts.join('\n\n') },
        ],
        max_tokens: 250,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const data = await response.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('empty scene description');
    return { description: text, source: sceneHint ? 'hint' : 'llm' };
  } catch (err) {
    console.error('[background-gen] scene derivation failed, using fallback:', err.message);
    const base = fallbackSceneDescription(row.pillar, row.topic);
    return {
      description: sceneHint ? `${base}. ${sceneHint}` : base,
      source: 'fallback',
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildBackgroundPrompt(sceneDescription, brandStyle) {
  // brandStyle（来自 brand_kit.background_style）作为全局风格锚点，让每张图
  // 的美学统一到品牌调性上，而不是各生成各的。
  const style = brandStyle ? `\n\nOverall brand aesthetic to honour: ${brandStyle}.` : '';
  return `${sceneDescription}${style}\n\n${HARD_CONSTRAINTS}`;
}

// ============================================
// Step 2 — provider 可切换的背景生成
// ============================================

/** gpt-image-2 via OpenAI images.generate（纯文生图，无源图） */
async function generateGptImage2(prompt) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await openai.images.generate({
      model: 'gpt-image-2',
      prompt,
      size: '1024x1024',
      quality: GPT_IMAGE_QUALITY,
      n: 1,
    }, { signal: controller.signal });

    const first = response.data && response.data[0];
    if (!first) throw new Error('gpt-image-2 returned no data');
    if (first.b64_json) return Buffer.from(first.b64_json, 'base64');
    if (first.url) {
      const imgResp = await fetch(first.url);
      if (!imgResp.ok) throw new Error(`Failed to download generated image: ${imgResp.status}`);
      return Buffer.from(await imgResp.arrayBuffer());
    }
    throw new Error('gpt-image-2 response did not contain an image');
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`gpt-image-2 request timed out after ${API_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDERS = {
  'gpt-image-2': generateGptImage2,
  // 'jimeng': generateJimeng,        // 预留：即梦（成本远低于 gpt-image-2，待选型）
  // 'nano-banana': generateNanoBanana, // 预留：Google Gemini image
};

/**
 * Generate a background image and upload it to Supabase Storage.
 *
 * @param {object} row - content_calendar row
 * @param {string} [sceneHint] - reviewer scene request
 * @returns {Promise<{success: boolean, backgroundUrl?: string, prompt?: string,
 *   dryRun?: boolean, error?: string}>}
 */
async function generateBackground(row, sceneHint, brandStyle) {
  const { description } = await deriveSceneDescription(row, sceneHint);
  const prompt = buildBackgroundPrompt(description, brandStyle);

  // dry-run：无 OPENAI_API_KEY 时返回占位（1x1 png），不上传云端
  if (isDryRun()) {
    return { success: true, dryRun: true, prompt, backgroundUrl: null };
  }

  const providerName = process.env.IMAGE_PROVIDER || 'gpt-image-2';
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return { success: false, error: `Unknown IMAGE_PROVIDER: ${providerName}` };
  }

  let buffer;
  try {
    buffer = await provider(prompt);
  } catch (err) {
    // 错误消息原样上抛：worker 的 isGlobalApiError 靠它识别 billing/quota
    return { success: false, error: err.message, prompt };
  }

  // 上传 Storage：backgrounds/{Y}/{M}/{shortId}-{ts}.png
  const now = new Date();
  const shortId = (row.id || 'unknown').replace(/-/g, '').slice(0, 12);
  const storagePath = `backgrounds/${now.getUTCFullYear()}/` +
    `${String(now.getUTCMonth() + 1).padStart(2, '0')}/${shortId}-${Date.now()}.png`;

  const tmpPath = path.join(os.tmpdir(), `bg-${shortId}-${Date.now()}.png`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const { publicUrl } = await uploadFile(tmpPath, storagePath);
    return { success: true, backgroundUrl: publicUrl, prompt, dryRun: false };
  } catch (err) {
    return { success: false, error: `background upload failed: ${err.message}`, prompt };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

module.exports = {
  deriveSceneDescription,
  buildBackgroundPrompt,
  generateBackground,
  HARD_CONSTRAINTS,
  PROVIDERS,
};
