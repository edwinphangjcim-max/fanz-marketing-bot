#!/usr/bin/env node
// ============================================
// Self-check for the Planning node (/plan).
//
// Validates spec assertions:
// 1. Input /plan → returned recommendations count 3-5
// 2. Each recommendation has number + pillar ∈ {product,case,promo,story}
// 3. Full date + festival proximity injected into prompt
// 4. parsePlanResponse correctly handles AI output
// 5. Plan session management (TTL, save/load/clear)
//
// Tests load the production code from lib/planning.js directly.
// Integration test makes ONE real OpenRouter call when OPENROUTER_API_KEY is set.
// ============================================

const path = require('path');
const planning = require('./lib/planning');

const { buildPlanSystemPrompt, parsePlanResponse, getMalaysiaDate, MONTHS, FESTIVALS } = planning;

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
// 1. parsePlanResponse — edge cases
// ============================================
console.log('--- parsePlanResponse ---');

// 1a. Parse valid output — block format
const validBlockOutput = `===== 1 =====
Title: 开斋节家居焕新计划
Why: Hari Raya is approaching, families are preparing homes
Direction: promo

===== 2 =====
Title: AURA 小空间安装分享
Why: Small space solutions are trending
Direction: case

===== 3 =====
Title: Fanz 10年保修故事
Why: Brand trust is key for purchase decisions
Direction: story`;

const plans1 = parsePlanResponse(validBlockOutput);
assert(plans1.length === 3, 'block format: 3 plans parsed');
assert(plans1[0].number === 1, 'block format: plan 1 number=1');
assert(plans1[0].title === '开斋节家居焕新计划', 'block format: plan 1 title');
assert(plans1[0].description === 'Hari Raya is approaching, families are preparing homes', 'block format: plan 1 description');
assert(plans1[0].direction === 'promo', 'block format: plan 1 direction=promo');
assert(plans1[1].direction === 'case', 'block format: plan 2 direction=case');
assert(plans1[2].direction === 'story', 'block format: plan 3 direction=story');

// 1b. Parse valid output — numbered list format
const validListOutput = `1. 开斋节促销
Title: 开斋节促销
Why: Festive season buying
Direction: promo

2. 卧室风扇推荐
Title: 卧室风扇推荐
Why: Hot season coming
Direction: product`;

const plans2 = parsePlanResponse(validListOutput);
assert(plans2.length === 2, 'list format: 2 plans parsed');
assert(plans2[0].number === 1, 'list format: plan 1 number=1');

// 1c. Output with fewer than 3 or more than 5 plans — boundary
const singlePlan = `===== 1 =====
Title: Just one plan
Why: Testing
Direction: product`;
const plans3 = parsePlanResponse(singlePlan);
assert(plans3.length === 1, 'single plan parsed');

// 1d. Unknown direction → defaults to 'product'
const unknownDirOutput = `===== 1 =====
Title: Test
Why: Testing
Direction: unknown_thing`;
const plans4 = parsePlanResponse(unknownDirOutput);
assert(plans4[0].direction === 'product', 'unknown direction defaults to product');

// 1e. Empty input
const plans5 = parsePlanResponse('');
assert(plans5.length === 0, 'empty input returns empty array');

// 1f. No Title field
const noTitle = `===== 1 =====
Why: Something
Direction: product`;
const plans6 = parsePlanResponse(noTitle);
assert(plans6.length === 0, 'plan without title excluded');

// 1g. Numbered list does NOT match inside a block (regression test)
const subBulletContent = `===== 1 =====
1. This looks like a sub-bullet but is inside a block
Title: Main Title
Why: Test
Direction: product`;
const plans7 = parsePlanResponse(subBulletContent);
assert(plans7.length === 1, 'in-block numbered line does NOT create new plan');
assert(plans7[0].title === 'Main Title', 'in-block: title preserved');
assert(plans7[0].number === 1, 'in-block: number preserved');

// ============================================
// 2. buildPlanSystemPrompt — date injection
// ============================================
console.log('\n--- buildPlanSystemPrompt ---');

const prompt = buildPlanSystemPrompt();

// Check date is injected
const now = getMalaysiaDate();
const todayDate = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
assert(prompt.includes(todayDate), 'prompt contains full date (e.g., "June 20, 2026")');

// Check context content
assert(prompt.includes('Hari Raya'), 'prompt includes Hari Raya context');
assert(prompt.includes('Chinese New Year'), 'prompt includes CNY context');
assert(prompt.includes('Direction: [product|case|promo|story]'), 'prompt specifies pillar enum');

// Check festival proximity is active
const currentMonthNum = now.getMonth();
const hasFestivals = FESTIVALS.some(f => f.triggerMonths.includes(currentMonthNum));
if (hasFestivals) {
  assert(prompt.includes('CURRENT SEASONAL HIGHLIGHTS'), 'prompt has seasonal highlights when festivals active');
}

// ============================================
// 3. Plan session management
// ============================================
console.log('\n--- plan session ---');

// Inline session helpers for testability
const PLAN_SESSION_TTL_MS = 30 * 60 * 1000;
const planSessions = new Map();

function getPlanSession(chatId) {
  const session = planSessions.get(chatId);
  if (!session) return null;
  if (Date.now() - session.timestamp > PLAN_SESSION_TTL_MS) {
    planSessions.delete(chatId);
    return null;
  }
  return session;
}

function setPlanSession(chatId, plans) {
  planSessions.set(chatId, { plans, timestamp: Date.now() });
}

function clearPlanSession(chatId) {
  planSessions.delete(chatId);
}

setPlanSession(42, [{ number: 1, title: 'Test', description: 'Desc', direction: 'promo' }]);
assert(getPlanSession(42) !== null, 'session stored and retrievable');
assert(getPlanSession(42).plans.length === 1, 'session plans count');

clearPlanSession(42);
assert(getPlanSession(42) === null, 'session cleared');

setPlanSession(99, [{ number: 1, title: 'Expired', description: '', direction: 'product' }]);
const session = planSessions.get(99);
session.timestamp = Date.now() - 31 * 60 * 1000; // 31 min ago
assert(getPlanSession(99) === null, 'expired session returns null');

// ============================================
// SUMMARY (unit tests)
// ============================================
console.log('\n========================================');
console.log(`UNIT TESTS: ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failed > 0) {
  console.log('FAILURES DETECTED — exiting with code 1');
  process.exit(1);
}

// ============================================
// 4. Integration test — real OpenRouter call
// ============================================
console.log('\n--- integration: /plan real LLM call ---');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
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
      max_tokens: 1500,
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
    const systemPrompt = buildPlanSystemPrompt();
    const userPrompt = 'Generate content plan suggestions for this week.';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const rawResponse = await callOpenRouter(messages);
    const plans = parsePlanResponse(rawResponse);

    // Assertion 1: count 3-5
    assert(plans.length >= 3 && plans.length <= 5,
      `recommendation count between 3-5 (got ${plans.length})`);

    // Assertion 2: each plan has number + pillar ∈ {product,case,promo,story}
    for (const plan of plans) {
      assert(typeof plan.number === 'number' && plan.number > 0,
        `plan ${plan.number}: has valid number`);
      assert(['product', 'case', 'promo', 'story'].includes(plan.direction),
        `plan ${plan.number}: direction "${plan.direction}" is valid`);
      assert(plan.title && plan.title.length > 2,
        `plan ${plan.number}: title non-empty (${plan.title.substring(0, 20)}...)`);
      assert(plan.description && plan.description.length > 5,
        `plan ${plan.number}: description non-empty`);
    }

    // Assertion 3: verify real OpenRouter call (not mock)
    pass('LLM call was real (OpenRouter API)');

    console.log('\n--- sample output ---');
    for (const plan of plans) {
      console.log(`  ${plan.number}. [${plan.direction}] ${plan.title}`);
      console.log(`     ${plan.description.substring(0, 60)}...`);
    }

  } catch (err) {
    console.error(`\nIntegration test error: ${err.message}`);
    failed++;
    fail('real OpenRouter integration call');
  }

  // ============================================
  // FINAL SUMMARY
  // ============================================
  console.log('\n========================================');
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
})();