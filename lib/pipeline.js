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
 * Resolve which product asset to compose. source_product_image 是唯一
 * 事实源（Dashboard 换产品 / worker [product-next] 都写这一列），
 * spec.product 只作记录。
 */
async function resolveProduct(row) {
  const fromRow = row.source_product_image
    ? path.join(PRODUCTS_DIR, row.source_product_image)
    : null;
  if (fromRow && fs.existsSync(fromRow)) {
    return { filename: row.source_product_image, filepath: fromRow };
  }
  if (row.source_product_image) {
    // Dashboard 的产品清单是手工同步的——素材漂移时别无声换产品
    console.error(`[pipeline] source_product_image "${row.source_product_image}" not in assets/products — falling back to auto-select`);
  }
  const picked = selectProductImage(row.pillar || 'product', row.topic || '');
  if (picked && fs.existsSync(picked.filepath)) {
    try { await writeSourceProductImage(row.id, picked.filename); } catch (_) {}
    return picked;
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

    const spec = readSpec(row);
    const product = await resolveProduct(row);
    spec.v = 1;
    spec.product = product.filename;
    spec.product_slot = spec.product_slot || brandKit.DEFAULT_PRODUCT_SLOT;
    spec.title_slot = spec.title_slot || brandKit.DEFAULT_TITLE_SLOT;
    // 文字：spec（Dashboard 编辑过）优先，否则从 row 提取（默认 title=topic）
    spec.texts = (spec.texts && Object.keys(spec.texts).length > 0)
      ? spec.texts
      : extractTextsFromRow(row);

    // ─── Step 1: Background（生成 or 复用）───
    const reuseBackground = Boolean(
      opts.recomposeOnly && spec.background_url && !opts.topicOverride
    );

    if (!reuseBackground) {
      const bg = await generateBackground(row, opts.topicOverride || null);
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
        productPath: product.filepath,
        texts: spec.texts,
        productSlot: spec.product_slot,
        titleSlot: spec.title_slot,
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
