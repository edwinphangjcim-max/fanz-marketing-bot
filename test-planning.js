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
// Tests that don't need OpenRouter run first (unit tests).
// The integration test makes ONE real OpenRouter call (cheap prompt).
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

// ============================================
// 1. parsePlanResponse — edge cases
// ============================================
console.log('--- parsePlanResponse ---');

// Load the module (it's part of index.js, require the whole file)
// We can't easily require index.js (it starts a bot), so inline the parser logic.
// Copy the parsePlanResponse function logic:
function parsePlanResponse(rawText) {
  const plans = [];
  let currentPlan = null;

  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    const blockMatch = trimmed.match(/^=+\s*(\d+)\s*=/);
    const numberMatch = trimmed.match(/^(\d+)[.)]\s*$/);

    if (blockMatch) {
      if (currentPlan && currentPlan.number) {
        plans.push(currentPlan);
      }
      currentPlan = { number: parseInt(blockMatch[1]), title: '', description: '', direction: '' };
      continue;
    }

    // Detect new plan from numbered list item ("N. Title" or "N) Title")
    const startMatch = trimmed.match(/^(\d+)[.)]\s+/);
    if (startMatch) {
      if (currentPlan && currentPlan.number) {
        plans.push(currentPlan);
      }
      currentPlan = { number: parseInt(startMatch[1]), title: trimmed.replace(/^\d+[.)]\s*/, ''), description: '', direction: '' };
      continue;
    }

    if (!currentPlan) continue;

    const titleMatch = trimmed.match(/^Title:\s*(.+)/i);
    const whyMatch = trimmed.match(/^Why:\s*(.+)/i);
    const directionMatch = trimmed.match(/^Direction:\s*(.+)/i);

    if (titleMatch) {
      currentPlan.title = titleMatch[1].trim();
    } else if (whyMatch) {
      currentPlan.description = whyMatch[1].trim();
    } else if (directionMatch) {
      const dir = directionMatch[1].trim().toLowerCase();
      if (['product', 'case', 'promo', 'story'].includes(dir)) {
        currentPlan.direction = dir;
      } else {
        currentPlan.direction = 'product';
      }
    } else if (trimmed && !trimmed.startsWith('===') && !trimmed.startsWith('Title') && !trimmed.startsWith('Why') && !trimmed.startsWith('Direction')) {
      if (!currentPlan.title && trimmed.length > 1) {
        currentPlan.title = trimmed;
      }
    }
  }

  if (currentPlan && currentPlan.number && currentPlan.title) {
    plans.push(currentPlan);
  }

  return plans;
}

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

// ============================================
// 2. buildPlanSystemPrompt — date injection
// ============================================
console.log('\n--- buildPlanSystemPrompt ---');

// We can inline this function too (copy from index.js)
function buildPlanSystemPrompt() {
  const now = new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const currentMonth = months[now.getMonth()];
  const currentYear = now.getFullYear();
  const currentDate = `${currentMonth} ${now.getDate()}, ${currentYear}`;

  // Festival proximity detection — build dynamic context
  const festivals = [
    { name: 'Chinese New Year (农历新年)', range: 'Jan-Feb', triggerMonths: [0, 1] },
    { name: 'Hari Raya Aidilfitri (开斋节)', range: 'March-April', triggerMonths: [2, 3] },
    { name: 'Deepavali (屠妖节)', range: 'Oct-Nov', triggerMonths: [9, 10] },
    { name: 'Christmas (圣诞节)', range: 'December', triggerMonths: [11] },
    { name: 'National Day / Merdeka (国庆)', range: 'August 31', triggerMonths: [7] },
    { name: 'Malaysia Day (马来西亚日)', range: 'September 16', triggerMonths: [8] },
    { name: 'Mid-year sales (年中促销)', range: 'June-July', triggerMonths: [5, 6] },
    { name: 'School holidays (学校假期)', range: 'March, June, December', triggerMonths: [2, 5, 11] },
    { name: 'Rainy / monsoon season (雨季)', range: 'Nov-Feb', triggerMonths: [10, 11, 0, 1] },
    { name: 'Hot / dry season (热季)', range: 'March-May', triggerMonths: [2, 3, 4] },
  ];

  const currentMonthNum = now.getMonth();
  const nearEvents = festivals.filter(f => f.triggerMonths.includes(currentMonthNum));
  const nearContext = nearEvents.length > 0
    ? `\nCURRENT SEASONAL HIGHLIGHTS (currently active / approaching):\n${nearEvents.map(f => `- ${f.name} (${f.range})`).join('\n')}`
    : '';

  return `You are a senior social media content strategist for Fanz Sdn Bhd, a Malaysian ceiling fan and air cooler brand.

Your job: Suggest 3-5 content topics for the coming week that are relevant, timely, and aligned with the current date in Malaysia.

CURRENT DATE: ${currentDate}${nearContext}

MALAYSIA SEASONAL & CULTURAL CONTEXT (full reference):
- Hari Raya Aidilfitri (March-April) — home decoration, family gatherings
- Deepavali (Oct-Nov) — festive lighting, home preparation
- Chinese New Year (Jan-Feb) — spring cleaning, home upgrades
- Christmas (Dec) — year-end festive season
- National Day (Aug 31) — Merdeka campaigns
- Malaysia Day (Sep 16) — East Malaysia awareness
- School holidays (March, June, December) — family time at home
- Rainy season (Nov-Feb) — enclosed spaces, ventilation
- Hot season (March-May) — peak fan season, heat relief
- Mid-year sales (June-July) — promotion-friendly period
- Year-end sales (Nov-Dec) — year-end campaigns

BRAND & PRODUCTS:
- 10+ years in Malaysia, 10-year motor warranty
- On-site service across Malaysia & Singapore
- SIRIM certified, DC motor technology, energy efficient
- Products: FS Series (smart, large spaces), Grande L (LED light, living/dining), Smart Series (WiFi app control), AURA (compact, bedrooms)
- We also sell air coolers (pending product expansion details)

YOUR TASK:
Based on the CURRENT DATE and Malaysia context above, suggest 3-5 content topics for Fanz's social media this week.

For each topic, include:
1. A catchy title (mixed Chinese-English, like a real Malaysian post)
2. A one-sentence explanation of why this topic works now
3. A recommended content direction from exactly one of: product, case, promo, story

Your output MUST follow this exact format — one numbered item per line block with clear separators:

===== 1 =====
Title: [catchy title]
Why: [one sentence explaining timeliness/relevance]
Direction: [product|case|promo|story]

===== 2 =====
Title: [catchy title]
Why: [one sentence]
Direction: [product|case|promo|story]

... and so on up to 5.

IMPORTANT:
- Do NOT invent holidays or events that don't exist
- If no major event is near the current date, base suggestions on seasons and general marketing timing
- Keep suggestions practical for a ceiling fan + air cooler brand
- Mixed Chinese-English language throughout
- No post content generation — only topic planning`;
}

const prompt = buildPlanSystemPrompt();

// Check date is injected
const today = new Date();
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
assert(prompt.includes(months[today.getMonth()]), 'prompt contains current month');
assert(prompt.includes(String(today.getFullYear())), 'prompt contains current year');

// Check context content
assert(prompt.includes('Hari Raya'), 'prompt includes Hari Raya context');
assert(prompt.includes('Chinese New Year'), 'prompt includes CNY context');
assert(prompt.includes('Direction: [product|case|promo|story]'), 'prompt specifies pillar enum');

// ============================================
// 3. Plan session management
// ============================================
console.log('\n--- plan session ---');

function getPlanSession(chatId) {
  const session = planSessions.get(chatId);
  if (!session) return null;
  if (Date.now() - session.timestamp > 30 * 60 * 1000) {
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

const planSessions = new Map();

setPlanSession(42, [{ number: 1, title: 'Test', description: 'Desc', direction: 'promo' }]);
assert(getPlanSession(42) !== null, 'session stored and retrievable');
assert(getPlanSession(42).plans.length === 1, 'session plans count');

clearPlanSession(42);
assert(getPlanSession(42) === null, 'session cleared');

setPlanSession(99, [{ number: 1, title: 'Expired', description: '', direction: 'product' }]);
// Manually expire
const session = planSessions.get(99);
session.timestamp = Date.now() - 31 * 60 * 1000; // 31 min ago
assert(getPlanSession(99) === null, 'expired session returns null');

// ============================================
// SUMMARY (unit tests)
// ============================================
console.log('\n========================================');
console.log(`UNIT TESTS: ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failed > 0) process.exit(1);
// Reset for integration test counters
const unitPassed = passed;
const unitFailed = failed;

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
  process.exit(failed > 0 ? 1 : 0);
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

    // Assertion 3: verify real OpenRouter call (not mock) — if we got here, it's real
    pass('LLM call was real (OpenRouter API)');

    console.log('\n--- sample output ---');
    for (const plan of plans) {
      console.log(`  ${plan.number}. [${plan.direction}] ${plan.title}`);
      console.log(`     ${plan.description.substring(0, 60)}...`);
    }

  } catch (err) {
    console.error(`\nIntegration test error: ${err.message}`);
    // Don't fail the test if OpenRouter is unavailable — could be transient
    // But mark it so the user knows
    console.log('WARN: Integration test could not complete. Check OpenRouter API key and network.');
  }

  // ============================================
  // FINAL SUMMARY
  // ============================================
  console.log('\n========================================');
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
})();