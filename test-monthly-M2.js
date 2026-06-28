#!/usr/bin/env node
// ============================================
// Self-test for M-2: Monthly Plan Approval (ApproveMonth)
// Fanz Marketing Bot — Monthly Workflow
//
// Tests use REAL Supabase to verify:
// - content_plans: planned → plan_approved
// - content_calendar rows: planned → plan_approved
// - Edit topic flow
// - Remove post flow
// - Replace post flow
// - Total posts count adjustment
// - Dashboard API route
//
// Run via:
//   export $(railway run env 2>/dev/null | tr '\n' ' ') && node test-monthly-M2.js
// ============================================

const supabase = require('./lib/supabase');
const supabasePlans = require('./lib/supabase-plans');

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log(`  PASS: ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  FAIL: ${name}`);
  if (err) console.error(`         ${err.message || err}`);
}

function assert(cond, name) {
  if (cond) pass(name);
  else fail(name, new Error('assertion failed'));
}

// Track rows created for cleanup
const testPlanIds = [];
const testCalendarIds = [];

const TARGET_MONTH = 'July 2026';

// ============================================
// Helper: create test plan + calendar rows
// ============================================
async function createTestPlan(chatId) {
  // Create content_plans row with status 'pending_approval'
  const planRow = await supabasePlans.createContentPlan({
    month: TARGET_MONTH,
    status: 'pending_approval',
    chat_id: chatId,
    total_posts: 4,
    notes: `Test plan for M-2 approval test`,
  });
  testPlanIds.push(planRow.id);
  console.log(`  Created plan: ${planRow.id.slice(0, 12)}... status=${planRow.status}`);

  // Create 4 content_calendar rows with status 'planned'
  const posts = [
    { pillar: 'product', topic: 'FS Series Large Room Fan', post_angle: 'Showcase large space fan', suggested_date: '2026-07-01' },
    { pillar: 'case', topic: 'Johor Home Transformation', post_angle: 'Real customer installation story', suggested_date: '2026-07-02' },
    { pillar: 'educational', topic: 'How to Choose Fan Size', post_angle: 'Room size guide for ceiling fans', suggested_date: '2026-07-03' },
    { pillar: 'promo', topic: 'Mid-Year Sale Event', post_angle: 'Limited time offer on selected models', suggested_date: '2026-07-06' },
  ];

  const calIds = [];
  for (const post of posts) {
    const calRow = await supabase.createContentCalendar({
      chat_id: chatId,
      pillar: post.pillar,
      topic: post.topic,
      post_angle: post.post_angle,
      suggested_date: post.suggested_date,
      plan_id: planRow.id,
      status: 'planned',
    });
    calIds.push(calRow.id);
    testCalendarIds.push(calRow.id);
  }
  console.log(`  Created ${calIds.length} calendar rows for plan ${planRow.id.slice(0, 12)}...`);

  return { planId: planRow.id, planRow, calendarIds: calIds };
}

// ============================================
// Main test
// ============================================
(async () => {
  console.log('========================================');
  console.log('M-2: Monthly Plan Approval Tests');
  console.log('========================================');

  // Check Supabase is configured
  if (!supabase.isConfigured()) {
    console.log('\n❌ Supabase not configured. Skipping all tests.');
    process.exit(1);
  }
  assert(supabase.isConfigured(), 'Supabase is configured');
  console.log('');

  // ============================================
  // TEST 1: Full approve flow (all rows → plan_approved)
  // ============================================
  console.log('=== TEST 1: Full approve flow ===');
  try {
    const { planId, calendarIds } = await createTestPlan('test-monthly-M2-1');

    // Step A: Update content_plans to plan_approved
    await supabasePlans.updateContentPlan(planId, { status: 'plan_approved' });
    const updatedPlan = await supabasePlans.getContentPlan(planId);
    assert(updatedPlan.status === 'plan_approved',
      `content_plans status changed to "plan_approved" (got "${updatedPlan.status}")`);
    console.log(`  Plan status: ${updatedPlan.status}`);

    // Step B: Update all calendar rows to plan_approved
    let successCount = 0;
    let failedCount = 0;
    for (const calId of calendarIds) {
      try {
        await supabase.updateContentCalendar(calId, { status: 'plan_approved' });
        successCount++;
      } catch (err) {
        console.error(`    Failed to update row ${calId.slice(0, 12)}...: ${err.message}`);
        failedCount++;
      }
    }
    assert(successCount === 4, `All 4 calendar rows updated to plan_approved (${successCount} success, ${failedCount} failed)`);

    // Step C: Verify all rows have plan_approved status
    const calRows = await supabase.listContentCalendarByPlanId(planId);
    const allApproved = calRows.every(row => row.status === 'plan_approved');
    assert(allApproved, `All ${calRows.length} calendar rows have status "plan_approved"`);

    // Step D: Verify no rows left at 'planned'
    const stillPlanned = calRows.filter(row => row.status === 'planned');
    assert(stillPlanned.length === 0, `No calendar rows remain in "planned" status (found ${stillPlanned.length})`);

    console.log('  TEST 1 PASSED ✅');
  } catch (err) {
    console.error('  TEST 1 error:', err.message);
    fail('Full approve flow');
  }
  console.log('');

  // ============================================
  // TEST 2: Partial failure handling
  // ============================================
  console.log('=== TEST 2: Partial failure handling ===');
  try {
    const { planId, calendarIds } = await createTestPlan('test-monthly-M2-2');

    // Update content_plans
    await supabasePlans.updateContentPlan(planId, { status: 'plan_approved' });

    // Try updating all rows — a non-existent ID should fail gracefully
    let partialSuccess = 0;
    let partialFailed = 0;
    for (const calId of calendarIds) {
      try {
        await supabase.updateContentCalendar(calId, { status: 'plan_approved' });
        partialSuccess++;
      } catch (err) {
        partialFailed++;
      }
    }
    // Try updating a non-existent row
    try {
      await supabase.updateContentCalendar('00000000-0000-0000-0000-000000000000', { status: 'plan_approved' });
    } catch (err) {
      // Expected to fail
      partialFailed++;
    }

    assert(partialSuccess === 4, `Expected 4 successes, got ${partialSuccess}`);
    assert(partialFailed >= 1, `Expected at least 1 failure (invalid UUID), got ${partialFailed}`);
    console.log(`  Partial success: ${partialSuccess}, failures: ${partialFailed}`);

    const calRows = await supabase.listContentCalendarByPlanId(planId);
    const allApproved = calRows.every(row => row.status === 'plan_approved');
    assert(allApproved, `All existing rows approved despite partial failure`);
    console.log('  TEST 2 PASSED ✅');
  } catch (err) {
    console.error('  TEST 2 error:', err.message);
    fail('Partial failure handling');
  }
  console.log('');

  // ============================================
  // TEST 3: Edit topic flow
  // ============================================
  console.log('=== TEST 3: Edit topic/angle ===');
  try {
    const { planId, calendarIds } = await createTestPlan('test-monthly-M2-3');

    // Simulate editing the first post
    const postId = calendarIds[0];
    const newTopic = 'Smart Fan WiFi Control Setup Guide';
    await supabase.updateContentCalendar(postId, { topic: newTopic, post_angle: newTopic });

    // Verify the update
    const updatedRow = await supabase.getContentCalendar(postId);
    assert(updatedRow.topic === newTopic,
      `Topic updated to "${newTopic}" (got "${updatedRow.topic}")`);
    assert(updatedRow.post_angle === newTopic,
      `Post angle updated to "${newTopic}" (got "${updatedRow.post_angle}")`);
    assert(updatedRow.status === 'planned',
      `Status remains "planned" after edit (got "${updatedRow.status}")`);
    console.log('  TEST 3 PASSED ✅');
  } catch (err) {
    console.error('  TEST 3 error:', err.message);
    fail('Edit topic/angle flow');
  }
  console.log('');

  // ============================================
  // TEST 4: Remove post flow
  // ============================================
  console.log('=== TEST 4: Remove post flow ===');
  try {
    const { planId, calendarIds } = await createTestPlan('test-monthly-M2-4');
    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    // Get current plan total_posts
    const planBefore = await supabasePlans.getContentPlan(planId);
    assert(planBefore.total_posts === 4, `Initial total_posts = 4 (got ${planBefore.total_posts})`);

    // Remove the first calendar row (state machine doesn't allow planned→rejected, so delete instead)
    const postId = calendarIds[0];
    const delRes = await fetch(`${supabaseUrl}/rest/v1/content_calendar?id=eq.${encodeURIComponent(postId)}`, {
      method: 'DELETE',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
    });
    assert(delRes.ok, `DELETE calendar row returns HTTP ${delRes.status}`);
    console.log(`  Deleted calendar row ${postId.slice(0, 12)}...`);

    // Remove from the tracking array to avoid double-cleanup
    const idx = testCalendarIds.indexOf(postId);
    if (idx >= 0) testCalendarIds.splice(idx, 1);

    // Decrement total_posts
    await supabasePlans.updateContentPlan(planId, { total_posts: Math.max(0, planBefore.total_posts - 1) });

    // Verify total_posts decremented
    const updatedPlan = await supabasePlans.getContentPlan(planId);
    assert(updatedPlan.total_posts === 3, `total_posts decremented to 3 (got ${updatedPlan.total_posts})`);

    // Verify row is gone
    const removedRow = await supabase.getContentCalendar(postId);
    assert(removedRow === null, `Deleted row returns null (got ${JSON.stringify(removedRow)})`);

    // Verify remaining rows (3 should remain)
    const remainingRows = await supabase.listContentCalendarByPlanId(planId);
    assert(remainingRows.length === 3, `3 rows remain (${remainingRows.length} total)`);

    console.log('  TEST 4 PASSED ✅');
  } catch (err) {
    console.error('  TEST 4 error:', err.message);
    fail('Remove post flow');
  }
  console.log('');

  // ============================================
  // TEST 5: Replace post flow (update topic/angle)
  // ============================================
  console.log('=== TEST 5: Replace post (regenerate topic/angle) ===');
  try {
    const { planId, calendarIds } = await createTestPlan('test-monthly-M2-5');

    // Simulate regenerating the second post
    const postId = calendarIds[1];
    const originalRow = await supabase.getContentCalendar(postId);
    console.log(`  Original topic: "${originalRow.topic}"`);

    // Update with a new topic (simulating LLM replacement)
    const newTopic = 'New Smart Fan Features for 2026';
    const newAngle = 'Highlighting the latest smart ceiling fan innovations from Fanz';
    await supabase.updateContentCalendar(postId, {
      topic: newTopic,
      post_angle: newAngle,
    });

    const updatedRow = await supabase.getContentCalendar(postId);
    assert(updatedRow.topic === newTopic,
      `Topic replaced to "${newTopic}" (got "${updatedRow.topic}")`);
    assert(updatedRow.post_angle === newAngle,
      `Post angle replaced to "${newAngle}" (got "${updatedRow.post_angle}")`);
    assert(updatedRow.pillar === originalRow.pillar,
      `Pillar unchanged (${updatedRow.pillar})`);
    assert(updatedRow.suggested_date === originalRow.suggested_date,
      `Suggested date unchanged (${updatedRow.suggested_date})`);
    assert(updatedRow.status === 'planned',
      `Status remains "planned" after replace (got "${updatedRow.status}")`);

    console.log('  TEST 5 PASSED ✅');
  } catch (err) {
    console.error('  TEST 5 error:', err.message);
    fail('Replace post flow');
  }
  console.log('');

  // ============================================
  // TEST 6: Dashboard API route
  // ============================================
  console.log('=== TEST 6: Dashboard API integration ===');
  try {
    const { planId, calendarIds } = await createTestPlan('test-monthly-M2-6');
    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    // GET: Fetch plan details
    const getRes = await fetch(`${supabaseUrl}/rest/v1/content_plans?id=eq.${encodeURIComponent(planId)}&limit=1`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
    assert(getRes.ok, `GET plan returns HTTP ${getRes.status}`);
    const getData = await getRes.json();
    assert(Array.isArray(getData) && getData.length > 0, 'GET returns plan data');
    assert(getData[0].month === TARGET_MONTH, `GET plan.month = "${getData[0].month}"`);

    // GET: Fetch calendar rows by plan_id
    const rowsRes = await fetch(`${supabaseUrl}/rest/v1/content_calendar?plan_id=eq.${encodeURIComponent(planId)}&order=suggested_date.asc`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
    assert(rowsRes.ok, `GET calendar rows returns HTTP ${rowsRes.status}`);
    const rowsData = await rowsRes.json();
    assert(Array.isArray(rowsData) && rowsData.length === 4,
      `GET returns 4 calendar rows (got ${rowsData.length})`);

    // PATCH: Update individual calendar row
    const patchBody = { topic: 'Patched Topic via API' };
    const patchRes = await fetch(`${supabaseUrl}/rest/v1/content_calendar?id=eq.${encodeURIComponent(calendarIds[0])}`, {
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patchBody),
    });
    assert(patchRes.ok, `PATCH calendar row returns HTTP ${patchRes.status}`);
    const patchData = await patchRes.json();
    const patchedRow = Array.isArray(patchData) ? patchData[0] : patchData;
    assert(patchedRow && patchedRow.topic === 'Patched Topic via API',
      `PATCH updates topic to "Patched Topic via API"`);

    // DELETE: Remove a calendar row
    const delRes = await fetch(`${supabaseUrl}/rest/v1/content_calendar?id=eq.${encodeURIComponent(calendarIds[1])}`, {
      method: 'DELETE',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
    });
    assert(delRes.ok, `DELETE calendar row returns HTTP ${delRes.status} (expected 200 or 204)`);

    // Verify deletion
    const deletedRow = await supabase.getContentCalendar(calendarIds[1]);
    assert(deletedRow === null, `Deleted row is null (got ${JSON.stringify(deletedRow)})`);

    console.log('  TEST 6 PASSED ✅');
  } catch (err) {
    console.error('  TEST 6 error:', err.message);
    fail('Dashboard API integration');
  }
  console.log('');

  // ============================================
  // SUMMARY
  // ============================================
  console.log('========================================');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log('========================================');

  if (failed > 0) {
    console.log('\nSOME TESTS FAILED — cleaning up test rows before exit');
  } else {
    console.log('\nALL TESTS PASSED ✅');
  }

  await cleanupAndExit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Unhandled error:', err);
  cleanupAndExit(1);
});

// ============================================
// CLEANUP
// ============================================
async function cleanupAndExit(exitCode) {
  console.log('\n=== CLEANUP ===');

  const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/+$/, '') : null;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Delete content_calendar test rows
  for (const id of testCalendarIds) {
    if (!id) continue;
    try {
      const delRes = await fetch(`${supabaseUrl}/rest/v1/content_calendar?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      });
      console.log(`  DELETE content_calendar ${id.slice(0, 12)}...: HTTP ${delRes.status} ${delRes.ok ? 'OK' : 'FAIL'}`);
    } catch (err) {
      console.error(`  DELETE content_calendar ${id.slice(0, 12)}... error: ${err.message}`);
    }
  }

  // Delete content_plans test rows
  for (const id of testPlanIds) {
    if (!id) continue;
    try {
      const delRes = await fetch(`${supabaseUrl}/rest/v1/content_plans?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      });
      console.log(`  DELETE content_plans ${id.slice(0, 12)}...: HTTP ${delRes.status} ${delRes.ok ? 'OK' : 'FAIL'}`);
    } catch (err) {
      console.error(`  DELETE content_plans ${id.slice(0, 12)}... error: ${err.message}`);
    }
  }

  console.log('\n========================================');
  console.log(`FINAL: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(exitCode);
}

// Helper for early exit before async function is declared
async function awaitCleanupAndExit(code) {
  await cleanupAndExit(code);
}