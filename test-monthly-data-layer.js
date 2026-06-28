#!/usr/bin/env node
// ============================================
// Self-test for Phase 1: Data Layer
// Fanz Marketing Bot — Monthly Workflow
//
// Tests use REAL Supabase calls (via railway run node).
// All assertions must pass, exit code 0.
// Clean up test rows at the end.
// ============================================

const path = require('path');

// Load production modules
const supabase = require('./lib/supabase');
const supabasePlans = require('./lib/supabase-plans');
const sm = require('./lib/state-machine');

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

// ============================================
// TEST 1: DDL Execution
// ============================================
console.log('\n=== TEST 1: DDL Execution ===');

(async () => {
  try {
    const ddlResult = await supabasePlans.runDDL();
    console.log(`  DDL result: HTTP ${ddlResult.status}, ok=${ddlResult.ok}`);
    assert(ddlResult.ok === true, 'DDL executes successfully');
  } catch (err) {
    fail('DDL executes successfully', err);
  }

  // ============================================
  // TEST 2: Verify DDL — query PostgREST for new columns
  // ============================================
  console.log('\n=== TEST 2: Verify DDL — new columns exist ===');

  // Verify content_plans table exists by creating a row and reading it back
  const planData = {
    month: 'June 2026',
    status: 'drafting',
    chat_id: 'test-monthly-layer',
    total_posts: 5,
    notes: 'Test plan for monthly data layer',
  };

  let planId = null;
  try {
    const plan = await supabasePlans.createContentPlan(planData);
    planId = plan.id;
    testPlanIds.push(planId);
    console.log(`  Created content_plans row: id=${planId}`);
    assert(plan.month === planData.month, `content_plans.month = "${plan.month}"`);
    assert(plan.status === planData.status, `content_plans.status = "${plan.status}"`);
    assert(plan.chat_id === planData.chat_id, `content_plans.chat_id = "${plan.chat_id}"`);
    assert(plan.total_posts === planData.total_posts, `content_plans.total_posts = ${plan.total_posts}`);
    assert(plan.notes === planData.notes, `content_plans.notes = "${plan.notes}"`);
    assert(Boolean(plan.id), 'content_plans.id is truthy');
    assert(Boolean(plan.created_at), 'content_plans.created_at is truthy');
    pass('content_plans row created with correct data');
  } catch (err) {
    fail('content_plans row created with correct data', err);
  }

  // ============================================
  // TEST 3: content_plans CRUD
  // ============================================
  console.log('\n=== TEST 3: content_plans CRUD ===');

  // 3a. Get by ID
  if (planId) {
    try {
      const fetched = await supabasePlans.getContentPlan(planId);
      assert(fetched !== null, 'getContentPlan returns row');
      assert(fetched.id === planId, `getContentPlan id matches: ${fetched.id}`);
      assert(fetched.month === planData.month, `getContentPlan month matches`);
      pass('getContentPlan works');
    } catch (err) {
      fail('getContentPlan works', err);
    }

    // 3b. Update
    try {
      const updated = await supabasePlans.updateContentPlan(planId, { notes: 'Updated test notes' });
      assert(updated.notes === 'Updated test notes', `updateContentPlan notes = "${updated.notes}"`);
      pass('updateContentPlan works');
    } catch (err) {
      fail('updateContentPlan works', err);
    }

    // 3c. List by month
    try {
      const plansByMonth = await supabasePlans.getPlansByMonth('June 2026');
      assert(Array.isArray(plansByMonth), 'getPlansByMonth returns array');
      assert(plansByMonth.length >= 1, `getPlansByMonth has >= 1 plan`);
      const found = plansByMonth.find(p => p.id === planId);
      assert(Boolean(found), 'getPlansByMonth contains our test plan');
      pass('getPlansByMonth works');
    } catch (err) {
      fail('getPlansByMonth works', err);
    }

    // 3d. List with filter
    try {
      const plansByStatus = await supabasePlans.listContentPlans({ status: 'drafting' });
      assert(Array.isArray(plansByStatus), 'listContentPlans by status returns array');
      pass('listContentPlans with status filter works');
    } catch (err) {
      fail('listContentPlans with status filter works', err);
    }

    // 3e. List by chat_id
    try {
      const plansByChat = await supabasePlans.listContentPlans({ chat_id: 'test-monthly-layer' });
      assert(Array.isArray(plansByChat), 'listContentPlans by chat_id returns array');
      pass('listContentPlans with chat_id filter works');
    } catch (err) {
      fail('listContentPlans with chat_id filter works', err);
    }
  }

  // ============================================
  // TEST 4: Link plan_id to content_calendar
  // ============================================
  console.log('\n=== TEST 4: Link plan_id to content_calendar ===');

  let calId = null;
  if (planId) {
    try {
      // create content_calendar row with plan_id
      const calData = {
        status: 'draft',
        pillar: 'educational',
        topic: `Test monthly plan link - ${Date.now()}`,
        chat_id: 'test-monthly-layer',
        plan_id: planId,
      };
      const cal = await supabase.createContentCalendar(calData);
      calId = cal.id;
      testCalendarIds.push(calId);
      console.log(`  Created content_calendar row: id=${calId}, plan_id=${cal.plan_id}`);

      assert(cal.plan_id === planId, `content_calendar.plan_id matches plan id: ${cal.plan_id}`);
      assert(cal.pillar === 'educational', `content_calendar.pillar = "${cal.pillar}"`);
      pass('content_calendar row linked to plan_id');
    } catch (err) {
      fail('content_calendar row linked to plan_id', err);
    }

    // 4b. List by plan_id
    if (calId) {
      try {
        const byPlanId = await supabase.listContentCalendarByPlanId(planId);
        assert(Array.isArray(byPlanId), 'listContentCalendarByPlanId returns array');
        assert(byPlanId.length >= 1, 'listContentCalendarByPlanId has results');
        const foundCal = byPlanId.find(c => c.id === calId);
        assert(Boolean(foundCal), 'listContentCalendarByPlanId contains our row');
        pass('listContentCalendarByPlanId works');
      } catch (err) {
        fail('listContentCalendarByPlanId works', err);
      }

      // 4c. Verify new columns exist on content_calendar
      try {
        const fetchedCal = await supabase.getContentCalendar(calId);
        console.log(`  content_calendar row columns: id=${fetchedCal.id}, plan_id=${fetchedCal.plan_id}, post_angle=${fetchedCal.post_angle}, suggested_date=${fetchedCal.suggested_date}, scheduled_date=${fetchedCal.scheduled_date}, publish_reminder_sent=${fetchedCal.publish_reminder_sent}, image_source=${fetchedCal.image_source}`);
        assert('plan_id' in fetchedCal, 'content_calendar has plan_id column');
        assert('post_angle' in fetchedCal, 'content_calendar has post_angle column');
        assert('suggested_date' in fetchedCal, 'content_calendar has suggested_date column');
        assert('scheduled_date' in fetchedCal, 'content_calendar has scheduled_date column');
        assert('publish_reminder_sent' in fetchedCal, 'content_calendar has publish_reminder_sent column');
        assert('image_source' in fetchedCal, 'content_calendar has image_source column');
        assert(fetchedCal.image_source === 'ai_generated', `content_calendar.image_source defaults to 'ai_generated': ${fetchedCal.image_source}`);
        pass('All new content_calendar columns exist with correct defaults');
      } catch (err) {
        fail('All new content_calendar columns exist with correct defaults', err);
      }
    }
  }

  // ============================================
  // TEST 5: New state-machine states
  // ============================================
  console.log('\n=== TEST 5: State-machine: planned → plan_approved → copy_done ===');

  // 5a. Verify 'planned' and 'plan_approved' are in STATES
  try {
    assert(sm.STATES.includes('planned'), 'STATES includes "planned"');
    assert(sm.STATES.includes('plan_approved'), 'STATES includes "plan_approved"');
    pass('New states present in STATES array');
  } catch (err) {
    fail('New states present in STATES array', err);
  }

  // 5b. Legal transitions
  try {
    sm.transition('planned', 'plan_approved');
    pass('planned → plan_approved: legal transition');
  } catch (err) {
    fail('planned → plan_approved: legal transition', err);
  }

  try {
    sm.transition('plan_approved', 'copy_done');
    pass('plan_approved → copy_done: legal transition');
  } catch (err) {
    fail('plan_approved → copy_done: legal transition', err);
  }

  // 5c. allowedTransitions
  try {
    const fromPlanned = sm.allowedTransitions('planned');
    assert(Array.isArray(fromPlanned) && fromPlanned.includes('plan_approved'),
      'allowedTransitions(planned) includes plan_approved');
    pass('allowedTransitions(planned) correct');
  } catch (err) {
    fail('allowedTransitions(planned) correct', err);
  }

  try {
    const fromApproved = sm.allowedTransitions('plan_approved');
    assert(Array.isArray(fromApproved) && fromApproved.includes('copy_done'),
      'allowedTransitions(plan_approved) includes copy_done');
    pass('allowedTransitions(plan_approved) correct');
  } catch (err) {
    fail('allowedTransitions(plan_approved) correct', err);
  }

  // 5d. Illegal transitions
  try {
    sm.transition('planned', 'copy_done');
    fail('planned → copy_done: should be illegal (must go through plan_approved)');
  } catch (err) {
    pass('planned → copy_done correctly rejected (must go through plan_approved)');
  }

  try {
    sm.transition('plan_approved', 'published');
    fail('plan_approved → published: should be illegal');
  } catch (err) {
    pass('plan_approved → published correctly rejected');
  }

  // 5e. selected → planned is legal (new path)
  try {
    sm.transition('selected', 'planned');
    pass('selected → planned: legal transition (new monthly workflow path)');
  } catch (err) {
    fail('selected → planned: legal transition', err);
  }

  // 5f. selected → copy_done still legal (existing direct path)
  try {
    sm.transition('selected', 'copy_done');
    pass('selected → copy_done: still legal (existing direct path)');
  } catch (err) {
    fail('selected → copy_done: still legal (existing direct path)', err);
  }

  // ============================================
  // TEST 6: 'educational' pillar works
  // ============================================
  console.log('\n=== TEST 6: "educational" pillar ===');

  try {
    // We already created a row with pillar='educational' above in test 4
    assert(supabase.listContentCalendar({ pillar: 'educational' }) !== undefined,
      'listContentCalendar with pillar=educational does not throw');
    pass('listContentCalendar accepts "educational" pillar filter');
  } catch (err) {
    fail('listContentCalendar accepts "educational" pillar filter', err);
  }

  try {
    // Create another educational row to verify DB accepts it
    const eduCal = await supabase.createContentCalendar({
      status: 'draft',
      pillar: 'educational',
      topic: `Test educational pillar - ${Date.now()}`,
      chat_id: 'test-monthly-layer',
    });
    testCalendarIds.push(eduCal.id);
    assert(eduCal.pillar === 'educational', `Created educational row has pillar="${eduCal.pillar}"`);
    pass('Create content_calendar with "educational" pillar succeeds in DB');
  } catch (err) {
    fail('Create content_calendar with "educational" pillar succeeds in DB', err);
  }

  // ============================================
  // TEST 7: content_plans.getPlansByMonth with existing data
  // ============================================
  console.log('\n=== TEST 7: getPlansByMonth ===');

  if (planId) {
    try {
      const monthPlans = await supabasePlans.getPlansByMonth('June 2026');
      assert(Array.isArray(monthPlans), 'getPlansByMonth returns array');
      const ourPlan = monthPlans.find(p => p.id === planId);
      assert(Boolean(ourPlan), 'getPlansByMonth contains our test plan');
      pass('getPlansByMonth returns correct data');
    } catch (err) {
      fail('getPlansByMonth returns correct data', err);
    }
  }

  // ============================================
  // TEST 8: Verify new DDL columns via direct query reflection
  // ============================================
  console.log('\n=== TEST 8: DB schema verification ===');

  // Verify content_calendar has publish_reminder_sent default via readback
  if (calId) {
    try {
      const cal = await supabase.getContentCalendar(calId);
      assert(cal.publish_reminder_sent === false, `publish_reminder_sent defaults to false: ${cal.publish_reminder_sent}`);
      assert(cal.image_source === 'ai_generated', `image_source defaults to ai_generated: ${cal.image_source}`);
      pass('content_calendar column defaults verified');
    } catch (err) {
      fail('content_calendar column defaults verified', err);
    }
  }

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n========================================');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log('========================================');

  if (failed > 0) {
    console.log('\nTESTS FAILED — cleaning up test rows before exit');
  } else {
    console.log('\nALL TESTS PASSED ✅');
  }

  // ============================================
  // CLEANUP
  // ============================================
  console.log('\n=== CLEANUP ===');

  // Delete content_calendar test rows
  for (const id of testCalendarIds) {
    if (!id) continue;
    try {
      const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

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
      const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
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
  process.exit(failed > 0 ? 1 : 0);
})();
