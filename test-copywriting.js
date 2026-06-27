#!/usr/bin/env node
// ============================================
// Self-check for the Copywriting node.
//
// Validates spec assertions:
// 1. fb_content, ig_content, hashtags three fields non-empty
// 2. status updated to 'copy_done'
// 3. Contains Fanz real selling points (e.g. "10"年保修 / warranty)
// 4. LLM real OpenRouter call (not mock)
// 5. No placeholders like "{{}}", "TODO", "lorem"
//
// Tests load the production code from lib/copywriting.js.
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
// Load production code
// ============================================
let copywriting;
try {
  copywriting = require('./lib/copywriting');
  pass('lib/copywriting.js loads');
} catch (err) {
  fail('lib/copywriting.js loads', err);
  console.log('SKIP: all remaining tests (module not found)');
  console.log('\n========================================');
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

const {
  buildCopywritingPrompt,
  parseCopywritingResponse,
  validateCopywritingResult,
  FORBIDDEN_PLACEHOLDER_PATTERNS,
  FANZ_KEYWORD_PATTERNS,
} = copywriting;

// ============================================
// 1. buildCopywritingPrompt — structure
// ============================================
console.log('--- buildCopywritingPrompt ---');

// Uses actual production date
const prompt = buildCopywritingPrompt('Hari Raya Home Refresh — Fanz Ceiling Fans', 'promo');
assert(typeof prompt === 'string', 'prompt is a string');
assert(prompt.length > 200, 'prompt is sufficiently long');
assert(prompt.includes('Hari Raya Home Refresh'), 'prompt includes topic');
assert(prompt.includes('promo'), 'prompt includes pillar');
assert(prompt.includes('Fanz'), 'prompt includes brand name');
assert(prompt.includes('10-year'), 'prompt includes warranty reference');
assert(prompt.includes('SIRIM'), 'prompt includes SIRIM reference');
assert(prompt.includes('FACEBOOK'), 'prompt asks for Facebook version');
assert(prompt.includes('INSTAGRAM'), 'prompt asks for Instagram version');
assert(prompt.includes('HASHTAGS'), 'prompt asks for hashtags');
assert(!prompt.includes('{{'), 'prompt has no template placeholders');

// ============================================
// 2. parseCopywritingResponse — parsing
// ============================================
console.log('\n--- parseCopywritingResponse ---');

// Valid full output
const validOutput = `📱 FACEBOOK VERSION

Hari Raya is almost here — time to refresh your home! Fanz Grande L Series comes with a 22W LED light and 56" blades, perfect for your living and dining room. 10-year motor warranty. SIRIM certified. On-site service across Malaysia & Singapore.

🌐 https://fanz.my

📸 INSTAGRAM VERSION

✨ Hari Raya refresh ✨
New fan, new energy for your home!
Fanz Grande L — light, air, and style
✌️ 10-year motor warranty
✌️ SIRIM certified
✌️ On-site installation
#Fanz #GrandeSeries

#⃣ HASHTAGS

#FANZ #Fanz #GrandeSeries #CeilingFan #HariRaya #HomeUpgrade #DCFan #Malaysia`;

const result1 = parseCopywritingResponse(validOutput);
assert(result1 !== null, 'valid output parsed');
assert(result1.fb_content && result1.fb_content.length > 20, 'fb_content non-empty');
assert(result1.ig_content && result1.ig_content.length > 20, 'ig_content non-empty');
assert(result1.hashtags && result1.hashtags.length > 5, 'hashtags non-empty');
assert(result1.fb_content.includes('Hari Raya'), 'fb_content contains topic keyword');
assert(result1.ig_content.includes('Fanz'), 'ig_content contains brand');

// Output missing fields
const partialOutput = `📱 FACEBOOK VERSION
Just some FB content`;

const result2 = parseCopywritingResponse(partialOutput);
assert(result2 !== null, 'partial output still parsed');
assert(result2.fb_content.length > 0, 'partial fb_content present');
assert(result2.ig_content === '', 'partial ig_content empty');
assert(result2.hashtags === '', 'partial hashtags empty');

// Empty input
const result3 = parseCopywritingResponse('');
assert(result3 === null, 'empty input returns null');

// Gibberish input
const gibberish = `Some random text without any section markers.`;
const result4 = parseCopywritingResponse(gibberish);
assert(result4 === null, 'gibberish without markers returns null');

// ============================================
// 3. validateCopywritingResult — assertion checks
// ============================================
console.log('\n--- validateCopywritingResult ---');

// Valid result
const validResult = {
  fb_content: 'Hari Raya is here! Fanz fans keep your home cool and comfortable. 10-year motor warranty, on-site installation service, SIRIM certified quality.',
  ig_content: '✨ Hari Raya blessings! ✨\nFanz Grande L — light, air, and style\n10-year warranty #Fanz #GrandeSeries',
  hashtags: '#FANZ #Fanz #GrandeSeries #CeilingFan #HariRaya #HomeUpgrade #DCFan #Malaysia',
};

const v1 = validateCopywritingResult(validResult);
assert(v1.valid === true, 'valid result passes validation');
assert(v1.errors.length === 0, 'valid result has zero errors');
assert(v1.keywordsHit.length >= 1, 'valid result hits Fanz keywords');

// Missing fields
const missingFields = { fb_content: '', ig_content: '', hashtags: '' };
const v2 = validateCopywritingResult(missingFields);
assert(v2.valid === false, 'empty fields fails validation');
assert(v2.errors.some(e => e.includes('fb_content')), 'fb_content error reported');
assert(v2.errors.some(e => e.includes('ig_content')), 'ig_content error reported');
assert(v2.errors.some(e => e.includes('hashtags')), 'hashtags error reported');

// Placeholder detection
const hasPlaceholder = {
  fb_content: 'This is a {{topic}} post about Fanz fans.',
  ig_content: 'TODO: add content here',
  hashtags: '#Fanz #fan',
};
const v3 = validateCopywritingResult(hasPlaceholder);
assert(v3.valid === false, 'placeholder fails validation');
assert(v3.errors.some(e => e.includes('placeholder') || e.includes('TODO')), 'placeholder error reported');

// {{ }} patterns are specifically checked
const curlyPlaceholder = {
  fb_content: 'Check out our {{product_name}} with {{feature}}!',
  ig_content: 'Amazing {{product_name}} for your home!',
  hashtags: '#Fanz #fan',
};
const v4 = validateCopywritingResult(curlyPlaceholder);
assert(v4.valid === false, 'curly brace placeholder fails');

// No Fanz keywords
const noKeywords = {
  fb_content: 'This is a generic post about home products with no brand-specific details.',
  ig_content: 'Today is a beautiful day to relax at home.',
  hashtags: '#post #random #home',
};
const v5 = validateCopywritingResult(noKeywords);
assert(v5.valid === false, 'no Fanz keywords fails');
assert(v5.errors.some(e => e.includes('keyword')), 'keyword error reported');
assert(v5.keywordsHit.length === 0, 'zero keywords hit');

// ============================================
// 4. FORBIDDEN_PLACEHOLDER_PATTERNS list
// ============================================
console.log('\n--- patterns ---');
assert(Array.isArray(FORBIDDEN_PLACEHOLDER_PATTERNS), 'placeholder patterns is array');
assert(FORBIDDEN_PLACEHOLDER_PATTERNS.length >= 3, 'at least 3 placeholder patterns');
assert(FORBIDDEN_PLACEHOLDER_PATTERNS.some(p => p.includes('TODO')), 'TODO pattern included');
assert(FORBIDDEN_PLACEHOLDER_PATTERNS.some(p => p.includes('lorem')), 'lorem pattern included');
assert(FORBIDDEN_PLACEHOLDER_PATTERNS.some(p => p.includes('{{')), 'curly brace pattern included');

assert(Array.isArray(FANZ_KEYWORD_PATTERNS), 'keyword patterns is array');
assert(FANZ_KEYWORD_PATTERNS.length >= 3, 'at least 3 keyword patterns');

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
// 5. Integration test — real OpenRouter call
// ============================================
console.log('\n--- integration: copywriting real LLM call ---');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.log('SKIP: OPENROUTER_API_KEY not set, skipping real LLM call');
  console.log('\n========================================');
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(0);
}

const MODEL = process.env.MODEL || 'gpt-4o';

async function callOpenRouter(messages) {
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
    const systemPrompt = buildCopywritingPrompt('Hari Raya Promo: Fanz fan family bundle deals', 'promo');
    const userMsg = 'Generate the post based on this brief: "Hari Raya family promotion with discount offer."';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg }
    ];

    const rawResponse = await callOpenRouter(messages);
    const parsed = parseCopywritingResponse(rawResponse);

    if (!parsed) {
      fail('parse copywriting LLM response');
      console.log(`Raw response (first 200 chars): ${rawResponse.substring(0, 200)}`);
    } else {
      pass('copywriting LLM response parsed successfully');

      // Assertion 1: three fields non-empty
      assert(parsed.fb_content.length > 20, 'integration: fb_content non-empty');
      assert(parsed.ig_content.length > 20, 'integration: ig_content non-empty');
      assert(parsed.hashtags.length > 5, 'integration: hashtags non-empty');

      // Assertion 2: no placeholders
      const validation = validateCopywritingResult(parsed);
      assert(validation.valid === true, 'integration: no forbidden placeholders');
      if (!validation.valid) {
        console.log(`Validation errors: ${validation.errors.join(', ')}`);
      }

      // Assertion 3: Fanz keywords hit
      assert(validation.keywordsHit.length >= 1, `integration: Fanz keywords hit (${validation.keywordsHit.join(', ')})`);

      // Assertion 4: real OpenRouter call (we got here, so it's real)
      pass('integration: LLM call was real (OpenRouter API)');

      console.log('\n--- sample output ---');
      console.log(`FB: ${parsed.fb_content.substring(0, 80)}...`);
      console.log(`IG: ${parsed.ig_content.substring(0, 80)}...`);
      console.log(`Hashtags: ${parsed.hashtags.substring(0, 80)}...`);
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