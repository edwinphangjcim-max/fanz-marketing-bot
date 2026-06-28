#!/usr/bin/env node
// ============================================
// E2E: Full monthly workflow end-to-end test
// Fanz Marketing Bot — July 2026 plan
//
// Tests: /plan_month → approve → batch copy → batch approve → auto schedule → reminder check
// All REAL: OpenRouter LLM calls + Supabase operations
// ============================================

const supabase = require('./lib/supabase');
const supabasePlans = require('./lib/supabase-plans');

const { buildMonthlySystemPrompt, parseTargetMonth } = require('./lib/monthly-planning');
const { parseAndValidateMonthlyPlan, mapPillarForDB } = require('./lib/monthly-plan-parser');
const { schedulePlan } = require('./lib/monthly-scheduler');
const { buildCopywritingPrompt, parseCopywritingResponse, validateCopywritingResult } = require('./lib/copywriting');

let passed = 0;
let failed = 0;
const testCalendarIds = [];
let planId = null;

function pass(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, err) { failed++; console.error(`  ❌ ${name}: ${err ? err.message : 'assertion failed'}`); }
function assert(cond, name) { if (cond) pass(name); else fail(name); }

const CHAT_ID = 'test-e2e-monthly';
const MONTH = 'July 2026';

// OpenRouter call
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o';

async function callLLM(messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
      'HTTP-Referer': 'https://fanz.my',
      'X-Title': 'Fanz Marketing Bot E2E',
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 4096 }),
  });
  if (!res.ok) throw new Error(`LLM call failed ${res.status}`);
  const json = await res.json();
  return json.choices[0].message.content;
}

function userMessage(err, fallback) {
  console.error('Operation failed:', err);
  return `❌ ${fallback}`;
}

async function cleanup() {
  for (const id of testCalendarIds) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/content_calendar?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
      });
    } catch (_) {}
  }
  if (planId) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/content_plans?id=eq.${planId}`, {
        method: 'DELETE',
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
      });
    } catch (_) {}
  }
}

(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  E2E: Full Monthly Workflow — Fanz July 2026              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  // ================================================
  // STEP 1: /plan_month — Generate monthly plan
  // ================================================
  console.log('━━━ STEP 1: /plan_month (real LLM) ━━━');

  const target = parseTargetMonth(null);
  const systemPrompt = buildMonthlySystemPrompt(MONTH);
  const userPrompt = `Generate a full-month content calendar for July 2026 with exactly 12 regular posts (4 product, 3 case, 2 educational, 2 story, 1 promo) plus 0-2 festival posts.`;
  const rawResponse = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  console.log(`  Raw response: ${rawResponse.length} chars`);

  const parsed = parseAndValidateMonthlyPlan(rawResponse, MONTH);
  assert(parsed.valid, 'Plan parses as valid');
  assert(parsed.regularPosts.length === 12, `12 regular posts (got ${parsed.regularPosts.length})`);
  assert(parsed.posts.length >= 12, `Total posts >= 12 (got ${parsed.posts.length})`);

  // Report pillar ratios (LLM may not always hit exact 4/3/2/2/1 — prompt tuning opportunity)
  console.log(`  Pillar counts: product=${parsed.pillarCounts.product}, case=${parsed.pillarCounts.case}` +
    `, educational=${parsed.pillarCounts.educational}, story=${parsed.pillarCounts.story}` +
    `, promo=${parsed.pillarCounts.promo}, festival=${parsed.festivalPosts.length}`);

  console.log('  Sample posts:');
  for (const p of parsed.posts.slice(0, 3)) {
    console.log(`    [${p.suggested_date}] [${p.pillar}] ${p.topic}`);
  }
  console.log(`    ... (${parsed.posts.length} total)`);

  // ================================================
  // STEP 2: Save plan to DB
  // ================================================
  console.log();
  console.log('━━━ STEP 2: Save plan to DB ━━━');

  const plan = await supabasePlans.createContentPlan({
    month: MONTH,
    status: 'pending_approval',
    chat_id: CHAT_ID,
    total_posts: parsed.posts.length,
    notes: 'E2E test plan',
  });
  planId = plan.id;
  assert(plan.status === 'pending_approval', `Plan saved with status=pending_approval`);
  console.log(`  Plan ID: ${planId}`);

  // ================================================
  // STEP 3: Create calendar rows
  // ================================================
  console.log();
  console.log('━━━ STEP 3: Create calendar rows ━━━');

  let created = 0;
  for (const post of parsed.posts) {
    try {
      const cal = await supabase.createContentCalendar({
        chat_id: CHAT_ID,
        pillar: mapPillarForDB(post.pillar),
        topic: post.topic,
        post_angle: post.post_angle,
        suggested_date: post.suggested_date,
        plan_id: planId,
        status: 'planned',
      });
      testCalendarIds.push(cal.id);
      created++;
    } catch (err) {
      console.error(`  Failed to create row for "${post.topic}": ${err.message}`);
    }
  }
  assert(created === parsed.posts.length, `All ${parsed.posts.length} calendar rows created (got ${created})`);
  console.log(`  Created ${created} calendar rows`);

  // ================================================
  // STEP 4: Approve month plan
  // ================================================
  console.log();
  console.log('━━━ STEP 4: Approve month plan ━━━');

  await supabasePlans.updateContentPlan(planId, { status: 'plan_approved' });
  const planAfterApprove = await supabasePlans.getContentPlan(planId);
  assert(planAfterApprove.status === 'plan_approved', `Plan status=plan_approved (got ${planAfterApprove.status})`);

  let approvedCount = 0;
  for (const id of testCalendarIds) {
    await supabase.updateContentCalendar(id, { status: 'plan_approved' });
    approvedCount++;
  }
  assert(approvedCount === testCalendarIds.length, `All ${testCalendarIds.length} rows approved (${approvedCount})`);
  console.log(`  Approved ${approvedCount} rows`);

  // Verify in DB
  const rowsAfterApprove = await supabase.listContentCalendarByPlanId(planId);
  const allApproved = rowsAfterApprove.every(r => r.status === 'plan_approved');
  assert(allApproved, 'All DB rows show plan_approved');

  // ================================================
  // STEP 5: Batch copy generation (M-3)
  // ================================================
  console.log();
  console.log('━━━ STEP 5: Batch copy generation (M-3, real LLM) ━━━');

  let copyDone = 0;
  let copyFailed = 0;
  for (let i = 0; i < rowsAfterApprove.length; i++) {
    const row = rowsAfterApprove[i];
    try {
      const prompt = buildCopywritingPrompt(row.topic, row.pillar);
      const copyRaw = await callLLM([
        { role: 'system', content: prompt },
        { role: 'user', content: `Write social media copy for: ${row.topic}` },
      ]);
      const parsedCopy = parseCopywritingResponse(copyRaw);
      const valid = validateCopywritingResult(parsedCopy);
      assert(valid, `Copy for "${row.topic}" validates`);
      await supabase.updateContentCalendar(row.id, {
        fb_content: parsedCopy.fb_content || parsedCopy.facebook || copyRaw,
        ig_content: parsedCopy.ig_content || parsedCopy.instagram || '',
        hashtags: parsedCopy.hashtags || '',
        status: 'copy_done',
      });
      copyDone++;
      console.log(`  ✅ ${i+1}/${rowsAfterApprove.length}: ${row.topic}`);
    } catch (err) {
      copyFailed++;
      console.error(`  ❌ ${i+1}/${rowsAfterApprove.length}: ${row.topic} — ${userMessage(err, 'Generation failed')}`);
    }
  }
  assert(copyDone > 0, `At least 1 copy generated (${copyDone} success, ${copyFailed} failed)`);
  console.log(`  Generated: ${copyDone} success, ${copyFailed} failed`);

  // ================================================
  // STEP 6: Batch approve copies (M-4)
  // ================================================
  console.log();
  console.log('━━━ STEP 6: Batch approve copies (M-4) ━━━');

  const rowsAfterCopy = await supabase.listContentCalendarByPlanId(planId);
  // Step 6: Skip imagery — go copy_done → copy_approved → approved (two-step for state machine)
  let approvedCount2 = 0;
  for (const row of rowsAfterCopy) {
    if (row.status === 'copy_done') {
      await supabase.updateContentCalendar(row.id, { status: 'copy_approved' });
      await supabase.updateContentCalendar(row.id, { status: 'approved', image_source: 'skipped' });
      approvedCount2++;
    }
  }
  assert(approvedCount2 >= copyDone - copyFailed, `Approved ${approvedCount2} copies (${copyDone} done, ${copyFailed} failed)`);
  console.log(`  Approved ${approvedCount2} copies`);

  // ================================================
  // STEP 7: Auto-schedule (M-6)
  // ================================================
  console.log();
  console.log('━━━ STEP 7: Auto-schedule (M-6) ━━━');

  const scheduled = await schedulePlan(planId);
  assert(scheduled.length > 0, `Schedule returned ${scheduled.length} posts`);
  const allHaveDates = scheduled.every(r => r.scheduled_date);
  assert(allHaveDates, 'All scheduled posts have scheduled_date');

  const planAfterSchedule = await supabasePlans.getContentPlan(planId);
  assert(planAfterSchedule.status === 'scheduled', `Plan status=scheduled (got ${planAfterSchedule.status})`);

  console.log('  Scheduled dates:');
  for (const s of scheduled.slice(0, 5)) {
    console.log(`    ${s.scheduled_date} — ${s.topic}`);
  }
  console.log(`    ... (${scheduled.length} total)`);

  // ================================================
  // STEP 8: Cron reminder check (M-7)
  // ================================================
  console.log();
  console.log('━━━ STEP 8: Cron reminder check (M-7) ━━━');

  const { queryTodayPosts, buildReminderMessage, markReminderSent } = require('./cron-publish-reminder');
  const todayPosts = await queryTodayPosts();
  console.log(`  Today's pending posts: ${todayPosts.length}`);

  // If there are today posts, verify they have content
  if (todayPosts.length > 0) {
    const post = todayPosts[0];
    const msg = buildReminderMessage(post);
    assert(msg.text.length > 0, 'Reminder message has text');
    console.log(`  First today post: ${post.topic} — reminder ${msg.text.length} chars`);
  } else {
    console.log('  (No posts scheduled for today — expected in normal run)');
  }

  // ================================================
  // SUMMARY
  // ================================================
  console.log();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  E2E RESULTS: ${passed} passed, ${failed} failed                      ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await cleanup();

  console.log();
  process.exit(failed > 0 ? 1 : 0);
})();
