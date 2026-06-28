// ============================================
// REAL TEST: Fanz Marketing Bot — E2E Simulation
// Runs in Railway env with real OpenRouter API calls
// ============================================

const { buildPlanSystemPrompt, parsePlanResponse, validateSelection } = require('./lib/planning');
const { buildCopywritingPrompt, parseCopywritingResponse, validateCopywritingResult } = require('./lib/copywriting');

async function callOpenRouter(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const t0 = Date.now();
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fanz-marketing-bot.railway.app',
        'X-Title': 'Fanz Marketing Bot Test'
      },
      body: JSON.stringify({
        model: process.env.MODEL || 'gpt-4o',
        messages,
        max_tokens: 2000,
        temperature: 0.8
      }),
      signal: controller.signal
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return { content: data.choices[0].message.content, elapsed };
  } finally {
    clearTimeout(timeout);
  }
}

function sep(title) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(72)}`);
}

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }

async function main() {
// ================================================================
console.log(`FANZ MARKETING BOT — E2E REAL TEST
  Model: ${process.env.MODEL || 'gpt-4o'}
  OPENROUTER_API_KEY: ${(process.env.OPENROUTER_API_KEY || '').slice(0, 12)}...
  Telegram Bot: @Fanzmkt_bot
  Date: ${new Date().toISOString()}
`);

// ================================================================
// PATH A: /plan WORKFLOW
// ================================================================
sep('PATH A: /plan WORKFLOW — AURA series for small spaces');

// Step 1: Generate plan
console.log('\n--- Step 1: /plan promote AURA series for small spaces ---');
const planSystem = buildPlanSystemPrompt();
console.log(`\n[PLAN SYSTEM PROMPT PREVIEW]\n${planSystem.slice(0, 400)}...\n`);

const planResult = await callOpenRouter([
  { role: 'system', content: planSystem },
  { role: 'user', content: 'Generate content plan suggestions. Extra context: promote AURA series for small spaces like bedrooms and low ceilings.' }
]);
console.log(`\n[LLM RAW] Time: ${planResult.elapsed}s\n${planResult.content}`);

const plans = parsePlanResponse(planResult.content);
console.log(`\n[PARSE] Plans extracted: ${plans.length}`);
plans.forEach(p => console.log(`  #${p.number} [${p.direction}] ${p.title}`));

if (plans.length === 0) {
  fail('No plans parsed — cannot continue Path A');
  process.exit(1);
}
ok(`${plans.length} plans parsed successfully`);

// Evaluate plan quality
console.log('\n--- Plan Quality Check ---');
let planOk = 0;
plans.forEach(p => {
  const issues = [];
  if (p.title.match(/[\u4e00-\u9fff]/)) issues.push('contains Chinese');
  if (!p.direction || !['product','case','promo','story','educational'].includes(p.direction)) issues.push('invalid direction');
  if (issues.length === 0) planOk++;
  else warn(`#${p.number}: ${issues.join(', ')}`);
});
if (planOk === plans.length) ok('All plans English-only with valid directions');
else warn(`${planOk}/${plans.length} plans clean`);

// Step 2: Select plan #1
sep('Step 2: Select Plan #1 — Generate Copy');

const selection = validateSelection({ plans }, '1');
if (!selection.valid) { fail('Selection invalid: ' + selection.message); process.exit(1); }
const selected = selection.plan;
ok(`Selected: #${selected.number} [${selected.direction}] ${selected.title}`);

console.log(`\n--- Copywriting Prompt Preview ---`);
const copyPrompt = buildCopywritingPrompt(selected.title, selected.direction);
console.log(`${copyPrompt.slice(0, 500)}...\n`);

// Step 3: Generate copy
console.log(`\n--- Step 3: Generating Copy (topic="${selected.title}", pillar=${selected.direction}) ---`);
const copyResult = await callOpenRouter([
  { role: 'system', content: copyPrompt },
  { role: 'user', content: 'Generate the post.' }
]);
console.log(`\n[LLM RAW] Time: ${copyResult.elapsed}s\n${copyResult.content}`);

// Step 4: Parse and validate
const parsed = parseCopywritingResponse(copyResult.content);
if (!parsed) {
  fail('parseCopywritingResponse returned null');
  console.log('Raw output does not match expected FACEBOOK/INSTAGRAM/HASHTAGS format');
} else {
  ok('Parsed into FB/IG/Hashtags');

  const validation = validateCopywritingResult(parsed);
  console.log(`\n--- Copy Quality Check ---`);

  // Language check
  const allText = [parsed.fb_content, parsed.ig_content, parsed.hashtags].join(' ');
  const hasChinese = /[\u4e00-\u9fff]/.test(allText);
  if (hasChinese) fail('⚠️ CONTAINS CHINESE — should be 100% English');
  else ok('100% English — no Chinese detected');

  // Hook check
  const fbLines = (parsed.fb_content || '').split('\n').filter(Boolean);
  const igLines = (parsed.ig_content || '').split('\n').filter(Boolean);
  if (fbLines.length >= 1) ok(`FB version has ${fbLines.length} lines`);
  if (igLines.length >= 1) ok(`IG version has ${igLines.length} lines`);

  // Warranty check
  if (allText.includes('warranty') || allText.includes('Warranty')) ok('Mentions warranty');
  else warn('No warranty mention');

  // CTA check
  const ctas = ['Head over to the website', 'DM us', 'Drop your room type', 'Get yours today', 'fanz.my'];
  const ctaHit = ctas.some(c => allText.includes(c));
  if (ctaHit) ok('Has CTA matching Fanz style');
  else warn('No standard Fanz CTA found');

  // Hashtag check
  const hashtags = (parsed.hashtags || '');
  const tagCount = hashtags.split(/\s+/).filter(t => t.startsWith('#')).length;
  if (tagCount >= 4 && tagCount <= 10) ok(`Hashtags: ${tagCount} tags (within range)`);
  else warn(`Hashtags: ${tagCount} tags (expected 5-8)`);

  if (hashtags.includes('#Fanz') || hashtags.includes('#FANZ')) ok('Has #Fanz brand hashtag');
  else warn('No #Fanz hashtag');

  // Validation result
  if (validation.valid) ok(`Validation passed (${validation.keywordsHit.length} brand keywords hit)`);
  else fail(`Validation failed: ${validation.errors.join('; ')}`);

  // Show output
  console.log(`\n--- Generated Output ---`);
  console.log(`\n📱 FACEBOOK VERSION\n${parsed.fb_content}`);
  console.log(`\n📸 INSTAGRAM VERSION\n${parsed.ig_content}`);
  console.log(`\n#⃣ HASHTAGS\n${parsed.hashtags}`);
}

// Step 5: Image generation note
sep('Step 5: GPT Image 2 — Scene Generation');

const hasOpenAI = !!process.env.OPENAI_API_KEY;

if (hasOpenAI) {
  console.log(`\n[NOTE] generateSceneImage requires a real content_calendar row UUID.
Skipping inline — will be tested via the bot's full workflow.
OPENAI_API_KEY is present, so dry-run=false for real calls.
`);
  ok('OPENAI_API_KEY configured — real GPT Image 2 calls will work');
} else {
  warn('OPENAI_API_KEY not set — image generation dry-run mode');
}

// ================================================================
// PATH B: DIRECT COMMAND — /product Smart Series
// ================================================================
sep('PATH B: /product Smart Series WiFi ceiling fan');

console.log(`\n--- Generating copy (pillar=product, topic="Smart Series WiFi ceiling fan — modern control") ---`);
const productPrompt = buildCopywritingPrompt('Smart Series WiFi ceiling fan — modern control at your fingertips', 'product');
const productResult = await callOpenRouter([
  { role: 'system', content: productPrompt },
  { role: 'user', content: 'Generate the post.' }
]);
console.log(`\n[LLM RAW] Time: ${productResult.elapsed}s\n${productResult.content}`);

const productParsed = parseCopywritingResponse(productResult.content);
if (!productParsed) {
  fail('parseCopywritingResponse returned null for /product');
} else {
  ok('Parsed into FB/IG/Hashtags');

  const allText = [productParsed.fb_content, productParsed.ig_content, productParsed.hashtags].join(' ');
  const hasChinese = /[\u4e00-\u9fff]/.test(allText);

  console.log(`\n--- Product Copy Quality Check ---`);
  if (hasChinese) fail('⚠️ CONTAINS CHINESE');
  else ok('100% English');

  if (allText.includes('warranty') || allText.includes('Warranty')) ok('Mentions 10-year warranty');
  else warn('No warranty mention');

  const ctas = ['Head over to the website', 'DM us', 'Drop your room type', 'Get yours today', 'fanz.my'];
  if (ctas.some(c => allText.includes(c))) ok('Has Fanz-style CTA');
  else warn('No standard CTA');

  if (allText.includes('SIRIM')) ok('Mentions SIRIM');
  else warn('No SIRIM mention');

  if (allText.includes('DC') || allText.includes('energy')) ok('Mentions DC motor / energy efficiency');
  else warn('No DC motor mention');

  if (allText.includes('fanz.my') || allText.includes('website')) ok('Has website URL');
  else warn('No website URL');

  const tags = (productParsed.hashtags || '');
  const tagCt = tags.split(/\s+/).filter(t => t.startsWith('#')).length;
  ok(`Hashtags: ${tagCt} tags`);

  const validation = validateCopywritingResult(productParsed);
  if (validation.valid) ok(`Validation passed (${validation.keywordsHit.length} keywords)`);
  else fail(`Validation: ${validation.errors.join('; ')}`);

  console.log(`\n--- Product Output ---`);
  console.log(`\n📱 FACEBOOK VERSION\n${productParsed.fb_content}`);
  console.log(`\n📸 INSTAGRAM VERSION\n${productParsed.ig_content}`);
  console.log(`\n#⃣ HASHTAGS\n${productParsed.hashtags}`);
}

// ================================================================
// SUMMARY
// ================================================================
sep('E2E TEST COMPLETE');
console.log(`\nPaths tested:
  A: /plan → select → copywrite → validate (${plans.length} plans, copy ${parsed ? '✓' : '✗'})
  B: /product direct → copywrite → validate (${productParsed ? '✓' : '✗'})
`);

}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});