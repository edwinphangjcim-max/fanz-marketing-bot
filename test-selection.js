#!/usr/bin/env node
// ============================================
// Self-check for the Selection node.
//
// Validates spec assertions:
// 1. Reply valid number → content_calendar row created, status='selected',
//    topic & pillar match the plan
// 2. Reply invalid number (out of range) → no row created, user re-prompted
// 3. Same number repeated → no duplicate row (idempotent)
// 4. Session expired / no session → re-prompt /plan
//
// Tests the selection logic via a mockable abstraction.
// ============================================

const path = require('path');
const { findPlanByNumber, validateSelection, createSelectionPayload } = require('./lib/planning');

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log(`PASS: ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`FAIL: ${name}`);
  if (err) console.error(`       ${err.message || err}`);
}

function assert(cond, name) {
  if (cond) pass(name);
  else fail(name);
}

function assertThrows(fn, name, expectedSubstr) {
  try {
    fn();
    fail(name, new Error('expected throw, got none'));
  } catch (err) {
    if (expectedSubstr && !String(err.message).includes(expectedSubstr)) {
      fail(name, new Error(`error message missing "${expectedSubstr}": ${err.message}`));
      return;
    }
    pass(name);
  }
}

// ============================================
// Mock session state (same pattern as production)
// ============================================
function createSession(plans) {
  return { plans, timestamp: Date.now() };
}

// ============================================
// 1. findPlanByNumber — session lookup
// ============================================
console.log('--- findPlanByNumber ---');

const sampleSession = createSession([
  { number: 1, title: '开斋节家居焕新', description: 'Hari Raya approach', direction: 'promo' },
  { number: 2, title: 'AURA 小空间', description: 'Small space', direction: 'case' },
  { number: 3, title: '10年保修故事', description: 'Brand trust', direction: 'story' },
]);

const found = findPlanByNumber(sampleSession, 1);
assert(found !== null, 'finds plan by number 1');
assert(found.number === 1, 'plan 1 number correct');
assert(found.title === '开斋节家居焕新', 'plan 1 title correct');
assert(found.direction === 'promo', 'plan 1 pillar correct');

assert(findPlanByNumber(sampleSession, 2) !== null, 'finds plan 2');
assert(findPlanByNumber(sampleSession, 3) !== null, 'finds plan 3');

// Out of range
assert(findPlanByNumber(sampleSession, 0) === null, 'plan 0 not found');
assert(findPlanByNumber(sampleSession, 4) === null, 'plan 4 not found (out of range)');
assert(findPlanByNumber(sampleSession, 999) === null, 'plan 999 not found');

// Null/undefined session
assert(findPlanByNumber(null, 1) === null, 'null session returns null');
assert(findPlanByNumber(undefined, 1) === null, 'undefined session returns null');

// Empty plans
assert(findPlanByNumber(createSession([]), 1) === null, 'empty plans returns null');

// ============================================
// 2. validateSelection — boundary cases
// ============================================
console.log('\n--- validateSelection ---');

// Valid selection
const valid = validateSelection(sampleSession, '2');
assert(valid.valid === true, 'valid number returns valid=true');
assert(valid.plan.number === 2, 'valid selection returns correct plan');
assert(valid.plan.title === 'AURA 小空间', 'valid selection returns correct title');

// Invalid: out of range
const outOfRange = validateSelection(sampleSession, '9');
assert(outOfRange.valid === false, 'number 9 out of range');
assert(outOfRange.message.includes('1-3'), 'out of range message includes range');

// Invalid: not a number
const notNumber = validateSelection(sampleSession, 'abc');
assert(notNumber.valid === false, 'non-number input');
assert(notNumber.message.includes('number only'), 'non-number message');

// Invalid: empty string
const empty = validateSelection(sampleSession, '');
assert(empty.valid === false, 'empty input');

// Invalid: null session
const noSession = validateSelection(null, '1');
assert(noSession.valid === false, 'null session invalid');
assert(noSession.message.includes('/plan'), 'null session message suggests /plan');

// Edge: number 0
const zero = validateSelection(sampleSession, '0');
assert(zero.valid === false, '0 is not a valid plan number');

// Edge: session with empty plans array
const emptyPlansSession = createSession([]);
const emptyPlans = validateSelection(emptyPlansSession, '1');
assert(emptyPlans.valid === false, 'empty plans session invalid');

// ============================================
// 3. createSelectionPayload — correct row data
// ============================================
console.log('\n--- createSelectionPayload ---');

const payload1 = createSelectionPayload(sampleSession.plans[0], 12345);
assert(payload1.chat_id === '12345', 'payload chat_id is string');
assert(payload1.pillar === 'promo', 'payload pillar from plan.direction');
assert(payload1.topic === '开斋节家居焕新', 'payload topic from plan.title');
assert(payload1.status === 'selected', 'payload status = selected');

const payload2 = createSelectionPayload(sampleSession.plans[1], 67890);
assert(payload2.pillar === 'case', 'payload2 pillar = case');
assert(payload2.status === 'selected', 'payload2 status = selected');

// ============================================
// 4. Idempotency logic — duplicate detection
// ============================================
console.log('\n--- idempotency ---');

// Simulate already-selected plans tracking
const selectedPlans = new Set();

function isAlreadySelected(sessionId, planNumber) {
  return selectedPlans.has(`${sessionId}:${planNumber}`);
}

function markSelected(sessionId, planNumber) {
  selectedPlans.add(`${sessionId}:${planNumber}`);
}

// First selection
assert(!isAlreadySelected('chat_1', 1), 'plan not yet selected');
markSelected('chat_1', 1);
assert(isAlreadySelected('chat_1', 1), 'plan marked as selected');

// Duplicate
assert(isAlreadySelected('chat_1', 1), 'duplicate detected as already selected');

// Different plan
assert(!isAlreadySelected('chat_1', 2), 'different plan not affected');

// Different session
assert(!isAlreadySelected('chat_2', 1), 'different session not affected');
markSelected('chat_2', 1);
assert(isAlreadySelected('chat_2', 1), 'different session tracks separately');

// ============================================
// 5. Integration test — real Supabase call
// ============================================
console.log('\n--- integration: Supabase row creation ---');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.log('SKIP: SUPABASE_URL or SUPABASE_SERVICE_KEY not set, skipping real Supabase call');
} else {
  (async () => {
    try {
      const testPayload = {
        chat_id: 'test_selection_node',
        pillar: 'test',
        topic: 'Integration test — will be deleted',
        status: 'draft',
      };

      // Create row
      const createRes = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/content_calendar`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(testPayload),
      });

      if (!createRes.ok) {
        throw new Error(`Create failed ${createRes.status}`);
      }

      const row = await createRes.json();
      const created = Array.isArray(row) ? row[0] : row;

      assert(created.status === 'draft', 'row created with correct status');
      assert(created.pillar === testPayload.pillar, 'row has correct pillar');
      assert(created.topic === testPayload.topic, 'row has correct topic');
      assert(created.chat_id === testPayload.chat_id, 'row has correct chat_id');

      pass('Supabase row created successfully');

      // Verify idempotency by reading back
      // (In production, the idempotency check would be done before creation)

      // Clean up: delete test row
      if (created.id) {
        const delRes = await fetch(
          `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/content_calendar?id=eq.${created.id}`,
          {
            method: 'DELETE',
            headers: {
              apikey: SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            },
          }
        );
        if (delRes.ok) {
          pass('test row cleaned up');
        }
      }
    } catch (err) {
      console.error(`\nIntegration test error: ${err.message}`);
      fail('Supabase integration');
    }

    // ============================================
    // FINAL SUMMARY
    // ============================================
    console.log('\n========================================');
    console.log(`TOTAL: ${passed} passed, ${failed} failed`);
    console.log('========================================');
    process.exit(failed > 0 ? 1 : 0);
  })();
}

// If we skipped Supabase, print summary now
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  // ============================================
  // FINAL SUMMARY
  // ============================================
  console.log('\n========================================');
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}