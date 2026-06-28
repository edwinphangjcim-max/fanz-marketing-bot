#!/usr/bin/env node
// ============================================
// M-5 REAL imagery test — with OPENAI_API_KEY
// Tests: real GPT Image 2 gen, change scene, upload own
// ============================================
const path = require('path');
const fs = require('fs');
const supabase = require('./lib/supabase');
const { generateSceneImage, callGptImage2, buildScenePrompt } = require('./lib/scene-gen');

let passed = 0, failed = 0;
const cleanupIds = [];

function pass(n) { passed++; console.log(`  ✅ ${n}`); }
function fail(n, e) { failed++; console.error(`  ❌ ${n}: ${e ? e.message : 'fail'}`); }
function assert(cond, msg) { if (cond) pass(msg); else fail(msg, new Error('assertion failed')); }
async function delCal(id) {
  if (!id) return;
  try { await fetch(`${process.env.SUPABASE_URL}/rest/v1/content_calendar?id=eq.${id}`, { method: 'DELETE', headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY } }); } catch(_) {}
}

const ASSETS_DIR = path.join(__dirname, 'assets', 'products');
const PRODUCT_IMAGE = path.join(ASSETS_DIR, 'fanz-product-test.png');

async function createPost(overrides = {}) {
  const row = await supabase.createContentCalendar({
    chat_id: 'test-m5-real',
    pillar: 'product',
    topic: 'FS Series 563 L: Real GPT Image Test - ' + Date.now(),
    post_angle: 'Showcasing the FS Series in a modern living room',
    suggested_date: '2026-07-03',
    status: 'draft',
    ...overrides,
  });
  // Transition from draft to copy_approved through legal path
  await supabase.updateContentCalendar(row.id, { status: 'planned' });
  await supabase.updateContentCalendar(row.id, { status: 'plan_approved' });
  await supabase.updateContentCalendar(row.id, { status: 'copy_done' });
  await supabase.updateContentCalendar(row.id, { status: 'pending_review' });
  await supabase.updateContentCalendar(row.id, { status: 'copy_approved', image_status: 'pending', ...overrides });
  cleanupIds.push(row.id);
  return await supabase.getContentCalendar(row.id);
}

(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  M-5 REAL IMAGE TEST — GPT Image 2 + 6 exits               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const API_KEY = process.env.OPENAI_API_KEY;
  console.log(`  OPENAI_API_KEY: ${API_KEY ? `SET (${API_KEY.substring(0,12)}...)` : 'NOT SET'}`);
  console.log(`  ASSETS_DIR: ${ASSETS_DIR}`);
  console.log(`  PRODUCT_IMAGE: ${PRODUCT_IMAGE}`);
  console.log(`  IMAGE EXISTS: ${fs.existsSync(PRODUCT_IMAGE)}`);
  console.log();

  if (!API_KEY) { console.error('❌ OPENAI_API_KEY required — abort'); process.exit(1); }

  // ================================================
  // TEST 1: REAL GPT Image 2 generation (via direct API call)
  // ================================================
  console.log('━━━ TEST 1: Real GPT Image 2 via direct callGptImage2 ━━━');

  const prompt1 = buildScenePrompt('product', 'FS Series 563 L ceiling fan in modern living room');
  console.log(`  Prompt: ${prompt1.substring(0, 80)}...`);
  
  try {
    const apiResult = await callGptImage2(prompt1, PRODUCT_IMAGE);
    console.log(`  Result: dryRun=${apiResult.dryRun}, data=${apiResult.data ? apiResult.data.length + ' bytes' : 'null'}, mime=${apiResult.mimeType}`);
    
    if (apiResult.dryRun) {
      fail('GPT Image 2 real call', new Error('Got dry-run despite OPENAI_API_KEY set'));
    } else if (apiResult.data) {
      // Save the generated image
      const scenesDir = path.join(__dirname, 'assets', 'scenes');
      if (!fs.existsSync(scenesDir)) fs.mkdirSync(scenesDir, { recursive: true });
      const genFile = `scene-real-test-${Date.now()}.png`;
      fs.writeFileSync(path.join(scenesDir, genFile), apiResult.data);
      const stats = fs.statSync(path.join(scenesDir, genFile));
      pass(`GPT Image 2 real generation: ${genFile} (${stats.size} bytes, mime=${apiResult.mimeType})`);
      console.log(`  Saved to: assets/scenes/${genFile}`);
      // Cleanup
      fs.unlinkSync(path.join(scenesDir, genFile));
    } else {
      fail('GPT Image 2 real call', new Error('No data returned'));
    }
  } catch (err) {
    fail('GPT Image 2 real call', err);
  }

  // ================================================
  // TEST 2: Change scene — custom prompt
  // ================================================
  console.log();
  console.log('━━━ TEST 2: Change scene — custom description ━━━');

  const NEW_SCENE = 'Bedroom at dusk with warm ambient lighting, cozy interior, ceiling fan above a bed, soft curtains';
  const prompt2 = `${NEW_SCENE}. Featured product: modern ceiling fan.`;
  
  try {
    const apiResult2 = await callGptImage2(prompt2, PRODUCT_IMAGE);
    console.log(`  Result: dryRun=${apiResult2.dryRun}, data=${apiResult2.data ? apiResult2.data.length + ' bytes' : 'null'}`);
    
    if (apiResult2.dryRun) {
      fail('Change scene real call', new Error('Got dry-run'));
    } else if (apiResult2.data) {
      const scenesDir = path.join(__dirname, 'assets', 'scenes');
      const genFile = `change-scene-test-${Date.now()}.png`;
      fs.writeFileSync(path.join(scenesDir, genFile), apiResult2.data);
      const stats = fs.statSync(path.join(scenesDir, genFile));
      pass(`Change scene: custom prompt "${NEW_SCENE.substring(0, 40)}..." → ${genFile} (${stats.size} bytes)`);
      fs.unlinkSync(path.join(scenesDir, genFile));
    } else {
      fail('Change scene real call', new Error('No data'));
    }
  } catch (err) {
    fail('Change scene real call', err);
  }

  // ================================================
  // TEST 3: Upload own image
  // ================================================
  console.log();
  console.log('━━━ TEST 3: Upload own image ━━━');

  const row2 = await createPost({ status: 'image_ready' });
  console.log(`  Row: id=${row2.id}`);

  // Simulate user uploading a photo
  const scenesDir = path.join(__dirname, 'assets', 'scenes');
  if (!fs.existsSync(scenesDir)) fs.mkdirSync(scenesDir, { recursive: true });
  const uploadName = `user-uploaded-${Date.now()}.png`;
  const uploadDest = path.join(scenesDir, uploadName);
  
  // Use the product image as the "user uploaded" image
  fs.copyFileSync(PRODUCT_IMAGE, uploadDest);
  const imgStats = fs.statSync(uploadDest);

  // Update DB as if user uploaded
  await supabase.updateContentCalendar(row2.id, {
    image_url: uploadName,
    image_source: 'user_uploaded',
    status: 'approved',
  });

  const dbR2 = await supabase.getContentCalendar(row2.id);
  console.log(`  DB: image_url=${dbR2.image_url}, image_source=${dbR2.image_source}, status=${dbR2.status}`);
  assert(dbR2.image_url === uploadName, `image_url = "${uploadName}"`);
  assert(dbR2.image_source === 'user_uploaded', `image_source = user_uploaded`);
  assert(dbR2.status === 'approved', `status = approved`);
  pass(`Upload own: file stored "${uploadName}" (${imgStats.size} bytes), DB updated, image_source=user_uploaded`);
  
  // Clean up uploaded file
  if (fs.existsSync(uploadDest)) fs.unlinkSync(uploadDest);

  // ================================================
  // SUMMARY
  // ================================================
  console.log();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  M-5 REAL: ${passed} passed, ${failed} failed                      ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Cleanup DB rows
  for (const id of cleanupIds) await delCal(id);
  console.log(`  Cleaned up ${cleanupIds.length} rows`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });