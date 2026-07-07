// ============================================
// pipeline.js — 配图流水线编排 [I-5]（合成版）
//
// 新链路：文案 → 背景 prompt（LLM）→ 纯背景生成（云端存储）→
//         确定性合成（产品 + logo + 文字模板）→ 成品上传 → image_ready
//
// compose_spec (jsonb) 记录合成的全部输入（背景 URL/产品/文字/位置），
// Dashboard 改字/换产品后只需 recomposeOnly 重合成——不再调图像 AI，
// 秒级完成、零生成成本。背景存 Supabase Storage，跨部署可用。
//
// compose_spec 列缺失时降级运行（不落 spec，只警告），部署顺序无关；
// 但 Dashboard 编辑功能依赖该列（migration: alter table content_calendar
// add column if not exists compose_spec jsonb）。
// ============================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const supabase = require('./supabase');
const { generateBackground } = require('./background-gen');
const { composeFinal } = require('./compose');
const { extractTextsFromRow } = require('./text-overlay');
const { storeFinalImage } = require('./store-image');
const { updateImageRow } = require('./image-state');
const { PRODUCTS_DIR, selectProductImage, writeSourceProductImage } = require('./select-product');
const brandKit = require('./brand-kit');
const brand = require('./brand');

/**
 * Normalize compose_spec from the row (PostgREST returns jsonb as object,
 * but tolerate a stringified value).
 */
function readSpec(row) {
  const raw = row.compose_spec;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

/** Best-effort spec persistence — tolerate a missing compose_spec column. */
async function saveSpec(rowId, spec) {
  try {
    await supabase.updateContentCalendar(rowId, { compose_spec: spec });
    return true;
  } catch (err) {
    console.error(`[pipeline] compose_spec not persisted (column missing?): ${err.message}`);
    return false;
  }
}

/**
 * Resolve which product asset to compose. source_product_image 是唯一事实源
 * （Dashboard 换产品 / worker [product-next] 都写这一列）。
 *
 * 解析顺序：brand_assets（Dashboard 上传的真实素材，按 name 匹配，返回
 * Storage URL）→ 本地 assets/products/ 兜底（brand_assets 为空/DB 不可用）
 * → 自动选图。返回 { name, source, slot? }，source 可为 URL 或本地路径。
 */
async function resolveProduct(row) {
  const name = row.source_product_image || null;

  // 1) brand_assets（云端真实素材库）
  if (name) {
    try {
      const asset = await brand.getProductAssetByName(name);
      if (asset && asset.public_url) {
        return { name: asset.name, source: asset.public_url, slot: asset.default_product_slot || null };
      }
    } catch (_) { /* DB 不可用 → 落到本地兜底 */ }
  }

  // 2) 本地 assets/products/ 兜底 —— 仅当 name 像文件名（带图片扩展名）。
  //    source_product_image 也可能是 brand_assets 的显示名（如 "Grande L Fan"），
  //    那种名字 path.join 到本地永远不存在，跳过这层直接落到云端库兜底。
  const looksLikeFilename = name && /\.(png|jpe?g|webp|svg)$/i.test(name);
  const fromRow = looksLikeFilename ? path.join(PRODUCTS_DIR, name) : null;
  if (fromRow && fs.existsSync(fromRow)) {
    return { name, source: fromRow, slot: null };
  }

  // 3) 云端库有产品但名字对不上 → 用云端第一个 active，别无声乱换
  try {
    const list = await brand.listProductAssets();
    if (list.length > 0) {
      if (name) console.error(`[pipeline] product "${name}" not found — using first active brand asset "${list[0].name}"`);
      try { await writeSourceProductImage(row.id, list[0].name); } catch (_) {}
      return { name: list[0].name, source: list[0].public_url, slot: list[0].default_product_slot || null };
    }
  } catch (_) {}

  // 4) 本地自动选图（最终兜底）
  if (name) console.error(`[pipeline] product "${name}" unresolved anywhere — auto-selecting from local library`);
  const picked = selectProductImage(row.pillar || 'product', row.topic || '');
  if (picked && fs.existsSync(picked.filepath)) {
    try { await writeSourceProductImage(row.id, picked.filename); } catch (_) {}
    return { name: picked.filename, source: picked.filepath, slot: null };
  }
  throw new Error('No usable product image found');
}

/**
 * Run the imagery pipeline for a content_calendar row.
 *
 * @param {string} rowId - content_calendar row UUID
 * @param {object} [opts]
 * @param {string} [opts.topicOverride] - reviewer scene request ("change scene"),
 *   passed to background prompt derivation; forces a new background
 * @param {boolean} [opts.fresh] - clear image_url so store-image's idempotency
 *   guard does not silently keep the old final image (any regenerate/recompose)
 * @param {boolean} [opts.recomposeOnly] - reuse the existing background from
 *   compose_spec and only re-run the deterministic composition (change text /
 *   change product). Falls back to generating a background if none exists.
 * @returns {Promise<{success: boolean, imageUrl?: string, error?: string, isDryRun?: boolean}>}
 */
async function runImageryPipeline(rowId, opts = {}) {
  try {
    // Step 0: Read the row
    const row = await supabase.getContentCalendar(rowId);
    if (!row) {
      return { success: false, error: 'Row not found' };
    }

    // Claim if the caller (worker) hasn't already. Conditional PATCH —
    // a lost race means another process owns this row.
    if (row.image_status !== 'generating') {
      await updateImageRow(rowId, { image_status: 'generating' }, row.image_status || 'pending');
    }

    if (opts.fresh) {
      await supabase.updateContentCalendar(rowId, { image_url: null });
      row.image_url = null;
    }

    // 品牌套件（色板/声音/背景风格/logo/默认版式）——DB 挂了返回内置默认，不崩
    const kit = await brand.getBrandKit();

    const spec = readSpec(row);
    const product = await resolveProduct(row);
    spec.v = 1;
    spec.product = product.name;
    // 版式默认改由 brand_kit 决定（Dashboard 可调），素材自带的默认摆位次之
    spec.product_slot = spec.product_slot || product.slot ||
      (kit.default_layout && kit.default_layout.product_slot) || brandKit.DEFAULT_PRODUCT_SLOT;
    spec.title_slot = spec.title_slot ||
      (kit.default_layout && kit.default_layout.title_slot) || brandKit.DEFAULT_TITLE_SLOT;
    // 文字：spec（Dashboard 编辑过）优先，否则从 row 提取（默认 title=topic）
    spec.texts = (spec.texts && Object.keys(spec.texts).length > 0)
      ? spec.texts
      : extractTextsFromRow(row);

    // ─── Step 1: Background（生成 or 复用）───
    const reuseBackground = Boolean(
      opts.recomposeOnly && spec.background_url && !opts.topicOverride
    );

    if (!reuseBackground) {
      const bg = await generateBackground(row, opts.topicOverride || null, kit.background_style);
      if (!bg.success) {
        await releaseClaim(rowId);
        return { success: false, error: bg.error || 'Background generation failed' };
      }
      if (bg.dryRun) {
        // dry-run 红线：只跳过图像 API 那一下；状态机走完
        await updateImageRow(rowId, { image_status: 'generated' }, 'generating');
        await supabase.updateContentCalendar(rowId, { status: 'image_ready' });
        return { success: true, imageUrl: '(dry-run)', isDryRun: true };
      }
      spec.background_url = bg.backgroundUrl;
      spec.background_prompt = bg.prompt;
      // scene_image_url 同步存背景 URL（Dashboard/排查可见）
      await supabase.updateContentCalendar(rowId, { scene_image_url: bg.backgroundUrl });
    }

    // ─── Step 2: 确定性合成 ───
    const outPath = path.join(
      os.tmpdir(),
      `final-${rowId.replace(/-/g, '').slice(0, 12)}-${Date.now()}.png`
    );
    try {
      await composeFinal({
        background: spec.background_url,
        productSource: product.source,
        texts: spec.texts,
        productSlot: spec.product_slot,
        titleSlot: spec.title_slot,
        colors: kit.colors,
        logoUrl: kit.logo_url,
        fonts: kit.fonts,
        outPath,
      });

      // ─── Step 3: 成品上传 ───
      const storeResult = await storeFinalImage(rowId, outPath);
      if (!storeResult.success) {
        await releaseClaim(rowId);
        return { success: false, error: storeResult.error || 'Image storage failed' };
      }

      // ─── Step 4: 落 spec + 状态 ───
      // 成品已入库（image_url 已写），主状态先行；image_status 收尾失败
      // 只记日志不翻盘——recoverStuckRows 会兜住滞留的 generating。
      await saveSpec(rowId, spec);
      await supabase.updateContentCalendar(rowId, { status: 'image_ready' });
      try {
        await updateImageRow(rowId, { image_status: 'generated' }, 'generating');
      } catch (flipErr) {
        console.error(`[pipeline] image_status flip failed (non-fatal, row stored): ${flipErr.message}`);
      }

      return { success: true, imageUrl: storeResult.imageUrl, isDryRun: false };
    } finally {
      try { fs.unlinkSync(outPath); } catch (_) {}
    }
  } catch (err) {
    await releaseClaim(rowId);
    return { success: false, error: err.message };
  }
}

/**
 * Release the claim to 'failed' — from whatever image_status the row is
 * actually in (a post-store failure can leave it at 'generated', where a
 * fixed generating→failed guard would silently no-op and strand the claim).
 */
async function releaseClaim(rowId) {
  try {
    const row = await supabase.getContentCalendar(rowId);
    if (row && row.image_status === 'generating') {
      await updateImageRow(rowId, { image_status: 'failed' }, 'generating');
    }
  } catch (_) {
    // already moved on / transient read failure — recoverStuckRows兜底
  }
}

module.exports = {
  runImageryPipeline,
};
