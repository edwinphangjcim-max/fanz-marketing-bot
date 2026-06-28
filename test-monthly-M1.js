#!/usr/bin/env node
// ============================================
// Self-test for M-1: /plan_month command
// Fanz Marketing Bot — Monthly Workflow
//
// Tests use REAL LLM calls (OpenRouter) and REAL Supabase.
// Run via:
//   export $(railway run env 2>/dev/null | tr '\n' ' ') && node test-monthly-M1.js
// ============================================

const path = require('path');

// Load production modules
const { buildMonthlySystemPrompt, parseTargetMonth } = require('./lib/monthly-planning');
const { parseAndValidateMonthlyPlan, mapPillarForDB } = require('./lib/monthly-plan-parser');
const supabase = require('./lib/supabase');
const supabasePlans = require('./lib/supabase-plans');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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
// Parse target month for testing (use July 2026)
// ============================================
const TARGET_MONTH = '2026-07';
const TARGET_MONTH_STR = 'July 2026';

// ============================================
// Unit tests for helper functions
// ============================================
console.log('=== UNIT: parseTargetMonth ===');

// With no input → defaults to next month
const defaultParse = parseTargetMonth(null);
assert(typeof defaultParse.monthName === 'string' && defaultParse.monthName.length > 0,
  'parseTargetMonth(null) returns valid monthName');
assert(typeof defaultParse.year === 'number' && defaultParse.year >= 2026,
  'parseTargetMonth(null) returns valid year');
assert(typeof defaultParse.monthIndex === 'number' && defaultParse.monthIndex >= 0 && defaultParse.monthIndex <= 11,
  'parseTargetMonth(null) returns valid monthIndex');

// With YYYY-MM input
const dashParse = parseTargetMonth('2026-07');
assert(dashParse.monthName === 'July', `parseTargetMonth('2026-07') monthName = "${dashParse.monthName}"`);
assert(dashParse.year === 2026, `parseTargetMonth('2026-07') year = ${dashParse.year}`);
assert(dashParse.monthIndex === 6, `parseTargetMonth('2026-07') monthIndex = ${dashParse.monthIndex}`);
assert(dashParse.monthStr === 'July 2026', `parseTargetMonth('2026-07') monthStr = "${dashParse.monthStr}"`);

// With text input
const textParse = parseTargetMonth('August 2026');
assert(textParse.monthName === 'August', `parseTargetMonth('August 2026') monthName = "${textParse.monthName}"`);
assert(textParse.year === 2026, `parseTargetMonth('August 2026') year = ${textParse.year}`);
assert(textParse.monthIndex === 7, `parseTargetMonth('August 2026') monthIndex = ${textParse.monthIndex}`);

console.log('\n=== UNIT: buildMonthlySystemPrompt ===');

const prompt = buildMonthlySystemPrompt(TARGET_MONTH_STR);
assert(prompt.includes('July 2026'), 'prompt contains target month string');
assert(prompt.includes('exactly 12 regular posts'), 'prompt specifies 12 regular posts');
assert(prompt.includes('product: 4'), 'prompt specifies product: 4');
assert(prompt.includes('case: 3'), 'prompt specifies case: 3');
assert(prompt.includes('educational: 2'), 'prompt specifies educational: 2');
assert(prompt.includes('story: 2'), 'prompt specifies story: 2');
assert(prompt.includes('promo: 1'), 'prompt specifies promo: 1');
assert(prompt.includes('festival'), 'prompt mentions festival posts');
assert(prompt.includes('JSON'), 'prompt demands JSON output');
assert(prompt.includes('FS Series') && prompt.includes('Grande L Series'), 'prompt includes product series');
assert(prompt.includes('SIRIM'), 'prompt includes brand identity');

console.log('\n=== UNIT: parseAndValidateMonthlyPlan ===');

// 1. Valid JSON with correct structure
const validJson = JSON.stringify([
  { pillar: 'product', topic: 'FS Series Large Living Room Fan', post_angle: 'Showcase our premium large space fan', suggested_date: '2026-07-01' },
  { pillar: 'product', topic: 'Smart Series WiFi Control', post_angle: 'Highlight app control convenience', suggested_date: '2026-07-02' },
  { pillar: 'product', topic: 'Grande L LED Light Fan', post_angle: 'Dual function living room solution', suggested_date: '2026-07-03' },
  { pillar: 'product', topic: 'AURA Compact Bedroom Fan', post_angle: 'Perfect for small spaces and bedrooms', suggested_date: '2026-07-07' },
  { pillar: 'case', topic: 'Johor Home Transformation', post_angle: 'Real customer installation story', suggested_date: '2026-07-08' },
  { pillar: 'case', topic: 'Singapore Condo Makeover', post_angle: 'Space-saving fan solution', suggested_date: '2026-07-09' },
  { pillar: 'case', topic: 'Living Room Renovation', post_angle: 'Before and after with Fanz ceiling fan', suggested_date: '2026-07-10' },
  { pillar: 'educational', topic: 'How to Choose Fan Size', post_angle: 'Room size guide for ceiling fans', suggested_date: '2026-07-14' },
  { pillar: 'educational', topic: 'DC vs AC Motor Guide', post_angle: 'Energy saving comparison', suggested_date: '2026-07-15' },
  { pillar: 'story', topic: '10 Years of Trust', post_angle: 'Brand journey story', suggested_date: '2026-07-16' },
  { pillar: 'story', topic: 'Our Commitment to Quality', post_angle: 'Behind the scenes at Fanz', suggested_date: '2026-07-17' },
  { pillar: 'promo', topic: 'Mid-Year Sale Event', post_angle: 'Limited time offer on selected models', suggested_date: '2026-07-21' },
  { pillar: 'festival', topic: 'Hari Raya Greetings', post_angle: 'Festive warm wishes from Fanz', suggested_date: '2026-07-22' },
]);

let parsed = parseAndValidateMonthlyPlan(validJson, TARGET_MONTH_STR);
assert(parsed.valid === true, 'valid JSON with correct structure: valid=true');
assert(parsed.posts.length === 13, `valid JSON: ${parsed.posts.length} total posts (expected 13)`);
assert(parsed.regularPosts.length === 12, `valid JSON: ${parsed.regularPosts.length} regular posts (expected 12)`);
assert(parsed.festivalPosts.length === 1, `valid JSON: ${parsed.festivalPosts.length} festival posts (expected 1)`);
assert(parsed.errors.length === 0, `valid JSON: 0 errors (got ${parsed.errors.length})`);

// 2. Wrong pillar ratios
const badRatioJson = JSON.stringify([
  { pillar: 'product', topic: 'Post 1', post_angle: 'Angle 1', suggested_date: '2026-07-01' },
  { pillar: 'product', topic: 'Post 2', post_angle: 'Angle 2', suggested_date: '2026-07-02' },
  { pillar: 'product', topic: 'Post 3', post_angle: 'Angle 3', suggested_date: '2026-07-03' },
  { pillar: 'product', topic: 'Post 4', post_angle: 'Angle 4', suggested_date: '2026-07-07' },
  { pillar: 'case', topic: 'Post 5', post_angle: 'Angle 5', suggested_date: '2026-07-08' },
  { pillar: 'case', topic: 'Post 6', post_angle: 'Angle 6', suggested_date: '2026-07-09' },
  { pillar: 'case', topic: 'Post 7', post_angle: 'Angle 7', suggested_date: '2026-07-10' },
  { pillar: 'educational', topic: 'Post 8', post_angle: 'Angle 8', suggested_date: '2026-07-14' },
  { pillar: 'educational', topic: 'Post 9', post_angle: 'Angle 9', suggested_date: '2026-07-15' },
  { pillar: 'story', topic: 'Post 10', post_angle: 'Angle 10', suggested_date: '2026-07-16' },
  { pillar: 'story', topic: 'Post 11', post_angle: 'Angle 11', suggested_date: '2026-07-17' },
  { pillar: 'promo', topic: 'Post 12', post_angle: 'Angle 12', suggested_date: '2026-07-21' },
  // promo should be 1, got 1 — all correct
]);

parsed = parseAndValidateMonthlyPlan(badRatioJson, TARGET_MONTH_STR);
assert(parsed.valid === true, 'correct ratios: valid=true');

// 3. Wrong pillar ratio (missing story)
const missingStoryJson = JSON.stringify([
  { pillar: 'product', topic: 'Post 1', post_angle: 'Angle 1', suggested_date: '2026-07-01' },
  { pillar: 'product', topic: 'Post 2', post_angle: 'Angle 2', suggested_date: '2026-07-02' },
  { pillar: 'product', topic: 'Post 3', post_angle: 'Angle 3', suggested_date: '2026-07-03' },
  { pillar: 'product', topic: 'Post 4', post_angle: 'Angle 4', suggested_date: '2026-07-07' },
  { pillar: 'case', topic: 'Post 5', post_angle: 'Angle 5', suggested_date: '2026-07-08' },
  { pillar: 'case', topic: 'Post 6', post_angle: 'Angle 6', suggested_date: '2026-07-09' },
  { pillar: 'case', topic: 'Post 7', post_angle: 'Angle 7', suggested_date: '2026-07-10' },
  { pillar: 'educational', topic: 'Post 8', post_angle: 'Angle 8', suggested_date: '2026-07-14' },
  { pillar: 'educational', topic: 'Post 9', post_angle: 'Angle 9', suggested_date: '2026-07-15' },
  { pillar: 'promo', topic: 'Post 10', post_angle: 'Angle 10', suggested_date: '2026-07-16' },
  { pillar: 'promo', topic: 'Post 11', post_angle: 'Angle 11', suggested_date: '2026-07-17' },
  { pillar: 'promo', topic: 'Post 12', post_angle: 'Angle 12', suggested_date: '2026-07-21' },
]);

parsed = parseAndValidateMonthlyPlan(missingStoryJson, TARGET_MONTH_STR);
assert(parsed.valid === false, 'missing story pillar: valid=false');
const hasStoryError = parsed.errors.some(e => e.includes('story'));
assert(hasStoryError, 'missing story pillar: error mentions story');

// 4. Duplicate dates (non-festival)
const duplicateDateJson = JSON.stringify([
  { pillar: 'product', topic: 'Post 1', post_angle: 'Angle 1', suggested_date: '2026-07-01' },
  { pillar: 'product', topic: 'Post 2', post_angle: 'Angle 2', suggested_date: '2026-07-01' },
  { pillar: 'product', topic: 'Post 3', post_angle: 'Angle 3', suggested_date: '2026-07-02' },
  { pillar: 'product', topic: 'Post 4', post_angle: 'Angle 4', suggested_date: '2026-07-03' },
  { pillar: 'case', topic: 'Post 5', post_angle: 'Angle 5', suggested_date: '2026-07-07' },
  { pillar: 'case', topic: 'Post 6', post_angle: 'Angle 6', suggested_date: '2026-07-08' },
  { pillar: 'case', topic: 'Post 7', post_angle: 'Angle 7', suggested_date: '2026-07-09' },
  { pillar: 'educational', topic: 'Post 8', post_angle: 'Angle 8', suggested_date: '2026-07-10' },
  { pillar: 'educational', topic: 'Post 9', post_angle: 'Angle 9', suggested_date: '2026-07-14' },
  { pillar: 'story', topic: 'Post 10', post_angle: 'Angle 10', suggested_date: '2026-07-15' },
  { pillar: 'story', topic: 'Post 11', post_angle: 'Angle 11', suggested_date: '2026-07-16' },
  { pillar: 'promo', topic: 'Post 12', post_angle: 'Angle 12', suggested_date: '2026-07-17' },
]);

parsed = parseAndValidateMonthlyPlan(duplicateDateJson, TARGET_MONTH_STR);
assert(parsed.valid === false, 'duplicate non-festival dates: valid=false');
const hasDupError = parsed.errors.some(e => e.includes('duplicate date'));
assert(hasDupError, 'duplicate dates: error mentions duplicate date');

// 5. Weekend date
const weekendDateJson = JSON.stringify([
  { pillar: 'product', topic: 'Post 1', post_angle: 'Angle 1', suggested_date: '2026-07-05' }, // Sunday
  { pillar: 'product', topic: 'Post 2', post_angle: 'Angle 2', suggested_date: '2026-07-06' }, // Monday
  { pillar: 'product', topic: 'Post 3', post_angle: 'Angle 3', suggested_date: '2026-07-07' },
  { pillar: 'product', topic: 'Post 4', post_angle: 'Angle 4', suggested_date: '2026-07-08' },
  { pillar: 'case', topic: 'Post 5', post_angle: 'Angle 5', suggested_date: '2026-07-09' },
  { pillar: 'case', topic: 'Post 6', post_angle: 'Angle 6', suggested_date: '2026-07-10' },
  { pillar: 'case', topic: 'Post 7', post_angle: 'Angle 7', suggested_date: '2026-07-14' },
  { pillar: 'educational', topic: 'Post 8', post_angle: 'Angle 8', suggested_date: '2026-07-15' },
  { pillar: 'educational', topic: 'Post 9', post_angle: 'Angle 9', suggested_date: '2026-07-16' },
  { pillar: 'story', topic: 'Post 10', post_angle: 'Angle 10', suggested_date: '2026-07-17' },
  { pillar: 'story', topic: 'Post 11', post_angle: 'Angle 11', suggested_date: '2026-07-21' },
  { pillar: 'promo', topic: 'Post 12', post_angle: 'Angle 12', suggested_date: '2026-07-22' },
]);

parsed = parseAndValidateMonthlyPlan(weekendDateJson, TARGET_MONTH_STR);
assert(parsed.valid === false, 'weekend date: valid=false');
// The Saturday post should be caught, the rest should be fine but ratios may be off
const hasWeekendError = parsed.errors.some(e => e.includes('weekend'));
assert(hasWeekendError, 'weekend date: error mentions weekend');

// 6. JSON with markdown code fences
const fenceJson = '```json\n' + validJson + '\n```';
parsed = parseAndValidateMonthlyPlan(fenceJson, TARGET_MONTH_STR);
assert(parsed.valid === true, 'JSON with markdown fences parses correctly');

// 7. Empty/invalid input
parsed = parseAndValidateMonthlyPlan('not json at all', TARGET_MONTH_STR);
assert(parsed.valid === false, 'invalid input: valid=false');
assert(parsed.posts.length === 0, 'invalid input: 0 posts parsed');

// ============================================
// Summary (unit tests)
// ============================================
console.log('\n========================================');
console.log(`UNIT TESTS: ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failed > 0) {
  console.log('FAILURES DETECTED — exiting with code 1');
  awaitCleanupAndExit(1);
}

// ============================================
// Integration test — real OpenRouter + Supabase
// ============================================
console.log('\n=== INTEGRATION: Real LLM + Supabase /plan_month flow ===');

if (!OPENROUTER_API_KEY) {
  console.log('SKIP: OPENROUTER_API_KEY not set, skipping real LLM call');
  console.log('\n========================================');
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(0);
}

async function callOpenRouter(messages) {
  const MODEL = process.env.MODEL || 'gpt-4o';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://fanz-marketing-bot.railway.app',
      'X-Title': 'Fanz Marketing Bot Test'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: messages,
      max_tokens: 3000,
      temperature: 0.8
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

(async () => {
  try {
    // Step 1: Call LLM with monthly planning prompt
    console.log('  Calling OpenRouter with monthly planning prompt...');
    const systemPrompt = buildMonthlySystemPrompt(TARGET_MONTH_STR);
    const userPrompt = `Generate a full-month content calendar for ${TARGET_MONTH_STR} with exactly 12 regular posts (4 product, 3 case, 2 educational, 2 story, 1 promo) plus 0-2 festival posts. Ensure all product series are featured.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const rawResponse = await callOpenRouter(messages);
    console.log(`  Raw response length: ${rawResponse.length} chars`);

    // Step 2: Parse and validate
    const parsed = parseAndValidateMonthlyPlan(rawResponse, TARGET_MONTH_STR);
    console.log(`  Parsed: ${parsed.posts.length} posts, valid=${parsed.valid}`);

    if (!parsed.valid) {
      console.error('  Validation errors:');
      for (const err of parsed.errors) {
        console.error(`    • ${err}`);
      }
      fail('LLM response parses into valid monthly plan');
    } else {
      pass('LLM response parses into valid monthly plan');
    }

    // Step 3: Verify pillar ratios
    if (parsed.regularPosts.length === 12) {
      pass(`12 regular posts (got ${parsed.regularPosts.length})`);

      const expectedRatios = { product: 4, case: 3, educational: 2, story: 2, promo: 1 };
      let ratiosOk = true;
      for (const [pillar, expected] of Object.entries(expectedRatios)) {
        const actual = parsed.pillarCounts[pillar] || 0;
        if (actual !== expected) {
          console.error(`    Pillar "${pillar}": expected ${expected}, got ${actual}`);
          ratiosOk = false;
        }
      }
      if (ratiosOk) pass('All pillar ratios match expected counts');
      else fail('Some pillar ratios do not match');
    } else {
      fail(`12 regular posts (got ${parsed.regularPosts.length})`);
    }

    // Step 4: Verify each post has all required fields
    let allHaveFields = true;
    for (let i = 0; i < parsed.posts.length; i++) {
      const post = parsed.posts[i];
      if (!post.pillar || !post.topic || !post.post_angle || !post.suggested_date) {
        console.error(`    Post #${i + 1} missing required fields: ${JSON.stringify(post)}`);
        allHaveFields = false;
      }
      // Verify date is within target month
      if (post.suggested_date && !post.suggested_date.startsWith('2026-07')) {
        console.error(`    Post #${i + 1} date "${post.suggested_date}" not in July 2026`);
        allHaveFields = false;
      }
    }
    if (allHaveFields) pass('All posts have pillar, topic, post_angle, suggested_date within target month');
    else fail('Some posts missing required fields or have out-of-month dates');

    // Step 5: Check festival posts
    if (parsed.festivalPosts.length >= 0 && parsed.festivalPosts.length <= 2) {
      pass(`Festival posts: ${parsed.festivalPosts.length} (valid range 0-2)`);
    } else {
      fail(`Festival posts: ${parsed.festivalPosts.length} (expected 0-2)`);
    }

    // Step 6: Create content_plans row in Supabase
    if (!supabase.isConfigured()) {
      console.log('  SKIP: Supabase not configured, skipping DB persistence tests');
    } else {
      console.log('  Creating content_plans row...');
      let planId = null;
      try {
        const planRow = await supabasePlans.createContentPlan({
          month: TARGET_MONTH_STR,
          status: 'pending_approval',
          chat_id: 'test-monthly-M1',
          total_posts: parsed.regularPosts.length + parsed.festivalPosts.length,
          notes: `Test plan from test-monthly-M1.js`,
        });
        planId = planRow.id;
        testPlanIds.push(planId);
        console.log(`    Created plan: ${planId}`);

        assert(planRow.month === TARGET_MONTH_STR, `content_plans.month = "${planRow.month}" (expected "${TARGET_MONTH_STR}")`);
        assert(planRow.status === 'pending_approval', `content_plans.status = "${planRow.status}"`);
        assert(planRow.chat_id === 'test-monthly-M1', `content_plans.chat_id = "${planRow.chat_id}"`);
        pass('content_plans row created with correct month and pending_approval status');
      } catch (err) {
        fail('content_plans row created with correct month and pending_approval status', err);
      }

      // Step 7: Create content_calendar rows linked to plan
      if (planId) {
        console.log('  Creating content_calendar rows...');
        let createdCount = 0;
        const errors = [];

        for (const post of parsed.posts) {
          try {
            const calRow = await supabase.createContentCalendar({
              chat_id: 'test-monthly-M1',
              pillar: mapPillarForDB(post.pillar),
              topic: post.topic,
              post_angle: post.post_angle,
              suggested_date: post.suggested_date,
              plan_id: planId,
              status: 'planned',
            });
            testCalendarIds.push(calRow.id);
            createdCount++;
          } catch (err) {
            errors.push(err.message);
          }
        }

        if (createdCount === parsed.posts.length) {
          pass(`All ${createdCount}/${parsed.posts.length} content_calendar rows created`);
        } else {
          fail(`Created ${createdCount}/${parsed.posts.length} content_calendar rows`, errors.length > 0 ? new Error(errors[0]) : undefined);
        }

        // Step 8: Verify plan_id link - list by plan_id
        try {
          const byPlanId = await supabase.listContentCalendarByPlanId(planId);
          assert(Array.isArray(byPlanId), 'listContentCalendarByPlanId returns array');
          assert(byPlanId.length === createdCount,
            `listContentCalendarByPlanId has ${byPlanId.length} rows (expected ${createdCount})`);
          // Verify all rows have plan_id set
          const allLinked = byPlanId.every(row => row.plan_id === planId);
          assert(allLinked, 'All content_calendar rows linked to correct plan_id');
          pass('content_calendar rows correctly linked via plan_id');
        } catch (err) {
          fail('content_calendar rows correctly linked via plan_id', err);
        }

        // Step 9: Verify each calendar row has the expected fields
        try {
          const byPlanId = await supabase.listContentCalendarByPlanId(planId);
          let allComplete = true;
          for (const row of byPlanId) {
            if (!row.pillar || !row.topic || !row.post_angle || !row.suggested_date || !row.plan_id || !row.status) {
              console.error(`    Row ${row.id} missing fields:`, JSON.stringify(row));
              allComplete = false;
            }
            if (row.status !== 'planned') {
              console.error(`    Row ${row.id} has status "${row.status}" (expected "planned")`);
              allComplete = false;
            }
          }
          if (allComplete) pass('All calendar rows have correct fields and planned status');
          else fail('Some calendar rows have incorrect fields or status');
        } catch (err) {
          fail('Calendar row field verification', err);
        }
      }
    }

    // Log sample output
    console.log('\n--- Sample Generated Plan ---');
    const sortedPosts = [...parsed.posts].sort((a, b) => a.suggested_date.localeCompare(b.suggested_date));
    for (const post of sortedPosts) {
      console.log(`  [${post.suggested_date}] [${post.pillar}] ${post.topic}`);
    }
    console.log(`  Pillar counts:`, JSON.stringify(parsed.pillarCounts));
    console.log(`  Festival posts: ${parsed.festivalPosts.length}`);

  } catch (err) {
    console.error(`\nIntegration test error: ${err.message}`);
    console.error(err.stack);
    failed++;
    fail('real OpenRouter + Supabase integration call');
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
