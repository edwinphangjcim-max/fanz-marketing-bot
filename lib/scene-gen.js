// ============================================
// scene-gen.js — GPT Image 2 场景图生成节点 [I-2]
//
// 输入：content_calendar row + source_product_image
// 输出：scene_image_url + image_status = generated
//
// 流水线：scene prompt → GPT Image 2 (OpenAI images.edit) → scene_image_url
//
// 红线：dry-run 只限"调 GPT Image 2 那一下"，其余逻辑全真
// 超时：AbortController 90s（GPT Image 2 通常 20-60s）
// 幂等：已 generated 不重复调 API
// ============================================

const path = require('path');
const fs = require('fs');

// ============================================
// 场景指令引擎 — 按 pillar/topic/节庆构造
// ============================================

/** 节庆 → 场景关键词映射 */
const FESTIVAL_SCENE = {
  'chinese new year': 'Chinese New Year festive home, red lanterns and gold decorations, warm interior lighting',
  'hari raya': 'Hari Raya Aidilfitri festive home, pelita lights, ketupat decorations, warm family gathering setting',
  'deepavali': 'Deepavali festive home, kolam decorations, diya lamps, warm golden lighting',
  'christmas': 'Christmas decorated living room, warm fairy lights, festive ornaments, cozy atmosphere',
  'merdeka': 'Merdeka celebration, Jalur Gemilang decorations, modern Malaysian home',
  'mid-year': 'bright and airy modern living space, summer vibe, natural daylight streaming in',
  'school holidays': 'family living room, children playing, warm and inviting home atmosphere',
  'rainy': 'cozy indoor space during rainy weather, warm lighting, windows showing rain outside',
  'hot': 'sunlit room with bright natural light, warm Malaysian afternoon, curtains drawn slightly',
};

/** 默认场景 by pillar */
const PILLAR_SCENE = {
  product: 'modern living room with elegant decor, warm ambient lighting, contemporary Malaysian home interior',
  case: 'cozy Malaysian home interior, bedroom or living area with warm natural light, real home installation setting',
  promo: 'festive event display, seasonal celebration backdrop, promotional showcase setting',
  story: 'stylish contemporary interior, lifestyle home setting, modern Malaysian apartment with tasteful decor',
};

/** 用户不可见的系统约束 */
const EDITOR_CONSTRAINT =
  'IMPORTANT: Keep the ceiling fan\'s appearance visually unchanged — do NOT alter its shape, blades, design, or color. Only change the background environment around it. The result should be photorealistic, as if the fan was photographed installed in that setting.';

// ============================================
// Build scene prompt
// ============================================

/**
 * Build the scene generation prompt from pillar and topic.
 *
 * @param {string} pillar - content pillar (product|case|promo|story)
 * @param {string} topic - topic title (used for scene keyword extraction)
 * @returns {string} full prompt for GPT Image 2
 */
function buildScenePrompt(pillar, topic) {
  // Detect festival from topic text
  const topicLower = (topic || '').toLowerCase();
  let sceneKeywords = PILLAR_SCENE[pillar] || PILLAR_SCENE.product;

  // Check for festival-specific scene overrides
  for (const [keyword, scene] of Object.entries(FESTIVAL_SCENE)) {
    if (topicLower.includes(keyword)) {
      sceneKeywords = scene;
      break;
    }
  }

  return `${sceneKeywords}. ${EDITOR_CONSTRAINT}`;
}

// ============================================
// GPT Image 2 (OpenAI images.edit) image-to-image
// ============================================

const API_TIMEOUT_MS = 150_000;
const GPT_IMAGE_QUALITY = process.env.GPT_IMAGE_QUALITY || 'medium';

/**
 * Check if GPT Image 2 API should be called or dry-run.
 * Evaluated at call time, not module load time.
 */
function isDryRun() {
  return !process.env.OPENAI_API_KEY;
}

/**
 * Call GPT Image 2 for image-to-image editing.
 * Returns { data: Buffer, mimeType: string } or DRYRUN placeholder.
 *
 * @param {string} prompt - scene prompt
 * @param {string} imagePath - path to source product image
 * @returns {Promise<{data: Buffer, mimeType: string, dryRun?: boolean}>}
 */
async function callGptImage2(prompt, imagePath) {
  // dry-run: 只限这一脚，其余逻辑全真
  if (isDryRun()) {
    // Generate a minimal placeholder image (1x1 transparent PNG as data URI marker)
    // This keeps the pipeline flowing without real API calls
    return {
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64'
      ),
      mimeType: 'image/png',
      dryRun: true,
    };
  }

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Product image not found at ${imagePath}`);
  }

  // Lazy-load OpenAI SDK (only on real call, not dry-run)
  const OpenAI = require('openai');
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const imageBuffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : 'image/jpeg';
  const filename = path.basename(imagePath);

  // Use File constructor for proper MIME type (required by GPT Image 2 API)
  const imageFile = new File([imageBuffer], filename, { type: mimeType });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    // GPT Image 2 uses OpenAI images.edit endpoint
    const response = await openai.images.edit({
      model: 'gpt-image-2',
      image: imageFile,
      prompt: prompt,
      size: '1024x1024',
      quality: GPT_IMAGE_QUALITY,
      n: 1,
    }, {
      signal: controller.signal,
    });

    if (!response.data || response.data.length === 0) {
      throw new Error('GPT Image 2 returned no data');
    }

    const firstResult = response.data[0];
    let imageData;

    if (firstResult.b64_json) {
      imageData = Buffer.from(firstResult.b64_json, 'base64');
    } else if (firstResult.url) {
      // Fallback: download from URL
      const imgResp = await fetch(firstResult.url);
      if (!imgResp.ok) {
        throw new Error(`Failed to download generated image: ${imgResp.status}`);
      }
      imageData = Buffer.from(await imgResp.arrayBuffer());
    } else {
      throw new Error('GPT Image 2 response did not contain an image. ' +
        JSON.stringify(firstResult));
    }

    return {
      data: imageData,
      mimeType: 'image/png',
    };
  } catch (err) {
    // If the error is from AbortController, provide a clearer message
    if (err.name === 'AbortError') {
      throw new Error(`GPT Image 2 request timed out after ${API_TIMEOUT_MS / 1000}s`);
    }
    // Re-throw OpenAI errors with their original message
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================
// Orchestrator — generate scene image for a content_calendar row
// ============================================

/**
 * Generate a scene image for the given content_calendar row.
 * Full pipeline: idempotency check → build prompt → status=generating →
 * GPT Image 2 → status=generated (or failed) → store scene_image_url
 *
 * @param {string} rowId - content_calendar row UUID
 * @param {string} topic - topic title for prompt construction
 * @param {string} pillar - content pillar
 * @param {string} sourceProductImage - filename of the source product image
 * @param {string} productsDir - directory containing product images
 * @returns {Promise<{success: boolean, imageStatus?: string, sceneImageUrl?: string, dryRun?: boolean, error?: string}>}
 */
async function generateSceneImage(rowId, topic, pillar, sourceProductImage, productsDir) {
  const { updateImageRow } = require('./image-state');
  const { updateContentCalendar } = require('./supabase');
  const { selectProductImage } = require('./select-product');

  try {
    // Step 0: Read current row to check idempotency
    const { getContentCalendar } = require('./supabase');
    let row;
    try {
      row = await getContentCalendar(rowId);
    } catch (_) {
      row = null;
    }

    // If row already has image_status='generated', skip (idempotency)
    if (row && row.image_status === 'generated') {
      return {
        success: true,
        imageStatus: 'generated',
        sceneImageUrl: row.scene_image_url || null,
        idempotent: true,
      };
    }

    // Step 1: Resolve product image path
    const resolvedImage = sourceProductImage
      ? path.join(productsDir, sourceProductImage)
      : null;

    if (!resolvedImage || !fs.existsSync(resolvedImage)) {
      // Fallback: use select-product to find one
      const picked = selectProductImage(pillar, topic);
      if (picked && fs.existsSync(picked.filepath)) {
        // Also write it as source_product_image so it's persisted
        const selectProduct = require('./select-product');
        try {
          await selectProduct.writeSourceProductImage(rowId, picked.filename);
        } catch (_) {
          // non-blocking
        }
      }
    }

    const finalImagePath = (resolvedImage && fs.existsSync(resolvedImage))
      ? resolvedImage
      : selectProductImage(pillar, topic).filepath;

    // Step 2: Update status to 'generating'
    const expectedStatus = (row && row.image_status) || 'pending';
    await updateImageRow(rowId, { image_status: 'generating' }, expectedStatus);

    // Step 3: Build scene prompt
    const prompt = buildScenePrompt(pillar, topic);

    // Step 4: Call GPT Image 2 (or dry-run)
    let result;
    let imageUrl;
    let isDryRun = false;

    try {
      result = await callGptImage2(prompt, finalImagePath);
      isDryRun = result.dryRun === true;

      if (isDryRun) {
        // dry-run: store marker instead of real image
        const timestamp = Date.now();
        const scenesDir = path.join(path.dirname(productsDir), 'scenes');
        if (!fs.existsSync(scenesDir)) {
          fs.mkdirSync(scenesDir, { recursive: true });
        }
        const placeholderFilename = `DRYRUN-${rowId.slice(0, 8)}-${timestamp}.png`;
        const placeholderPath = path.join(scenesDir, placeholderFilename);
        fs.writeFileSync(placeholderPath, result.data);
        imageUrl = placeholderFilename;
      } else {
        // Real: save scene image to scenes directory
        const scenesDir = path.join(path.dirname(productsDir), 'scenes');
        if (!fs.existsSync(scenesDir)) {
          fs.mkdirSync(scenesDir, { recursive: true });
        }
        const ext = result.mimeType === 'image/png' ? '.png' : '.jpg';
        const sceneFilename = `scene-${rowId.slice(0, 8)}-${Date.now()}${ext}`;
        const scenePath = path.join(scenesDir, sceneFilename);
        fs.writeFileSync(scenePath, result.data);
        imageUrl = sceneFilename;
      }
    } catch (apiErr) {
      // Step 5a: API call failed → status=failed
      await updateImageRow(rowId, { image_status: 'failed' }, 'generating');
      return {
        success: false,
        error: apiErr.message,
        imageStatus: 'failed',
      };
    }

    // Step 5b: Success → status=generated, store scene_image_url
    await updateImageRow(rowId, {
      image_status: 'generated',
      scene_image_url: imageUrl,
    }, 'generating');

    return {
      success: true,
      imageStatus: 'generated',
      sceneImageUrl: imageUrl,
      dryRun: isDryRun,
    };
  } catch (err) {
    // Uncaught error — try to set status to failed, but don't throw
    try {
      const { getContentCalendar } = require('./supabase');
      const currentRow = await getContentCalendar(rowId);
      if (currentRow) {
        await updateImageRow(rowId, { image_status: 'failed' }, currentRow.image_status);
      }
    } catch (_) {
      // best-effort
    }
    return {
      success: false,
      error: err.message,
      imageStatus: 'failed',
    };
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  buildScenePrompt,
  callGptImage2,
  generateSceneImage,
  API_TIMEOUT_MS,
  PILLAR_SCENE,
  FESTIVAL_SCENE,
  EDITOR_CONSTRAINT,
};