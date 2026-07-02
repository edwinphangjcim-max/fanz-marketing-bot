// ============================================
// worker.js — M-5/M-6/M-7 background worker
//
// Runs inside the bot process (single Railway instance) on a fixed tick.
// Consumes DB state written by the Dashboard, so Dashboard and bot stay
// decoupled (no cross-service HTTP):
//
//   1. content_plans.status='in_production'  (set by Dashboard "Start Image
//      Generation" button) -> batch-generate imagery for every copy_approved
//      row in the plan, sequentially, then notify the plan's chat_id.
//   2. content_calendar.status='image_retry' (set by Dashboard image review
//      reject / change-scene / change-product, or left behind by Telegram
//      flow) -> regenerate. Requested scene/product changes are carried in
//      review_notes markers: "[scene] <description>" or "[product-next]".
//   3. When every active post in an in_production plan reaches
//      approved/published -> auto-run M-6 schedulePlan and notify.
//   4. Daily MYT reminder tick (M-7) -> checkTodayPosts with real senders.
//
// Concurrency model: exactly one bot process runs in production, so an
// in-memory `processing` Set is the claim mechanism. index.js's inline
// Telegram regeneration shares this Set to avoid double generation.
// Rows left in image_status='generating' by a crashed process are reset
// to 'failed' on startup (crash recovery).
// ============================================

const supabase = require('./supabase');
const supabasePlans = require('./supabase-plans');
const { runImageryPipeline } = require('./pipeline');
const { schedulePlan, formatScheduleTable } = require('./monthly-scheduler');
const { checkTodayPosts, getMalaysiaDateStr } = require('../cron-publish-reminder');
const { listProductImages, writeSourceProductImage } = require('./select-product');
const { updateImageRow } = require('./image-state');

const TICK_MS = 45_000;
const FIRST_TICK_DELAY_MS = 5_000;
const REMINDER_HOUR_MYT = 9;
const MAX_FAILURES_PER_ROW = 3; // per process lifetime; bounds API spend on persistent failures

// rowIds currently being generated (shared with index.js inline retry flow)
const processing = new Set();
// planIds we already sent a "batch started" notice for (per process)
const notifiedBatchStart = new Set();
// rowId -> consecutive failure count (per process)
const failCounts = new Map();
// rowIds we already sent a "failed 3 times" notice for
const notifiedFailure = new Set();

let senders = null; // { sendMessage, sendPhoto, sendImageReviewCard }
let timer = null;
let firstTimer = null;
let ticking = false;
let lastReminderDateMYT = null;

// ============================================
// review_notes markers written by the Dashboard image review
// ============================================

/**
 * Parse an image-action marker out of review_notes.
 * Returns { scene?: string, productNext?: boolean, raw: boolean }.
 * raw=true when review_notes carried a marker (and should be cleared after use).
 */
function parseImageMarker(reviewNotes) {
  const notes = (reviewNotes || '').trim();
  if (notes.startsWith('[scene]')) {
    return { scene: notes.slice('[scene]'.length).trim(), raw: true };
  }
  if (notes === '[product-next]') {
    return { productNext: true, raw: true };
  }
  return { raw: false };
}

/** Cycle to the next product image (same logic as the Telegram change-product exit). */
async function cycleProductImage(row) {
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
  await writeSourceProductImage(row.id, nextImage);
  return nextImage;
}

// ============================================
// Single-row generation
// ============================================

/**
 * Generate (or regenerate) imagery for one row. Handles markers, failure
 * accounting, and marker cleanup. Pipeline itself moves the row to
 * status='image_ready' on success (legal from both copy_approved and
 * image_retry).
 *
 * @param {object} row - content_calendar row
 * @param {boolean} isRetry - true when consuming an image_retry row (forces fresh regen)
 * @returns {Promise<{success: boolean, imageUrl?: string, error?: string}>}
 */
async function processRow(row, isRetry) {
  if (processing.has(row.id)) {
    return { success: false, error: 'already processing', contention: true };
  }
  processing.add(row.id);
  try {
    // Fresh read — the caller's row may be stale by the time we get here.
    const live = await supabase.getContentCalendar(row.id);
    if (!live) return { success: false, error: 'row disappeared' };
    if (live.image_status === 'generating') {
      // In flight elsewhere (e.g. old container during a deploy overlap)
      return { success: false, error: 'in flight in another process', contention: true };
    }

    const marker = parseImageMarker(live.review_notes);
    let topicOverride = null;
    let current = live;

    if (marker.productNext) {
      await cycleProductImage(live);
      // re-read so the pipeline sees the new source_product_image
      current = await supabase.getContentCalendar(row.id);
      if (!current) return { success: false, error: 'row disappeared' };
    }
    if (marker.scene) {
      topicOverride = `${current.topic || ''} — ${marker.scene}`;
    }

    // Cross-process claim: conditional PATCH image_status -> 'generating'
    // guarded on the value we just read. During a Railway deploy overlap two
    // processes can race on the same row; exactly one wins this PATCH, the
    // loser gets a TOCTOU conflict and skips WITHOUT counting a failure.
    try {
      await updateImageRow(row.id, { image_status: 'generating' }, live.image_status);
    } catch (claimErr) {
      return { success: false, error: `claim lost: ${claimErr.message}`, contention: true };
    }

    const result = await runImageryPipeline(row.id, {
      topicOverride,
      fresh: Boolean(isRetry),
    });

    if (result.success) {
      failCounts.delete(row.id);
      notifiedFailure.delete(row.id);
      if (marker.raw) {
        // marker consumed — clear it so the next retry is a plain regenerate
        await supabase.updateContentCalendar(row.id, { review_notes: null });
      }
      return result;
    }

    // Genuine failure. Release a claim the pipeline may not have cleared
    // (e.g. it failed before scene-gen took over the image_status flow),
    // otherwise the row stays 'generating' and is unclaimable until restart.
    try {
      await updateImageRow(row.id, { image_status: 'failed' }, 'generating');
    } catch (_) {
      // already moved on (scene-gen set failed itself) — fine
    }

    const fails = (failCounts.get(row.id) || 0) + 1;
    failCounts.set(row.id, fails);
    console.error(`[worker] imagery failed (${fails}/${MAX_FAILURES_PER_ROW}) for row ${row.id}: ${result.error}`);

    if (fails >= MAX_FAILURES_PER_ROW && !notifiedFailure.has(row.id) && row.chat_id && senders) {
      notifiedFailure.add(row.id);
      try {
        await senders.sendMessage(
          row.chat_id,
          `⚠️ Image generation failed ${MAX_FAILURES_PER_ROW} times for "${row.topic || row.id}".\n` +
          `You can retry, upload your own image, or skip the image from the Dashboard.`
        );
      } catch (notifyErr) {
        console.error('[worker] failure notice send error:', notifyErr.message);
      }
    }
    return result;
  } catch (err) {
    console.error(`[worker] processRow uncaught for ${row.id}:`, err.message);
    const fails = (failCounts.get(row.id) || 0) + 1;
    failCounts.set(row.id, fails);
    return { success: false, error: err.message };
  } finally {
    processing.delete(row.id);
  }
}

function isClaimable(row) {
  return (
    !processing.has(row.id) &&
    (failCounts.get(row.id) || 0) < MAX_FAILURES_PER_ROW &&
    row.image_status !== 'generating' // in-flight elsewhere (Telegram inline flow)
  );
}

// ============================================
// Tick stages
// ============================================

/** Stage 1+3: plans in production — batch imagery, then auto-schedule when done. */
async function processPlansInProduction() {
  const plans = await supabasePlans.listContentPlans({ status: 'in_production' });
  processPlansInProduction._lastPlanIds = new Set(plans.map(p => p.id));
  for (const plan of plans) {
    const rows = await supabase.listContentCalendarByPlanId(plan.id);
    const active = rows.filter(r => r.status !== 'rejected');
    if (active.length === 0) continue;

    const copyQueue = active.filter(r => r.status === 'copy_approved' && isClaimable(r));
    const retryQueue = active.filter(r => r.status === 'image_retry' && isClaimable(r));

    // "Batch started" notice: stateless DB check so a process restart
    // mid-batch does not re-announce — if any row already progressed past
    // the untouched state, the batch was announced before.
    const batchAlreadyStarted =
      active.some(r => ['image_ready', 'image_retry', 'approved', 'published'].includes(r.status)) ||
      active.some(r => r.image_status && r.image_status !== 'pending');

    if (copyQueue.length > 0 && !batchAlreadyStarted && !notifiedBatchStart.has(plan.id) && plan.chat_id && senders) {
      notifiedBatchStart.add(plan.id);
      try {
        await senders.sendMessage(
          plan.chat_id,
          `🖼️ Image generation started for ${copyQueue.length} post(s) in the ${plan.month} plan.\n` +
          `Each image takes about a minute. I will let you know when they are ready for review.`
        );
      } catch (err) {
        console.error('[worker] batch start notice error:', err.message);
      }
    }

    let processed = 0;
    for (const row of copyQueue) {
      const r = await processRow(row, false);
      if (r.success) processed++;
    }
    for (const row of retryQueue) {
      const r = await processRow(row, true);
      if (r.success) processed++;
    }

    // Re-read to evaluate plan completion
    const fresh = await supabase.listContentCalendarByPlanId(plan.id);
    const freshActive = fresh.filter(r => r.status !== 'rejected');
    if (freshActive.length === 0) continue;

    const pendingImagery = freshActive.filter(r => r.status === 'copy_approved' || r.status === 'image_retry');
    const allDecided = freshActive.every(r => r.status === 'approved' || r.status === 'published');
    const anyApproved = freshActive.some(r => r.status === 'approved');

    if (processed > 0 && pendingImagery.length === 0 && !allDecided && plan.chat_id && senders) {
      // Batch just finished this tick; images await human review
      try {
        await senders.sendMessage(
          plan.chat_id,
          `✅ Imagery is ready for the ${plan.month} plan.\n` +
          `Please review the images on the Dashboard (Marketing → Image Review).`
        );
      } catch (err) {
        console.error('[worker] batch done notice error:', err.message);
      }
    }

    if (allDecided && !anyApproved) {
      // Every active row is already published — nothing left to schedule.
      // Close the plan out so it stops being re-processed every tick.
      try {
        await supabasePlans.updateContentPlan(plan.id, { status: 'completed' });
        console.log(`[worker] plan ${plan.id} fully published — marked completed`);
      } catch (err) {
        console.error(`[worker] failed to complete plan ${plan.id}:`, err.message);
      }
      continue;
    }

    if (allDecided) {
      // M-6: every active post passed image review — auto-schedule
      try {
        const scheduledRows = await schedulePlan(plan.id); // also sets plan status='scheduled'
        console.log(`[worker] auto-scheduled plan ${plan.id}: ${scheduledRows.length} rows`);
        if (plan.chat_id && senders) {
          const table = formatScheduleTable(scheduledRows);
          await senders.sendMessage(plan.chat_id, table, { parse_mode: 'Markdown' });
          await senders.sendMessage(
            plan.chat_id,
            `📅 All posts scheduled. I will remind you on each publish day at ${REMINDER_HOUR_MYT}:00 (MYT).`
          );
        }
      } catch (err) {
        console.error(`[worker] auto-schedule failed for plan ${plan.id}:`, err.message);
      }
    }
  }
}

/** Stage 2: orphan image_retry rows outside in_production plans (incl. single-post flow). */
async function processOrphanRetries(plansInProduction) {
  const rows = await supabase.listContentCalendar({ status: 'image_retry' });
  if (!plansInProduction) {
    plansInProduction = new Set(
      (await supabasePlans.listContentPlans({ status: 'in_production' })).map(p => p.id)
    );
  }
  for (const row of rows) {
    if (row.plan_id && plansInProduction.has(row.plan_id)) continue; // handled by stage 1
    if (!isClaimable(row)) continue;
    const result = await processRow(row, true);
    if (result.success && !row.plan_id && row.chat_id && senders && senders.sendImageReviewCard) {
      // Single-post flow reviews in Telegram — send the review card there.
      // Plan rows review on the Dashboard, no Telegram card needed.
      try {
        await senders.sendImageReviewCard(row.chat_id, row.id, result.imageUrl || '(scene)', 'regenerated', result.isDryRun);
      } catch (err) {
        console.error('[worker] review card send error:', err.message);
      }
    }
  }
}

/** Stage 4: daily publish reminder (M-7). */
async function runDailyReminder() {
  if (!senders) return;
  const todayMYT = getMalaysiaDateStr();
  const nowUTC = new Date();
  const hourMYT = (nowUTC.getUTCHours() + 8) % 24;
  if (hourMYT < REMINDER_HOUR_MYT) return;
  if (lastReminderDateMYT === todayMYT) return;
  lastReminderDateMYT = todayMYT; // set before running; publish_reminder_sent makes re-runs idempotent anyway
  try {
    const result = await checkTodayPosts(senders.sendMessage, senders.sendPhoto, null);
    console.log(`[worker] daily reminder: ${result.sent} sent, ${result.failed} failed`);
  } catch (err) {
    console.error('[worker] daily reminder error:', err.message);
  }
}

// ============================================
// Crash recovery
// ============================================

/**
 * Reset rows stuck in image_status='generating' from a previous process.
 * Only one bot process exists, so at startup nothing can legitimately be
 * generating. generating -> failed is a legal image transition.
 */
async function recoverStuckRows() {
  try {
    const stuck = [];
    for (const status of ['copy_approved', 'image_retry']) {
      const rows = await supabase.listContentCalendar({ status });
      stuck.push(...rows.filter(r => r.image_status === 'generating'));
    }
    for (const row of stuck) {
      try {
        // Deliberately bypasses image-state.transitionImageStatus: this is
        // crash recovery, and generating -> failed is legal anyway.
        await supabase.updateContentCalendar(row.id, { image_status: 'failed' });
        console.log(`[worker] recovered stuck row ${row.id} (generating -> failed)`);
      } catch (err) {
        console.error(`[worker] stuck-row recovery failed for ${row.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[worker] recoverStuckRows error:', err.message);
  }
}

// ============================================
// Loop
// ============================================

async function tick() {
  if (ticking) return; // previous tick still running (image gen can exceed TICK_MS)
  ticking = true;
  try {
    await processPlansInProduction();
    await processOrphanRetries(processPlansInProduction._lastPlanIds);
    await runDailyReminder();
  } catch (err) {
    console.error('[worker] tick error:', err.message);
  } finally {
    ticking = false;
  }
}

/**
 * Start the worker.
 * @param {object} sendersArg
 * @param {Function} sendersArg.sendMessage - (chatId, text, opts) => Promise
 * @param {Function} sendersArg.sendPhoto - (chatId, urlOrBuffer, opts) => Promise
 * @param {Function} [sendersArg.sendImageReviewCard] - Telegram review card for single-flow rows
 */
function start(sendersArg) {
  if (timer) return; // already started
  senders = sendersArg;
  if (!supabase.isConfigured()) {
    console.warn('[worker] Supabase not configured — worker disabled');
    return;
  }
  recoverStuckRows().catch(() => {});
  firstTimer = setTimeout(tick, FIRST_TICK_DELAY_MS);
  timer = setInterval(tick, TICK_MS);
  console.log(`[worker] started (tick=${TICK_MS / 1000}s, daily reminder at ${REMINDER_HOUR_MYT}:00 MYT)`);
}

function stop() {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null;
  firstTimer = null;
}

module.exports = {
  start,
  stop,
  tick, // exposed for tests and manual triggering
  processing,
  processRow, // unified regeneration entry — index.js inline retry routes through this
  parseImageMarker,
  // internals exposed for tests
  _internal: {
    processRow,
    processPlansInProduction,
    processOrphanRetries,
    runDailyReminder,
    recoverStuckRows,
    isClaimable,
    failCounts,
    notifiedBatchStart,
    setLastReminderDate: (d) => { lastReminderDateMYT = d; },
    setSenders: (s) => { senders = s; }, // inject senders without starting timers (tests)
  },
};
