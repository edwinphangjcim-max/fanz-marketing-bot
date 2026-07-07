// ============================================
// compose.js — 确定性合成（新配图管线第 2 步）
//
// 背景（云端 URL 或 Buffer）+ 产品图（asset library）+ logo + 文字模板
// 全部用 sharp 确定性叠加：同 spec 同输出，改字/换产品/换位置零 AI 成本。
//
// 产品图处理：
//   - SVG → 透明底栅格化，直接压在背景上（干净）
//   - 位图无 alpha（实拍图）→ 包白色圆角卡再叠加（避免生硬的方形白底）
// ============================================

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { applyTextOverlays } = require('./text-overlay');
const brandKit = require('./brand-kit');

/**
 * Resolve an asset source (local path OR http(s) URL) to { buffer, ext }.
 * Product images now live in Supabase Storage (brand_assets) as well as the
 * committed fallback library, so compose must handle both.
 */
async function loadAsset(source) {
  const ext = path.extname((source || '').split('?')[0]).toLowerCase();
  if (/^https?:\/\//i.test(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const resp = await fetch(source, { signal: controller.signal });
      if (!resp.ok) throw new Error(`asset fetch failed: HTTP ${resp.status}`);
      return { buffer: Buffer.from(await resp.arrayBuffer()), ext };
    } finally {
      clearTimeout(timer);
    }
  }
  if (!source || !fs.existsSync(source)) {
    throw new Error(`Product image not found: ${source}`);
  }
  return { buffer: fs.readFileSync(source), ext };
}

/** Is this buffer an SVG (used when the URL/path carries no .svg extension)? */
function looksSvg(buffer) {
  const head = buffer.slice(0, 256).toString('utf8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/** First available local product as an emergency fallback (Storage 404 mid-compose). */
function firstLocalProduct() {
  try {
    const dir = require('./select-product').PRODUCTS_DIR;
    const f = fs.readdirSync(dir).find((n) => /\.(png|jpe?g|webp|svg)$/i.test(n));
    return f ? path.join(dir, f) : null;
  } catch (_) { return null; }
}

/**
 * Rasterize/resize the product image to fit a slot box, preserving alpha.
 * Accepts a local path or a Storage URL. Returns { buffer, width, height }.
 * A resolved Storage URL that 404s mid-compose falls back to a local product
 * rather than aborting the whole image (and burning a strike).
 */
async function prepareProductLayer(productSource, boxW, boxH) {
  let loaded;
  try {
    loaded = await loadAsset(productSource);
  } catch (fetchErr) {
    const fallback = firstLocalProduct();
    if (!fallback) throw fetchErr;
    console.error(`[compose] product source failed (${fetchErr.message}) — using local fallback ${path.basename(fallback)}`);
    loaded = await loadAsset(fallback);
  }
  const { buffer: srcBuffer } = loaded;
  const ext = loaded.ext || (looksSvg(srcBuffer) ? '.svg' : '');
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

  // 统一先栅格化（SVG 走 density 300），再看"实际" alpha 决定包不包白卡。
  // 不能只看文件类型/hasAlpha 元数据：现有 SVG 素材自带白底矩形，PNG 可能
  // 声明 alpha 通道却全不透明——直接压背景上会是一块生硬白板。
  const rasterized = ext === '.svg'
    ? await sharp(srcBuffer, { density: 300 })
        .resize(boxW, boxH, { fit: 'inside', background: transparent })
        .png()
        .toBuffer()
    : await sharp(srcBuffer)
        .ensureAlpha()
        .resize(boxW, boxH, { fit: 'inside', background: transparent })
        .png()
        .toBuffer();

  const stats = await sharp(rasterized).stats();
  const alphaChannel = stats.channels[3];
  const hasRealTransparency = alphaChannel && alphaChannel.min < 250;

  if (hasRealTransparency) {
    const meta = await sharp(rasterized).metadata();
    return { buffer: rasterized, width: meta.width, height: meta.height };
  }

  // 全不透明（实拍图 / 白底素材）：包白色圆角卡
  const inner = await sharp(rasterized)
    .resize(Math.round(boxW * 0.86), Math.round(boxH * 0.86), {
      fit: 'inside',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: '#FFFFFF' })
    .png()
    .toBuffer();
  const innerMeta = await sharp(inner).metadata();
  const pad = Math.round(Math.max(innerMeta.width, innerMeta.height) * 0.06);
  const cardW = innerMeta.width + pad * 2;
  const cardH = innerMeta.height + pad * 2;
  const radius = Math.round(Math.min(cardW, cardH) * 0.08);
  const cardSvg = `<svg width="${cardW}" height="${cardH}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${cardW}" height="${cardH}" rx="${radius}" fill="#FFFFFF" fill-opacity="0.96"/></svg>`;
  const buffer = await sharp(Buffer.from(cardSvg))
    .composite([{ input: inner, top: pad, left: pad }])
    .png()
    .toBuffer();
  return { buffer, width: cardW, height: cardH };
}

/**
 * Fetch a background into a Buffer. Accepts an http(s) URL (Supabase Storage)
 * or a local file path.
 */
async function loadBackground(source) {
  if (Buffer.isBuffer(source)) return source;
  if (/^https?:\/\//i.test(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const resp = await fetch(source, { signal: controller.signal });
      if (!resp.ok) throw new Error(`background fetch failed: HTTP ${resp.status}`);
      return Buffer.from(await resp.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
  if (!fs.existsSync(source)) throw new Error(`Background not found: ${source}`);
  return fs.readFileSync(source);
}

/**
 * Compose the final image.
 *
 * @param {object} opts
 * @param {Buffer|string} opts.background - buffer, URL, or local path
 * @param {string} opts.productPath - absolute path to product asset
 * @param {object} opts.texts - { title?, selling_point?, cta?, promo_badge? }
 * @param {string} [opts.productSlot] - key of brandKit.PRODUCT_SLOTS
 * @param {string} [opts.titleSlot] - key of brandKit.TITLE_SLOTS
 * @param {string} opts.outPath - output PNG path
 * @returns {Promise<{outPath: string, width: number, height: number}>}
 */
async function composeFinal(opts) {
  const bgBuffer = await loadBackground(opts.background);
  const base = sharp(bgBuffer);
  const meta = await base.metadata();
  const W = meta.width;
  const H = meta.height;
  if (!W || !H) throw new Error('Could not determine background dimensions');

  const layers = [];

  // 产品层
  let productSlot = opts.productSlot;
  let slot = brandKit.PRODUCT_SLOTS[productSlot];
  if (!slot) { productSlot = brandKit.DEFAULT_PRODUCT_SLOT; slot = brandKit.PRODUCT_SLOTS[productSlot]; }

  // 文字/产品避让：文字在中间(middle_center)时，产品让到更小更高的上方框，
  // 彻底躲开中部文字带（旧 top_center 底部仍会探到 0.5，压住文字）。
  const titleSlot = opts.titleSlot || brandKit.DEFAULT_TITLE_SLOT;
  if (titleSlot === 'middle_center') {
    slot = { cx: 0.5, cy: 0.26, w: 0.5, h: 0.32 };
  }

  const boxW = Math.round(W * slot.w);
  const boxH = Math.round(H * slot.h);
  const product = await prepareProductLayer(opts.productSource || opts.productPath, boxW, boxH);
  layers.push({
    input: product.buffer,
    left: Math.round(W * slot.cx - product.width / 2),
    top: Math.round(H * slot.cy - product.height / 2),
  });

  // Logo 层（左上）— 优先用 brand_kit 的 logo（Storage URL），退回本地占位文件
  try {
    let logoBytes = null;
    if (opts.logoUrl) {
      const { buffer } = await loadAsset(opts.logoUrl);
      logoBytes = buffer;
    } else if (fs.existsSync(brandKit.LOGO.file)) {
      logoBytes = fs.readFileSync(brandKit.LOGO.file);
    }
    if (logoBytes) {
      const logoW = Math.round(W * brandKit.LOGO.widthRatio);
      const logoBuffer = await sharp(logoBytes).resize(logoW, null, { fit: 'inside' }).png().toBuffer();
      layers.push({
        input: logoBuffer,
        left: Math.round(W * brandKit.LOGO.anchorX),
        top: Math.round(H * brandKit.LOGO.anchorY),
      });
    }
  } catch (logoErr) {
    // logo 失败不该拖垮整张图
    console.error('[compose] logo layer skipped:', logoErr.message);
  }

  // 合成基底 + 产品 + logo → 临时文件，再走文字引擎
  const stagePath = opts.outPath.replace(/\.png$/i, '') + '.stage.png';
  await base.composite(layers).png().toFile(stagePath);

  try {
    const fontFamily = opts.fonts && opts.fonts.family;
    const presets = brandKit.buildTextPresets(titleSlot, opts.colors, fontFamily);
    await applyTextOverlays(stagePath, opts.texts || {}, opts.outPath, { presets });
  } finally {
    try { fs.unlinkSync(stagePath); } catch (_) {}
  }

  if (!fs.existsSync(opts.outPath)) {
    throw new Error('Composition produced no output file');
  }
  return { outPath: opts.outPath, width: W, height: H };
}

/**
 * 开机字体自检：渲染一段 SVG 文字并检查是否产生了任何非透明像素。
 * 容器缺字体时 sharp 静默输出空白字形（July 批次线上全员无字的根因），
 * 这个探针让问题在启动日志里炸出来而不是溜进成品。
 */
async function canRenderText() {
  const svg = '<svg width="200" height="80" xmlns="http://www.w3.org/2000/svg">' +
    '<text x="10" y="50" font-family="sans-serif" font-size="40" fill="#000">Ag</text></svg>';
  try {
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    const stats = await sharp(buf).stats();
    const alpha = stats.channels[3];
    return Boolean(alpha && alpha.max > 0);
  } catch (_) {
    return false;
  }
}

module.exports = {
  composeFinal,
  prepareProductLayer,
  loadBackground,
  canRenderText,
};
