#!/usr/bin/env node
// ============================================
// Self-check for the data layer (lib/supabase.js)
// and state machine (lib/state-machine.js).
//
// Does NOT hit Supabase or require any env vars.
// Verifies: module structure, function signatures, state-machine logic.
//
// Exit code 0 on full pass; non-zero on any failure.
// ============================================

const path = require('path');

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

function assertDoesNotThrow(fn, name) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(name, err);
  }
}

// ============================================
// 1. lib/supabase.js — module + signatures
// ============================================
console.log('--- lib/supabase.js ---');
const supabasePath = path.join(__dirname, 'lib', 'supabase.js');
let supabase;
try {
  supabase = require(supabasePath);
  pass('lib/supabase.js loads');
} catch (err) {
  fail('lib/supabase.js loads', err);
  process.exit(1);
}

const supabaseFns = [
  'createContentCalendar',
  'getContentCalendar',
  'listContentCalendar',
  'updateContentCalendar',
  'getPendingReview',
];
for (const fn of supabaseFns) {
  assert(typeof supabase[fn] === 'function', `supabase.${fn} is a function`);
}

// All CRUD fns should be async (return a promise when called without env).
// We can't safely invoke them (would need fetch + env), but constructor check via .constructor.name.
for (const fn of supabaseFns) {
  if (typeof supabase[fn] === 'function') {
    assert(
      supabase[fn].constructor.name === 'AsyncFunction',
      `supabase.${fn} is async`
    );
  }
}

// ============================================
// 2. lib/state-machine.js — module + signatures
// ============================================
console.log('\n--- lib/state-machine.js ---');
const smPath = path.join(__dirname, 'lib', 'state-machine.js');
let sm;
try {
  sm = require(smPath);
  pass('lib/state-machine.js loads');
} catch (err) {
  fail('lib/state-machine.js loads', err);
  process.exit(1);
}

const smFns = ['transition', 'nextStatus', 'allowedTransitions'];
for (const fn of smFns) {
  assert(typeof sm[fn] === 'function', `state-machine.${fn} is a function`);
}
assert(Array.isArray(sm.STATES) && sm.STATES.length > 0, 'STATES array exported');
assert(sm.TRANSITIONS && typeof sm.TRANSITIONS === 'object', 'TRANSITIONS map exported');

// ============================================
// 3. Legal transitions
// ============================================
console.log('\n--- legal transitions ---');
assertDoesNotThrow(() => sm.transition('draft', 'planning_done'), 'draft → planning_done legal');
assertDoesNotThrow(() => sm.transition('planning_done', 'selected'), 'planning_done → selected legal');
assertDoesNotThrow(() => sm.transition('selected', 'copy_done'), 'selected → copy_done legal');
assertDoesNotThrow(() => sm.transition('copy_done', 'pending_review'), 'copy_done → pending_review legal');
assertDoesNotThrow(() => sm.transition('pending_review', 'approved'), 'pending_review → approved legal');
assertDoesNotThrow(() => sm.transition('pending_review', 'rejected'), 'pending_review → rejected legal');
assertDoesNotThrow(() => sm.transition('approved', 'published'), 'approved → published legal');
assertDoesNotThrow(() => sm.transition('rejected', 'copy_done'), 'rejected → copy_done legal (re-do path)');

// ============================================
// 4. Illegal transitions — must throw
// ============================================
console.log('\n--- illegal transitions ---');
assertThrows(() => sm.transition('draft', 'published'), 'draft → published illegal');
assertThrows(() => sm.transition('draft', 'approved'), 'draft → approved illegal (no skipping)');
assertThrows(() => sm.transition('draft', 'selected'), 'draft → selected illegal (no skipping)');
assertThrows(() => sm.transition('planning_done', 'approved'), 'planning_done → approved illegal');
assertThrows(() => sm.transition('selected', 'published'), 'selected → published illegal');
assertThrows(() => sm.transition('copy_done', 'approved'), 'copy_done → approved illegal (review required)');
assertThrows(() => sm.transition('pending_review', 'published'), 'pending_review → published illegal (must approve first)');

// ============================================
// 5. Idempotency — published is terminal
// ============================================
console.log('\n--- published terminal (idempotent) ---');
assertThrows(() => sm.transition('published', 'draft'), 'published → draft illegal', 'terminal');
assertThrows(() => sm.transition('published', 'approved'), 'published → approved illegal', 'terminal');
assertThrows(() => sm.transition('published', 'pending_review'), 'published → pending_review illegal', 'terminal');
assertThrows(() => sm.transition('published', 'published'), 'published → published illegal', 'terminal');

// ============================================
// 6. Invalid status names
// ============================================
console.log('\n--- invalid status names ---');
assertThrows(() => sm.transition('foo', 'draft'), 'unknown current status throws');
assertThrows(() => sm.transition('draft', 'bar'), 'unknown target status throws');
assertThrows(() => sm.transition(null, 'draft'), 'null current status throws');
assertThrows(() => sm.allowedTransitions('nope'), 'allowedTransitions(unknown) throws');

// ============================================
// 7. allowedTransitions returns the correct set per state
// ============================================
console.log('\n--- allowedTransitions sets ---');
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = a.slice().sort();
  const sb = b.slice().sort();
  return sa.every((v, i) => v === sb[i]);
}

const expected = {
  draft: ['planning_done'],
  planning_done: ['selected'],
  selected: ['copy_done'],
  copy_done: ['pending_review'],
  pending_review: ['approved', 'rejected'],
  approved: ['published'],
  rejected: ['copy_done'],
  published: [],
};

for (const [from, want] of Object.entries(expected)) {
  const got = sm.allowedTransitions(from);
  assert(sameSet(got, want), `allowedTransitions("${from}") = [${want.join(', ')}]`);
}

// allowedTransitions must return a COPY (mutation-safe)
const copy = sm.allowedTransitions('draft');
copy.push('hacked');
const fresh = sm.allowedTransitions('draft');
assert(!fresh.includes('hacked'), 'allowedTransitions returns a fresh copy (mutation-safe)');

// ============================================
// 8. nextStatus — happy-path forward
// ============================================
console.log('\n--- nextStatus ---');
assert(sm.nextStatus('draft') === 'planning_done', 'nextStatus(draft) = planning_done');
assert(sm.nextStatus('planning_done') === 'selected', 'nextStatus(planning_done) = selected');
assert(sm.nextStatus('selected') === 'copy_done', 'nextStatus(selected) = copy_done');
assert(sm.nextStatus('copy_done') === 'pending_review', 'nextStatus(copy_done) = pending_review');
assert(sm.nextStatus('approved') === 'published', 'nextStatus(approved) = published');
assert(sm.nextStatus('rejected') === 'copy_done', 'nextStatus(rejected) = copy_done');
assert(sm.nextStatus('published') === null, 'nextStatus(published) = null (terminal)');
assertThrows(() => sm.nextStatus('garbage'), 'nextStatus(unknown) throws');

// ============================================
// 9. Supabase REST functions — guard without env
// ============================================
console.log('\n--- supabase REST behaviour without env ---');
// Snapshot + unset env so a stray local config can't influence the test.
const savedUrl = process.env.SUPABASE_URL;
const savedKey = process.env.SUPABASE_SERVICE_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

assert(supabase.isConfigured() === false, 'isConfigured() === false when env missing');

(async () => {
  // 9a. Calls that need to talk to Supabase must reject when not configured.
  try {
    await supabase.getContentCalendar('00000000-0000-0000-0000-000000000000');
    fail('getContentCalendar rejects when env missing');
  } catch (err) {
    if (String(err.message).includes('not configured')) {
      pass('getContentCalendar rejects when env missing');
    } else {
      fail('getContentCalendar rejects when env missing', err);
    }
  }

  // 9b. State-machine guard runs BEFORE network. Invalid starting status should
  //     throw a transition error regardless of env.
  try {
    await supabase.createContentCalendar({ status: 'published' });
    fail('createContentCalendar rejects invalid initial status');
  } catch (err) {
    if (String(err.message).includes('Invalid transition') || String(err.message).includes('terminal')) {
      pass('createContentCalendar rejects invalid initial status (state-machine guard runs first)');
    } else {
      fail('createContentCalendar rejects invalid initial status', err);
    }
  }

  // Restore env so we don't pollute other processes in the same shell.
  if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
  if (savedKey !== undefined) process.env.SUPABASE_SERVICE_KEY = savedKey;

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n========================================');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log('========================================');
  process.exit(failed === 0 ? 0 : 1);
})();
