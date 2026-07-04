// ============================================
// test-worker-chain.js — integration self-test for lib/worker.js
//
// Real Supabase DB (scratch rows, cleaned up at the end), stubbed Telegram
// senders (captured in-memory), OPENAI_API_KEY forcibly unset so the
// imagery pipeline runs in dry-run mode (fast, free — the dry-run boundary
// is exactly the GPT Image 2 HTTP call, everything else is real).
//
// Chain under test:
//   plan in_production -> worker batch imagery -> image_ready
//   -> dashboard-style reject with [scene] marker -> worker regenerates
//   -> approve all -> worker auto-schedules (M-6) -> scheduled_date set
//   -> daily reminder (M-7) delivers to row.chat_id and marks sent
//   -> approved -> published transition (mp: callback equivalent)
//
// Run: source .env first, then: node test-worker-chain.js
//
// WARNING: do NOT run while any REAL plan is in_production on the shared
// DB — worker.tick() scans in_production plans globally, so this dry-run
// process could claim real rows and stamp them with placeholder images
// (and the deployed worker could equally claim this test's rows).
// Check first: content_plans where status='in_production'.
// ============================================

process.env.OPENAI_API_KEY = ''; // force dry-run imagery

const supabase = require('./lib/supabase');
const supabasePlans = require('./lib/supabase-plans');
const worker = require('./lib/worker');
const cron = require('./cron-publish-reminder');

const SCRATCH_CHAT = 'test-worker-chain';
let passCount = 0;
let failCount = 0;

function pass(msg) { passCount++; console.log(`PASS: ${msg}`); }
function fail(msg, err) { failCount++; console.error(`FAIL: ${msg}${err ? ' — ' + err.message : ''}`); }
function assert(cond, msg) { if (cond) pass(msg); else fail(msg); }

// Captured stub senders
const sentMessages = [];
const senders = {
  sendMessage: async (chatId, text, opts) => { sentMessages.push({ chatId, text, opts }); },
  sendPhoto: async (chatId, photo, opts) => { sentMessages.push({ chatId, photo, opts, isPhoto: true }); },
  sendImageReviewCard: async (chatId, rowId) => { sentMessages.push({ chatId, rowId, isCard: true }); },
};

async function cleanup(planId, rowIds) {
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  for (const id of rowIds) {
    await fetch(`${url}/rest/v1/content_calendar?id=eq.${id}`, { method: 'DELETE', headers: h });
  }
  if (planId) {
    await fetch(`${url}/rest/v1/content_plans?id=eq.${planId}`, { method: 'DELETE', headers: h });
  }
  console.log(`cleanup: removed ${rowIds.length} rows + plan ${planId || '(none)'}`);
}

(async () => {
  if (!supabase.isConfigured()) {
    console.error('Supabase not configured. source .env first.');
    process.exit(1);
  }

  let planId = null;
  const rowIds = [];

  try {
    // ─── Setup: scratch plan with 2 copy_approved rows ───
    const plan = await supabasePlans.createContentPlan({
      month: 'TEST-WORKER 0000',
      status: 'plan_approved',
      chat_id: SCRATCH_CHAT,
      total_posts: 2,
      notes: 'test-worker-chain scratch',
    });
    planId = plan.id;

    for (const topic of ['Worker chain test post A', 'Worker chain test post B']) {
      const row = await supabase.createContentCalendar({
        chat_id: SCRATCH_CHAT,
        pillar: 'product',
        topic,
        status: 'planned',
        plan_id: planId,
        suggested_date: '2026-09-15',
        fb_content: 'FB test content',
        ig_content: 'IG test content',
        hashtags: '#FANZ #Test',
      });
      rowIds.push(row.id);
      // planned -> plan_approved -> copy_done -> copy_approved (legal path)
      await supabase.updateContentCalendar(row.id, { status: 'plan_approved' });
      await supabase.updateContentCalendar(row.id, { status: 'copy_done' });
      await supabase.updateContentCalendar(row.id, { status: 'copy_approved' });
    }
    pass('setup: plan + 2 rows at copy_approved');

    // ─── Step 1: Dashboard "Start Image Generation" equivalent ───
    await supabasePlans.updateContentPlan(planId, { status: 'in_production' });

    // ─── Step 2: worker tick — batch imagery (dry-run) ───
    worker._internal.setSenders(senders); // inject stub senders (no timers)
    worker._internal.setLastReminderDate(cron.getMalaysiaDateStr()); // suppress reminder during imagery ticks
    await worker.tick();

    let rows = await supabase.listContentCalendarByPlanId(planId);
    assert(rows.every(r => r.status === 'image_ready'), 'batch imagery: both rows -> image_ready');
    assert(sentMessages.some(m => m.chatId === SCRATCH_CHAT && /Image generation started/i.test(m.text || '')),
      'batch imagery: start notification sent to plan chat');
    assert(sentMessages.some(m => m.chatId === SCRATCH_CHAT && /ready/i.test(m.text || '')),
      'batch imagery: completion notification sent');

    // ─── Step 3: Dashboard image review — approve A, change_scene B ───
    const [rowA, rowB] = rows.sort((a, b) => a.topic.localeCompare(b.topic));
    await supabase.updateContentCalendar(rowA.id, { status: 'approved' });
    await supabase.updateContentCalendar(rowB.id, {
      status: 'image_retry',
      review_notes: '[scene] a rooftop garden at sunset',
    });
    pass('image review: A approved, B rejected with [scene] marker');

    // ─── Step 4: worker tick — regenerate B with scene marker ───
    await worker.tick();
    const rowB2 = await supabase.getContentCalendar(rowB.id);
    assert(rowB2.status === 'image_ready', 'retry: B regenerated -> image_ready');
    assert(!rowB2.review_notes, 'retry: [scene] marker cleared after consumption');

    // ─── Step 5: approve B -> worker tick -> auto-schedule (M-6) ───
    await supabase.updateContentCalendar(rowB.id, { status: 'approved' });
    await worker.tick();

    rows = await supabase.listContentCalendarByPlanId(planId);
    assert(rows.every(r => r.scheduled_date), 'auto-schedule: both rows got scheduled_date');
    const planAfter = await supabasePlans.getContentPlan(planId);
    assert(planAfter.status === 'scheduled', 'auto-schedule: plan status -> scheduled');
    assert(sentMessages.some(m => /Scheduled Posts/i.test(m.text || '')),
      'auto-schedule: schedule table sent to plan chat');

    // ─── Step 6: M-7 reminder — schedule row A for today (MYT), fire reminder ───
    const todayMYT = cron.getMalaysiaDateStr();
    await supabase.updateContentCalendar(rowA.id, {
      scheduled_date: `${todayMYT}T12:00:00+08:00`,
    });
    worker._internal.setLastReminderDate(null); // allow reminder to run this tick
    const before = sentMessages.length;
    await worker._internal.runDailyReminder();
    const reminderMsgs = sentMessages.slice(before).filter(m => m.chatId === SCRATCH_CHAT);
    assert(reminderMsgs.length >= 1, 'reminder: delivered to row.chat_id (no explicit chatId passed)');
    const withButton = reminderMsgs.find(m =>
      JSON.stringify(m.opts || {}).includes(`mp:${rowA.id}`));
    assert(Boolean(withButton), 'reminder: carries Mark-as-Published button (mp:rowId)');
    const rowA2 = await supabase.getContentCalendar(rowA.id);
    assert(rowA2.publish_reminder_sent === true, 'reminder: publish_reminder_sent marked after delivery');

    // ─── Step 7: landmine check — log-only run must NOT consume reminders ───
    await supabase.updateContentCalendar(rowB.id, {
      scheduled_date: `${todayMYT}T13:00:00+08:00`,
    });
    const logOnly = await cron.checkTodayPosts(null, null, null);
    const rowB3 = await supabase.getContentCalendar(rowB.id);
    assert(rowB3.publish_reminder_sent === false && logOnly.skipped >= 1,
      'landmine: log-only run skips without marking reminder_sent');

    // ─── Step 8: mp: equivalent — approved -> published ───
    await supabase.updateContentCalendar(rowA.id, { status: 'published' });
    const rowA3 = await supabase.getContentCalendar(rowA.id);
    assert(rowA3.status === 'published', 'mark-published: approved -> published transition');

  } catch (err) {
    fail('unexpected error', err);
  } finally {
    worker.stop();
    try {
      await cleanup(planId, rowIds);
    } catch (e) {
      console.error('cleanup failed (manual cleanup needed):', e.message);
    }
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
})();
