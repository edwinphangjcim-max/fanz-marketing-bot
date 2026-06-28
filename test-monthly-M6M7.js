#!/usr/bin/env node
// ============================================
// test-monthly-M6M7.js — M-6 AutoSchedule + M-7 Cron Reminder
//
// Tests with REAL Supabase:
// 1. Create test plan with posts having suggested_dates
// 2. Run schedulePlan → verify scheduled_dates are set
// 3. Verify no two posts on same day (except festival)
// 4. Verify dates within correct month
// 5. Test cron reminder logic (time-based queries)
// 6. ALL assertions pass, exit code 0
// 7. Clean up
//
// Run:
//   export $(railway run env 2>/dev/null | tr '\n' ' ') && node test-monthly-M6M7.js
// ============================================

const assert = require('assert');

// ─── Configuration ────────────────────────────
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  process.exit(1);
}

let exitCode = 0;
const cleanupIds = []; // { type: 'plan' | 'calendar', id: string }

// ─── Helpers ──────────────────────────────────
function sep(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg) {
  console.log(`  ❌ ${msg}`);
  exitCode = 1;
}

async function supabaseRequest(method, pathAndQuery, body) {
  const fullUrl = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
  const opts = {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(fullUrl, opts);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase ${method} ${pathAndQuery} failed ${response.status}: ${err}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function createPlan(data) {
  const fullUrl = `${SUPABASE_URL}/rest/v1/content_plans`;
  const opts = {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(data),
  };
  const response = await fetch(fullUrl, opts);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase POST content_plans failed ${response.status}: ${err}`);
  }
  const result = await response.json();
  const plan = Array.isArray(result) ? result[0] : result;
  cleanupIds.push({ type: 'plan', id: plan.id });
  return plan;
}

async function createCalendarRow(data) {
  const fullUrl = `${SUPABASE_URL}/rest/v1/content_calendar`;
  const opts = {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(data),
  };
  const response = await fetch(fullUrl, opts);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase POST content_calendar failed ${response.status}: ${err}`);
  }
  const result = await response.json();
  const row = Array.isArray(result) ? result[0] : result;
  cleanupIds.push({ type: 'calendar', id: row.id });
  return row;
}

async function deletePlan(id) {
  try {
    await supabaseRequest('DELETE', `content_plans?id=eq.${id}`);
  } catch (err) {
    console.warn(`  ⚠️ Could not delete plan ${id}: ${err.message}`);
  }
}

async function deleteCalendarRow(id) {
  try {
    await supabaseRequest('DELETE', `content_calendar?id=eq.${id}`);
  } catch (err) {
    console.warn(`  ⚠️ Could not delete calendar row ${id}: ${err.message}`);
  }
}

async function getCalendarRowsByPlanId(planId) {
  return supabaseRequest('GET', `content_calendar?plan_id=eq.${planId}&order=created_at.asc`);
}

async function getCalendarRow(id) {
  const result = await supabaseRequest('GET', `content_calendar?id=eq.${id}&limit=1`);
  return Array.isArray(result) && result.length > 0 ? result[0] : null;
}

// ─── Determine test month ─────────────────────
function getTestMonth() {
  const now = new Date();
  const ms = now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000;
  const myt = new Date(ms);
  let year = myt.getFullYear();
  let monthIndex = myt.getMonth() + 1;
  if (monthIndex > 11) { monthIndex = 0; year += 1; }
  const monthName = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'][monthIndex];
  return { monthName, year, month: monthIndex + 1, monthStr: `${monthName} ${year}`,
    monthPadded: String(monthIndex + 1).padStart(2, '0') };
}

function getMalaysiaDateStr(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMalaysiaTomorrowStr() {
  const now = new Date();
  const ms = now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000;
  const myt = new Date(ms);
  myt.setUTCDate(myt.getUTCDate() + 1);
  return getMalaysiaDateStr(myt);
}

// ============================================
// Build test data — posts for test month
// ============================================
async function buildTestData() {
  const tm = getTestMonth();
  const tmStr = tm.monthStr;

  // Create test plan
  const plan = await createPlan({
    month: tmStr,
    status: 'approved',
    chat_id: 'test_M6M7',
    total_posts: 14,
    notes: 'Test plan for M6/M7',
  });

  console.log(`  Test plan created: ${plan.id} (${tmStr})`);

  // Helper: generate date strings within the test month
  function d(day) {
    return `${tm.year}-${tm.monthPadded}-${String(day).padStart(2, '0')}`;
  }

  // Create 12 regular posts + 2 festival posts
  const postsData = [
    // Regular posts spread across the month
    { pillar: 'product', topic: 'Powerful DC Motor Fan for Modern Homes', post_angle: 'Feature DC motor technology with energy savings', suggested_date: d(3) },
    { pillar: 'product', topic: 'Smart Series WiFi Ceiling Fan Review', post_angle: 'Highlight smart home integration and app control', suggested_date: d(5) },
    { pillar: 'product', topic: 'FS Series 563 L Living Room Fan', post_angle: 'Showcase large room cooling with 56" blades', suggested_date: d(8) },
    { pillar: 'product', topic: 'AURA Series Bedroom Ceiling Fan', post_angle: 'Compact design perfect for small spaces', suggested_date: d(10) },
    { pillar: 'case', topic: 'Living Room Transformation with Grande L', post_angle: 'Real customer before and after installation', suggested_date: d(12) },
    { pillar: 'case', topic: 'Master Bedroom Upgrade Story', post_angle: 'Customer shares their comfort improvement journey', suggested_date: d(15) },
    { pillar: 'case', topic: 'Dining Room Makeover with LED Fan', post_angle: 'How integrated lighting changed a dining space', suggested_date: d(17) },
    { pillar: 'educational', topic: 'How to Choose Fan Size by Room', post_angle: 'Practical guide for Malaysian homeowners', suggested_date: d(19) },
    { pillar: 'educational', topic: 'DC vs AC Motors Which Is Better', post_angle: 'Technical comparison for informed buying', suggested_date: d(22) },
    { pillar: 'story', topic: '10 Years of Cooling Malaysian Homes', post_angle: 'Brand journey and commitment to quality', suggested_date: d(24) },
    { pillar: 'story', topic: 'Our Commitment to Quality and Warranty', post_angle: 'Behind the scenes of 10-year warranty promise', suggested_date: d(26) },
    { pillar: 'promo', topic: 'Mid-Year Sale Biggest Discounts', post_angle: 'Limited time offer on all Fanz ceiling fans', suggested_date: d(28) },
    // Festival posts (pillar='story', topic contains festival keywords)
    { pillar: 'story', topic: 'Merdeka Celebration Special Greetings', post_angle: 'Patriotic celebration of Malaysian independence with Fanz fans', suggested_date: d(31) },
    { pillar: 'story', topic: 'School Holidays Family Time at Home', post_angle: 'Festive school holiday season with family comfort', suggested_date: d(20) },
  ];

  const createdRows = [];
  for (const post of postsData) {
    const row = await createCalendarRow({
      chat_id: 'test_M6M7',
      plan_id: plan.id,
      pillar: post.pillar,
      topic: post.topic,
      post_angle: post.post_angle,
      suggested_date: post.suggested_date,
      status: 'approved',
      image_source: 'ai_generated',
    });
    createdRows.push(row);
    pass(`Created row: ${row.topic} (${row.suggested_date})`);
  }

  return { plan, rows: createdRows };
}

// ============================================
// Clean up
// ============================================
async function cleanup() {
  console.log('\n─── Cleanup ────────────────────────────────────────');
  // Delete calendar rows first (foreign key), then plans
  for (const item of cleanupIds.reverse()) {
    if (item.type === 'calendar') {
      await deleteCalendarRow(item.id);
      console.log(`  🗑 Deleted calendar row ${item.id.slice(0, 8)}`);
    }
  }
  for (const item of cleanupIds) {
    if (item.type === 'plan') {
      await deletePlan(item.id);
      console.log(`  🗑 Deleted plan ${item.id.slice(0, 8)}`);
    }
  }
  console.log('  Cleanup complete.');
}

// ============================================
// Tests
// ============================================

async function testM6Schedule() {
  sep('M-6: AutoSchedule — schedulePlan');

  // Build test data
  const { plan, rows } = await buildTestData();

  // Load the scheduler module
  const { schedulePlan, formatScheduleTable, isFestivalRow } = require('./lib/monthly-scheduler');

  // Run scheduling
  console.log('  Running schedulePlan...');
  const scheduled = await schedulePlan(plan.id);

  console.log(`  Scheduled ${scheduled.length} posts`);

  // Test 1: All posts got scheduled_date
  const withoutDate = scheduled.filter(r => !r.scheduled_timestamp);
  assert.strictEqual(withoutDate.length, 0, 'All posts should have scheduled_timestamp');
  pass(`All ${scheduled.length} posts have scheduled_dates`);

  // DEBUG: Show all scheduled dates
  console.log('\n  ── Scheduled dates ──');
  for (const r of scheduled) {
    console.log(`  ${r.type === 'festival' ? '🎊' : '📝'} ${r.topic.slice(0, 40).padEnd(42)} ${r.scheduled_date} ${r.suggested_date ? '(from ' + r.suggested_date + ')' : ''}`);
  }

  // Test 2: No two regular posts on the same day
  const regularDates = scheduled
    .filter(r => r.type !== 'festival')
    .map(r => r.scheduled_date);
  const dateCounts = {};
  for (const d of regularDates) {
    dateCounts[d] = (dateCounts[d] || 0) + 1;
  }
  const duplicates = Object.entries(dateCounts).filter(([d, c]) => c > 1);
  assert.strictEqual(duplicates.length, 0, `Duplicate regular post dates: ${JSON.stringify(duplicates)}`);
  pass('No two regular posts on the same day');

  // Test 3: Max 4 posts per week for regular posts
  function getWeekOfMonth(dateStr) {
    const [y, m, day] = dateStr.split('-').map(Number);
    return Math.ceil(day / 7);
  }
  const weekCounts = {};
  for (const d of regularDates) {
    const w = getWeekOfMonth(d);
    weekCounts[w] = (weekCounts[w] || 0) + 1;
  }
  for (const [week, count] of Object.entries(weekCounts)) {
    assert.ok(count <= 4, `Week ${week} has ${count} posts (max 4)`);
  }
  pass('Max 4 regular posts per week');

  // Test 4: Festival posts can share dates with regular posts
  const festivalDates = scheduled
    .filter(r => r.type === 'festival')
    .map(r => r.scheduled_date);
  pass(`Festival posts scheduled on: ${festivalDates.join(', ') || 'none'}`);

  // Test 5: All dates within the correct month
  const tm = getTestMonth();
  for (const row of scheduled) {
    const [y, m] = row.scheduled_date.split('-').map(Number);
    assert.strictEqual(y, tm.year, `Year should be ${tm.year} but got ${y}`);
    assert.strictEqual(m, tm.month, `Month should be ${tm.month} but got ${m}`);
  }
  pass(`All dates within ${tm.monthStr}`);

  // Test 6: All scheduled_date are weekdays (Mon-Fri)
  for (const row of scheduled) {
    const [y, m, d] = row.scheduled_date.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    assert.ok(dow >= 1 && dow <= 5, `Date ${row.scheduled_date} is not a weekday (got day ${dow})`);
  }
  pass('All dates are weekdays');

  // Test 7: Plan status updated to 'scheduled'
  const planCheck = await supabaseRequest('GET', `content_plans?id=eq.${plan.id}&limit=1`);
  const planData = Array.isArray(planCheck) ? planCheck[0] : planCheck;
  assert.strictEqual(planData.status, 'scheduled', `Plan status should be 'scheduled' but got '${planData.status}'`);
  pass('Plan status updated to scheduled');

  // Test 8: formatScheduleTable produces output
  const table = formatScheduleTable(scheduled);
  assert.ok(table.length > 0, 'formatScheduleTable should produce non-empty output');
  assert.ok(table.includes('Scheduled Posts'), 'Output should contain "Scheduled Posts"');
  pass(`formatScheduleTable returns ${table.length} chars`);

  // Test 9: Verify scheduled_date stored in DB (timestamptz)
  const firstRow = scheduled[0];
  const dbRow = await getCalendarRow(firstRow.id);
  assert.ok(dbRow, 'Row should exist in DB');
  assert.ok(dbRow.scheduled_date, 'scheduled_date should be set in DB');
  const dbDate = dbRow.scheduled_date;
  assert.ok(dbDate.includes('T'), 'scheduled_date should be a timestamp (contain T)');
  pass(`scheduled_date stored in DB: ${dbDate}`);

  return { plan, scheduled };
}

async function testM7Reminder() {
  sep('M-7: Cron Reminder — queryTodayPosts');

  const tm = getTestMonth();

  // Manually set a row's scheduled_date to today at Malaysia evening time
  const now = new Date();
  const ms = now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000;
  const myt = new Date(ms);
  const todayStr = getMalaysiaDateStr(myt);
  const todayTimestamp = `${todayStr}T12:00:00+00:00`; // 8PM MYT = 12:00 UTC

  // Create a single row with scheduled_date = today
  const testPost = await createCalendarRow({
    chat_id: 'test_M7',
    pillar: 'product',
    topic: 'Today Test Post',
    post_angle: 'Test post for M7 reminder',
    suggested_date: todayStr,
    scheduled_date: todayTimestamp,
    status: 'approved',
    image_source: 'ai_generated',
    fb_content: 'Test Facebook content for reminder',
    ig_content: 'Test Instagram content for reminder',
    hashtags: '#Fanz #Test #Reminder',
    publish_reminder_sent: false,
  });

  console.log(`  Created test post with today scheduled_date: ${todayTimestamp}`);

  // Query today's posts
  const { queryTodayPosts, buildReminderMessage, markReminderSent } = require('./cron-publish-reminder');

  const todayPosts = await queryTodayPosts();
  console.log(`  Found ${todayPosts.length} today posts`);

  // Test: The new post should be in today's results
  const foundPost = todayPosts.find(r => r.id === testPost.id);
  assert.ok(foundPost, 'Test post should be in today query results');
  pass('queryTodayPosts found the test post');

  // Test: buildReminderMessage
  const { text, imageUrl } = buildReminderMessage(testPost);
  assert.ok(text.includes('Today'), 'Reminder message should contain "Today"');
  assert.ok(text.includes('Test Instagram'), 'Should include content text');
  assert.ok(text.includes('#Fanz'), 'Should include hashtags');
  assert.ok(text.includes('Please post'), 'Should include manual posting instructions');
  pass('buildReminderMessage produces valid message');

  // Test: markReminderSent
  await markReminderSent(testPost.id);
  const updatedRow = await getCalendarRow(testPost.id);
  assert.strictEqual(updatedRow.publish_reminder_sent, true, 'publish_reminder_sent should be true');
  pass('markReminderSent sets publish_reminder_sent=true');

  // Test: After marking, post should NOT appear in query
  const postsAfterMark = await queryTodayPosts();
  const stillFound = postsAfterMark.find(r => r.id === testPost.id);
  assert.strictEqual(stillFound, undefined, 'Post should not appear after marking sent');
  pass('Post excluded after publish_reminder_sent=true');

  // Clean up this test row
  await deleteCalendarRow(testPost.id);
}

async function testM6EdgeCases() {
  sep('M-6: Edge Cases');

  const { schedulePlan } = require('./lib/monthly-scheduler');
  const tm = getTestMonth();

  function d(day) {
    return `${tm.year}-${tm.monthPadded}-${String(day).padStart(2, '0')}`;
  }

  // Create a plan with only festival posts
  const festivalPlan = await createPlan({
    month: tm.monthStr,
    status: 'approved',
    chat_id: 'test_M6_festival',
    total_posts: 2,
    notes: 'Festival-only test',
  });

  const festRow1 = await createCalendarRow({
    chat_id: 'test_M6_festival',
    plan_id: festivalPlan.id,
    pillar: 'story',
    topic: 'Merdeka Celebration Festival Greetings',
    post_angle: 'Merdeka day patriotic celebration with family comfort',
    suggested_date: d(15),
    status: 'approved',
    image_source: 'ai_generated',
  });

  const festRow2 = await createCalendarRow({
    chat_id: 'test_M6_festival',
    plan_id: festivalPlan.id,
    pillar: 'story',
    topic: 'Deepavali Festival of Lights Wishes',
    post_angle: 'Deepavali festive season greetings and celebration',
    suggested_date: d(20),
    status: 'approved',
    image_source: 'ai_generated',
  });

  // Test with weekend suggested_date
  // August 31 is Malaysia National Day — if it's a weekend the scheduler handles it
  const weekendRow = await createCalendarRow({
    chat_id: 'test_M6_festival',
    plan_id: festivalPlan.id,
    pillar: 'story',
    topic: 'National Day Weekend Greetings',
    post_angle: 'Weekend merdeka celebration post',
    suggested_date: d(31),
    status: 'approved',
    image_source: 'ai_generated',
  });

  // Run on festival-only plan
  const festivalScheduled = await schedulePlan(festivalPlan.id);
  pass(`Scheduled ${festivalScheduled.length} festival-only posts`);

  // Verify festival posts have valid dates
  for (const row of festivalScheduled) {
    const [y, m] = row.scheduled_date.split('-').map(Number);
    assert.strictEqual(y, tm.year);
    assert.strictEqual(m, tm.month);
  }
  pass('Festival posts have valid dates in correct month');

  // Clean up festival plan
  await deleteCalendarRow(weekendRow.id);
  await deleteCalendarRow(festRow1.id);
  await deleteCalendarRow(festRow2.id);
  await deletePlan(festivalPlan.id);
}

// ============================================
// Main
// ============================================
(async () => {
  console.log('================================================');
  console.log('  M-6 + M-7 Tests — Monthly Scheduling + Cron');
  console.log('================================================');

  let testPlan;
  let testScheduled;

  try {
    testScheduled = await testM6Schedule();
    testPlan = testScheduled.plan;

    await testM7Reminder();

    await testM6EdgeCases();

    console.log('\n' + '='.repeat(80));
    if (exitCode === 0) {
      console.log('  🎉 ALL TESTS PASSED');
    } else {
      console.log('  ❌ SOME TESTS FAILED');
    }
    console.log('='.repeat(80));
  } catch (err) {
    console.error('\n❌ Test failure:', err);
    exitCode = 1;
  } finally {
    await cleanup();
    process.exit(exitCode);
  }
})();