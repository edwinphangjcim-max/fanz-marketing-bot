// ============================================
// E2E Test: Review Notes Full Cycle
// Verifies:
//   1. review_notes real DB persistence
//   2. LLM prompt contains REVISION CONTEXT + specific notes
//   3. State machine: rejected → copy_done → pending_review
//
// Run: cd /root/fanz-bots/marketing-bot && SKIP_BOT_INIT=1 railway run node test-e2e-review-notes.js
// ============================================

const { buildPlanSystemPrompt, parsePlanResponse, createSelectionPayload } = require('./lib/planning');
const { buildCopywritingPrompt, parseCopywritingResponse, validateCopywritingResult } = require('./lib/copywriting');
const supabase = require('./lib/supabase');
const { buildRejectPayload } = require('./index');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o';
const TEST_CHAT_ID = 'test-e2e-review-notes';

if (!OPENROUTER_API_KEY) { console.error('FATAL: OPENROUTER_API_KEY not set'); process.exit(1); }

// ── Raw Supabase helpers (direct REST, bypass state machine for reads/deletes) ──

function getConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { url, key };
}

async function sbSelect(id) {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/rest/v1/content_calendar?id=eq.${id}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function sbDelete(id) {
  const { url, key } = getConfig();
  await fetch(`${url}/rest/v1/content_calendar?id=eq.${id}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
}

// ── callOpenRouter ──

async function callOpenRouter(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fanz-marketing-bot.railway.app',
        'X-Title': 'Fanz Marketing Bot'
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 2000, temperature: 0.8 }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`OpenRouter API error ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.choices[0].message.content;
  } finally { clearTimeout(timeout); }
}

// ── Test tracking ──

const createdRows = [];
const results = {};

function sep(t) { console.log('\n' + '='.repeat(80) + '\n  ' + t + '\n' + '='.repeat(80)); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function info(label, val) { console.log(`  ℹ️  ${label}: ${val}`); }

// ============================================
// STEP 1: /plan — AI Content Planning
// ============================================
async function step1_planning() {
  sep('STEP 1: /plan — AI Content Planning');

  const systemPrompt = buildPlanSystemPrompt();
  info('PROMPT length', systemPrompt.length + ' chars');

  const raw = await callOpenRouter([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Generate content plan suggestions for this week.' }
  ]);

  console.log('\n[LLM RAW RESPONSE] length=' + raw.length);

  const plans = parsePlanResponse(raw);
  console.log(`\n[PARSE] → ${plans.length} plans extracted`);
  for (const p of plans) {
    console.log(`  #${p.number}: "${p.title}" [${p.direction}]`);
    console.log(`     Why: ${p.description}`);
  }

  if (plans.length === 0) {
    console.error('✗ FATAL: parsePlanResponse returned 0 plans');
    process.exit(1);
  }

  ok(`parsePlanResponse: ${plans.length} plans extracted — STABLE`);
  results.step1 = '✓ plans parsed';
  return { plans, raw, systemPrompt };
}

// ============================================
// STEP 2: Select plan → DB (status=selected)
// ============================================
async function step2_select(plan) {
  sep('STEP 2: Select Plan → DB write status=selected');

  info('Selected', `#${plan.number} "${plan.title}" (${plan.direction})`);

  const payload = createSelectionPayload(plan, TEST_CHAT_ID);
  console.log('\n[SELECTION PAYLOAD]', JSON.stringify(payload, null, 2));

  console.log('\n[DB] Creating row with createContentCalendar...');
  const row = await supabase.createContentCalendar(payload);
  console.log(`  id=${row.id} status=${row.status}`);

  const verify1 = await sbSelect(row.id);
  console.log(`  [VERIFY] Raw SELECT: id=${verify1.id} status="${verify1.status}" pillar="${verify1.pillar}" topic="${verify1.topic}"`);

  if (verify1.status !== 'selected') {
    console.error(`✗ FATAL: Expected status=selected, got "${verify1.status}"`);
    process.exit(1);
  }
  ok(`Supabase row ${verify1.id} has status="selected" ✓`);
  createdRows.push(row.id);
  results.step2 = `✓ row ${row.id} status=selected`;
  return row;
}

// ============================================
// STEP 3: Copywriting (NO reviewNotes)
// ============================================
async function step3_copywriting(plan, row) {
  sep('STEP 3: Copywriting — NO reviewNotes');

  const cp = buildCopywritingPrompt(plan.title, plan.direction);
  info('PROMPT length', cp.length + ' chars');

  // Verify NO REVISION CONTEXT when no reviewNotes
  const hasRevisionContext = cp.includes('REVISION CONTEXT');
  if (hasRevisionContext) {
    console.error('✗ FATAL: Prompt unexpectedly contains REVISION CONTEXT (no reviewNotes passed)');
    process.exit(1);
  }
  ok('buildCopywritingPrompt(plan.title, plan.direction) — NO REVISION CONTEXT (correct)');

  const raw = await callOpenRouter([
    { role: 'system', content: cp },
    { role: 'user', content: 'Generate social media content for this Fanz topic.' }
  ]);

  console.log('\n[LLM RAW RESPONSE] length=' + raw.length);

  const parsed = parseCopywritingResponse(raw);
  if (!parsed) {
    console.error('✗ FATAL: parseCopywritingResponse returned null');
    process.exit(1);
  }
  info('FB content', parsed.fb_content.length + ' chars');
  info('IG content', parsed.ig_content.length + ' chars');
  info('Hashtags', parsed.hashtags.length + ' chars');
  ok('parseCopywritingResponse: STABLE');

  const validation = validateCopywritingResult(parsed);
  info('Validation valid', validation.valid);
  info('Keywords hit', JSON.stringify(validation.keywordsHit));
  info('Errors', JSON.stringify(validation.errors));

  if (!validation.valid) {
    console.warn('  ⚠️  Validation has errors — continuing anyway (non-fatal)');
  }

  results.step3 = '✓ copywriting done (no reviewNotes)';
  return { parsed, raw, validation };
}

// ============================================
// STEP 4: Update to copy_done → pending_review
// ============================================
async function step4_to_pending_review(row, copyResult) {
  sep('STEP 4: State update → copy_done → pending_review');

  // Update to copy_done
  console.log('[DB] Updating to status=copy_done with fb_content, ig_content, hashtags...');
  const rowCopyDone = await supabase.updateContentCalendar(row.id, {
    fb_content: copyResult.parsed.fb_content,
    ig_content: copyResult.parsed.ig_content,
    hashtags: copyResult.parsed.hashtags,
    status: 'copy_done',
  });
  console.log(`  id=${rowCopyDone.id} status=${rowCopyDone.status}`);
  const verify1 = await sbSelect(row.id);
  console.log(`  [VERIFY] Raw SELECT: id=${verify1.id} status="${verify1.status}"`);
  if (verify1.status !== 'copy_done') {
    console.error(`✗ FATAL: Expected status=copy_done, got "${verify1.status}"`);
    process.exit(1);
  }
  ok(`Supabase row ${verify1.id} has status="copy_done" ✓`);

  // Update to pending_review
  console.log('\n[DB] Updating to status=pending_review...');
  const rowPendingReview = await supabase.updateContentCalendar(row.id, { status: 'pending_review' });
  console.log(`  id=${rowPendingReview.id} status=${rowPendingReview.status}`);
  const verify2 = await sbSelect(row.id);
  console.log(`  [VERIFY] Raw SELECT: id=${verify2.id} status="${verify2.status}"`);
  if (verify2.status !== 'pending_review') {
    console.error(`✗ FATAL: Expected status=pending_review, got "${verify2.status}"`);
    process.exit(1);
  }
  ok(`Supabase row ${verify2.id} has status="pending_review" ✓`);

  results.step4 = '✓ selected → copy_done → pending_review state machine OK';
}

// ============================================
// STEP 5: Reject with review_notes — verify DB persistence
// ============================================
async function step5_reject_with_notes(row) {
  sep('STEP 5: Reject with review_notes → verify DB persistence');

  const REJECT_NOTES = "Make the FB version shorter and more rhythmic, like 'Simple design. Strong airflow.' Add website CTA at the end.";

  console.log(`[DB] Rejecting with review_notes: "${REJECT_NOTES}"`);
  const rejectPayload = buildRejectPayload(REJECT_NOTES);
  info('buildRejectPayload output', JSON.stringify(rejectPayload));

  const rowRejected = await supabase.updateContentCalendar(row.id, rejectPayload);
  console.log(`  id=${rowRejected.id} status=${rowRejected.status}`);
  console.log(`  review_notes from returned row: "${rowRejected.review_notes}"`);

  // Raw SELECT to verify review_notes persisted
  const verifyRow = await sbSelect(row.id);
  console.log('\n[RAW SELECT from Supabase — FULL ROW]:');
  console.log(JSON.stringify(verifyRow, null, 2));

  if (verifyRow.status !== 'rejected') {
    console.error(`✗ FATAL: Expected status=rejected, got "${verifyRow.status}"`);
    process.exit(1);
  }
  ok(`Supabase row ${verifyRow.id} has status="rejected" ✓`);

  if (verifyRow.review_notes !== REJECT_NOTES) {
    console.error(`✗ FATAL: Expected review_notes="${REJECT_NOTES}", got "${verifyRow.review_notes}"`);
    process.exit(1);
  }
  ok(`review_notes correctly saved: "${verifyRow.review_notes}" ✓`);

  results.step5 = {
    status: '✓ review_notes persisted in DB',
    saved_value: verifyRow.review_notes,
    db_status: verifyRow.status,
  };
  return verifyRow;
}

// ============================================
// STEP 6: Re-do copy with review_notes from DB
// ============================================
async function step6_redo_with_review_notes(row) {
  sep('STEP 6: Re-generate copy with review_notes → LLM prompt must include REVISION CONTEXT');

  // Read fresh row from DB (includes review_notes)
  const freshRow = await sbSelect(row.id);
  const topic = freshRow.topic || 'Fanz ceiling fan promotion';
  const pillar = freshRow.pillar || 'product';
  const reviewNotes = (freshRow.review_notes || '').trim() || null;

  info('Read from DB — topic', topic);
  info('Read from DB — pillar', pillar);
  info('Read from DB — review_notes', reviewNotes);

  if (!reviewNotes) {
    console.error('✗ FATAL: review_notes is empty in DB row — cannot proceed');
    process.exit(1);
  }

  // Build prompt WITH reviewNotes (3rd argument)
  const cp = buildCopywritingPrompt(topic, pillar, reviewNotes);
  info('PROMPT length', cp.length + ' chars');

  // Print first 300 chars to verify REVISION CONTEXT presence
  console.log('\n[PROMPT — FIRST 300 CHARS]:');
  console.log(cp.substring(0, 300));
  console.log('...');

  // Verify REVISION CONTEXT is present
  if (!cp.includes('REVISION CONTEXT')) {
    console.error('✗ FATAL: Prompt does NOT contain REVISION CONTEXT header');
    process.exit(1);
  }
  ok('Prompt contains REVISION CONTEXT section header ✓');

  // Verify specific notes text is present
  if (!cp.includes(reviewNotes)) {
    console.error(`✗ FATAL: Prompt does NOT contain the actual review notes text: "${reviewNotes}"`);
    process.exit(1);
  }
  ok(`Prompt contains the specific review notes text: "${reviewNotes.substring(0, 40)}..." ✓`);

  // Verify DO NOT simply rephrase instruction
  if (!cp.includes('DO NOT simply rephrase')) {
    console.error('✗ FATAL: Prompt missing "DO NOT simply rephrase" instruction');
    process.exit(1);
  }
  ok('Prompt contains "DO NOT simply rephrase — actively incorporate the feedback" ✓');

  // Call LLM with the revision-aware prompt
  console.log('\n[LLM] Calling OpenRouter with revision-aware prompt...');
  const raw = await callOpenRouter([
    { role: 'system', content: cp },
    { role: 'user', content: 'Generate social media content for this Fanz topic, incorporating the revision feedback.' }
  ]);

  console.log('\n[LLM RAW RESPONSE] length=' + raw.length);
  console.log(raw);

  const parsed = parseCopywritingResponse(raw);
  if (!parsed) {
    console.error('✗ FATAL: parseCopywritingResponse returned null for regenerated content');
    process.exit(1);
  }
  info('FB content', parsed.fb_content.length + ' chars');
  info('IG content', parsed.ig_content.length + ' chars');
  info('Hashtags', parsed.hashtags.length + ' chars');
  ok('parseCopywritingResponse: STABLE (regenerated content)');

  const validation = validateCopywritingResult(parsed);
  info('Validation valid', validation.valid);
  info('Keywords hit', JSON.stringify(validation.keywordsHit));
  info('Errors', JSON.stringify(validation.errors));

  if (!validation.valid) {
    console.warn('  ⚠️  Validation has errors — continuing anyway (non-fatal)');
  }

  // Update to copy_done → pending_review (state machine: rejected → copy_done → pending_review)
  console.log('\n[DB] Updating to status=copy_done (rejected → copy_done)...');
  const rowCopyDone = await supabase.updateContentCalendar(row.id, {
    fb_content: parsed.fb_content,
    ig_content: parsed.ig_content,
    hashtags: parsed.hashtags,
    status: 'copy_done',
  });
  console.log(`  id=${rowCopyDone.id} status=${rowCopyDone.status}`);
  const verify1 = await sbSelect(row.id);
  console.log(`  [VERIFY] Raw SELECT: id=${verify1.id} status="${verify1.status}"`);
  if (verify1.status !== 'copy_done') {
    console.error(`✗ FATAL: Expected status=copy_done, got "${verify1.status}"`);
    process.exit(1);
  }
  ok(`State machine: rejected → copy_done ✓ (row ${verify1.id})`);

  console.log('\n[DB] Updating to status=pending_review (copy_done → pending_review)...');
  const rowPending = await supabase.updateContentCalendar(row.id, { status: 'pending_review' });
  console.log(`  id=${rowPending.id} status=${rowPending.status}`);
  const verify2 = await sbSelect(row.id);
  console.log(`  [VERIFY] Raw SELECT: id=${verify2.id} status="${verify2.status}"`);
  if (verify2.status !== 'pending_review') {
    console.error(`✗ FATAL: Expected status=pending_review, got "${verify2.status}"`);
    process.exit(1);
  }
  ok(`State machine: copy_done → pending_review ✓ (row ${verify2.id})`);

  results.step6 = {
    prompt_contains_revision_context: '✓',
    prompt_contains_specific_notes: '✓',
    state_machine_rejected_to_copy_done: '✓',
    state_machine_copy_done_to_pending_review: '✓',
    parse_stable: '✓',
  };
}

// ============================================
// STEP 7: Cleanup
// ============================================
async function cleanup() {
  sep('CLEANUP');
  console.log(`Deleting ${createdRows.length} test rows: ${createdRows.join(', ')}`);
  for (const id of createdRows) {
    try {
      await sbDelete(id);
      console.log(`  Deleted row ${id}`);
    } catch (err) {
      console.warn(`  ⚠️  Failed to delete row ${id}: ${err.message}`);
    }
  }
  ok(`Cleaned up ${createdRows.length} rows`);
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('='.repeat(80));
  console.log('  REVIEW NOTES — E2E REAL LLM PIPELINE TEST');
  console.log('  Model: ' + MODEL);
  console.log('  Time: ' + new Date().toISOString());
  console.log('  Chat ID: ' + TEST_CHAT_ID);
  console.log('='.repeat(80) + '\n');

  try {
    // STEP 1: Plan with real LLM
    const { plans } = await step1_planning();
    const plan = plans[0];

    // STEP 2: Select plan → DB
    const row = await step2_select(plan);

    // STEP 3: Copywriting (NO reviewNotes)
    const copyResult = await step3_copywriting(plan, row);

    // STEP 4: copy_done → pending_review
    await step4_to_pending_review(row, copyResult);

    // STEP 5: Reject with review_notes — verify DB persistence
    const rejectedRow = await step5_reject_with_notes(row);

    // STEP 6: Re-generate with review_notes — verify prompt
    await step6_redo_with_review_notes(row);

    // ✅ FINAL SUMMARY
    sep('FINAL VERIFICATION SUMMARY');

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────────────────────┐');
    console.log('│  REVIEW NOTES — E2E REAL LLM PIPELINE TEST                                 │');
    console.log('├─────────────────────────────────────────────────────────────────────────────┤');
    console.log('│  VERIFICATION 1: review_notes real DB persistence                           │');
    console.log(`│    review_notes saved: ${results.step5.status.padEnd(38)} │`);
    console.log(`│    Saved value: "${results.step5.saved_value}"      │`);
    console.log('├─────────────────────────────────────────────────────────────────────────────┤');
    console.log('│  VERIFICATION 2: LLM prompt receives review_notes                           │');
    console.log(`│    Prompt contains REVISION CONTEXT:        ${results.step6.prompt_contains_revision_context.padEnd(18)} │`);
    console.log(`│    Prompt contains specific notes:         ${results.step6.prompt_contains_specific_notes.padEnd(18)} │`);
    console.log(`│    parseCopywritingResponse stable:        ${results.step6.parse_stable.padEnd(18)} │`);
    console.log('├─────────────────────────────────────────────────────────────────────────────┤');
    console.log('│  VERIFICATION 3: State machine flow                                         │');
    console.log(`│    rejected → copy_done:                   ${results.step6.state_machine_rejected_to_copy_done.padEnd(18)} │`);
    console.log(`│    copy_done → pending_review:             ${results.step6.state_machine_copy_done_to_pending_review.padEnd(18)} │`);
    console.log('├─────────────────────────────────────────────────────────────────────────────┤');
    console.log('│  OVERALL RESULT:  ALL 3 VERIFICATIONS PASSED                                │');
    console.log('└─────────────────────────────────────────────────────────────────────────────┘');
    console.log('');
    ok('review_notes 真实落库 ✓');
    ok('LLM prompt 收到修改意见 ✓');
    ok('状态机 rejected → copy_done → pending_review 正确流转 ✓');
    console.log('');

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    if (err.stack) console.error(err.stack.substring(0, 500));
    console.log('\nCreated row IDs before failure: ' + createdRows.join(', '));
  } finally {
    // Always clean up
    await cleanup();
  }
}

main();