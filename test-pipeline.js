// ============================================
// test-pipeline.js — [I-5] 配图流水线编排自测
//
// Part A: 纯函数/逻辑测试（async）
// Part B: 集成（需 Railway/Storage/DB）
// ============================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let exitCode = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  exitCode = 1;
}

// ============================================
// Main
// ============================================

(async function main() {
  // ── Part A: Pure function tests (async) ──
  console.log('=== Part A: Orchestrator logic tests ===\n');

  try {
    const pipeline = require('./lib/pipeline');

    // Test 1: Module loads
    console.log('Test 1: Pipeline module loads');
    assert.ok(typeof pipeline.runImageryPipeline === 'function');
    console.log('  PASS');

    // Test 2: Pipeline with nonexistent row
    console.log('Test 2: Pipeline with nonexistent row');
    try {
      const result = await pipeline.runImageryPipeline('00000000-0000-0000-0000-000000000000');
      assert.ok(typeof result.success === 'boolean');
      if (!result.success) assert.ok(result.error);
      console.log(`  PASS (success=${result.success})`);
    } catch (e) {
      assert.ok(
        e.message.includes('Supabase not configured') || e.message.includes('configured'),
        `Error should be about Supabase config, got: ${e.message.slice(0, 60)}`
      );
      console.log('  PASS (Supabase not configured — expected)');
    }

    // Test 3: Index path exists
    console.log('Test 3: Index with pipeline module exists');
    assert.ok(fs.existsSync('./lib/pipeline.js'));
    assert.ok(fs.existsSync('./index.js'));
    console.log('  PASS');

    // Test 4: Dashboard image-review route exists
    console.log('Test 4: Dashboard image-review route exists');
    assert.ok(
      fs.existsSync(path.resolve(__dirname, '..', 'fanz-dashboard', 'app', 'api', 'marketing', 'image-review', 'route.js'))
    );
    console.log('  PASS');

    // Test 5: Dashboard pending-images route exists
    console.log('Test 5: Dashboard pending-images route exists');
    assert.ok(
      fs.existsSync(path.resolve(__dirname, '..', 'fanz-dashboard', 'app', 'api', 'marketing', 'pending-images', 'route.js'))
    );
    console.log('  PASS');

    // Test 6: No inline scene-gen chain in index.js
    console.log('Test 6: No inline scene-gen chain in index.js');
    const idxContent = fs.readFileSync('./index.js', 'utf8');
    const hasOldInline =
      idxContent.includes('generateSceneImage(rowId,') &&
      idxContent.includes('row.topic') &&
      idxContent.includes('productsDir');
    assert.ok(!hasOldInline, 'Old inline scene-gen chain should be removed');
    console.log('  PASS');

    // Test 7: sendImageReviewCard uses sendPhoto
    console.log('Test 7: sendImageReviewCard calls sendPhoto');
    assert.ok(idxContent.includes('sendPhoto('), 'sendPhoto should be called');
    assert.ok(idxContent.includes('sendMessage'), 'sendMessage should exist (fallback)');
    console.log('  PASS');

    // Test 8: Dashboard image-review exposes the current action set
    // (旧断言找 'reject'——六出口版路由从未有过该 action，属过时期望)
    console.log('Test 8: Dashboard image-review handles the six-exit actions');
    const dashRoute = fs.readFileSync(
      path.resolve(__dirname, '..', 'fanz-dashboard', 'app', 'api', 'marketing', 'image-review', 'route.js'),
      'utf8'
    );
    for (const a of ["'approve'", "'regenerate'", "'change_scene'", "'change_product'", "'edit_compose'", "'skip'"]) {
      assert.ok(dashRoute.includes(a), `action ${a} missing from image-review route`);
    }
    assert.ok(dashRoute.includes("'image_ready'"));
    console.log('  PASS (all current actions present)');
  } catch (e) {
    fail(e.message);
  }

  // ── Part B: Integration tests ──
  await runPartB();

  console.log('');
  if (exitCode === 0) {
    console.log('=== All tests passed ===');
  } else {
    console.error(`=== Some tests FAILED (exit code ${exitCode}) ===`);
  }
  process.exit(exitCode);
})();

// ============================================
// Part B: Integration tests
// ============================================

async function runPartB() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log('\n=== Part B: Integration tests ===\n');
    console.log('SUPABASE_URL and SUPABASE_SERVICE_KEY not set — skipping DB tests');
    return;
  }

  console.log('\n=== Part B: Integration tests ===\n');
  console.log('SUPABASE credentials detected — running DB tests\n');

  const BASE = supabaseUrl.replace(/\/+$/, '');
  const TABLE = 'content_calendar';
  const createdIds = [];

  async function api(method, path, body) {
    const opts = {
      method,
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      opts.body = JSON.stringify(body);
      opts.headers['Prefer'] = 'return=representation';
    }
    const res = await fetch(`${BASE}${path}`, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, ok: res.ok, data };
  }

  try {
    // DB-1: Create a row at image_ready
    console.log('DB-1: Create row at image_ready');
    const cr = await api('POST', `/rest/v1/${TABLE}`, {
      status: 'image_ready',
      pillar: 'product',
      topic: `test-pipeline-db1-${Date.now()}`,
      chat_id: 'test-pipeline',
    });
    const row = Array.isArray(cr.data) ? cr.data[0] : cr.data;
    if (cr.ok && row) {
      createdIds.push(row.id);
      console.log(`  ✓ Created: id=${row.id.slice(0, 12)}..., status=${row.status}`);
      console.log('  PASS');
    } else {
      fail(`Create failed: ${JSON.stringify(cr.data).slice(0, 100)}`);
    }

    // DB-2: Verify pending-images route logic (SELECT by image_ready)
    console.log('\nDB-2: Pending images query (image_ready)');
    const qr = await api('GET', `/rest/v1/${TABLE}?status=eq.image_ready&order=created_at.desc&limit=5`);
    if (qr.ok) {
      const rows = Array.isArray(qr.data) ? qr.data : [];
      console.log(`  ✓ Found ${rows.length} rows with image_ready status`);
      console.log('  PASS');
    } else {
      fail(`Query failed: ${JSON.stringify(qr.data).slice(0, 100)}`);
    }

    // DB-3: Simulate Dashboard image_review approve (image_ready → approved)
    console.log('\nDB-3: Dashboard image_review approve (image_ready → approved)');
    try {
      const cr3 = await api('POST', `/rest/v1/${TABLE}`, {
        status: 'image_ready',
        pillar: 'product',
        topic: `test-pipeline-db3-${Date.now()}`,
        chat_id: 'test-pipeline',
      });
      const row3 = Array.isArray(cr3.data) ? cr3.data[0] : cr3.data;
      createdIds.push(row3.id);
      const up3 = await api('PATCH',
        `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(row3.id)}&status=eq.image_ready`,
        { status: 'approved' }
      );
      const updated3 = Array.isArray(up3.data) ? up3.data[0] : up3.data;
      assert.ok(updated3 && updated3.status === 'approved', `Should become approved, got ${updated3 ? updated3.status : 'N/A'}`);
      console.log(`  ✓ ${row3.status} → ${updated3.status}`);
      console.log('  PASS');
    } catch (e) {
      fail(`Approve failed: ${e.message}`);
    }

    // DB-4: Simulate Dashboard image_review reject (image_ready → image_retry)
    console.log('\nDB-4: Dashboard image_review reject (image_ready → image_retry)');
    try {
      const cr4 = await api('POST', `/rest/v1/${TABLE}`, {
        status: 'image_ready',
        pillar: 'product',
        topic: `test-pipeline-db4-${Date.now()}`,
        chat_id: 'test-pipeline',
      });
      const row4 = Array.isArray(cr4.data) ? cr4.data[0] : cr4.data;
      createdIds.push(row4.id);
      const up4 = await api('PATCH',
        `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(row4.id)}&status=eq.image_ready`,
        { status: 'image_retry' }
      );
      const updated4 = Array.isArray(up4.data) ? up4.data[0] : up4.data;
      assert.ok(updated4 && updated4.status === 'image_retry', `Should become image_retry, got ${updated4 ? updated4.status : 'N/A'}`);
      console.log(`  ✓ ${row4.status} → ${updated4.status}`);
      console.log('  PASS');
    } catch (e) {
      fail(`Reject failed: ${e.message}`);
    }

    // DB-5: Simulate Dashboard image_review skip (image_ready → approved)
    console.log('\nDB-5: Dashboard image_review skip (image_ready → approved)');
    try {
      const cr5 = await api('POST', `/rest/v1/${TABLE}`, {
        status: 'image_ready',
        pillar: 'product',
        topic: `test-pipeline-db5-${Date.now()}`,
        chat_id: 'test-pipeline',
      });
      const row5 = Array.isArray(cr5.data) ? cr5.data[0] : cr5.data;
      createdIds.push(row5.id);
      const up5 = await api('PATCH',
        `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(row5.id)}&status=eq.image_ready`,
        { status: 'approved' }
      );
      const updated5 = Array.isArray(up5.data) ? up5.data[0] : up5.data;
      assert.ok(updated5 && updated5.status === 'approved', `Should become approved, got ${updated5 ? updated5.status : 'N/A'}`);
      console.log(`  ✓ ${row5.status} → ${updated5.status}`);
      console.log('  PASS');
    } catch (e) {
      fail(`Skip failed: ${e.message}`);
    }

    // DB-6: TOCTOU guard — PATCH with wrong status filter returns empty
    console.log('\nDB-6: TOCTOU guard blocks stale PATCH');
    try {
      const cr6 = await api('POST', `/rest/v1/${TABLE}`, {
        status: 'image_ready',
        pillar: 'product',
        topic: `test-pipeline-db6-${Date.now()}`,
        chat_id: 'test-pipeline',
      });
      const r6 = Array.isArray(cr6.data) ? cr6.data[0] : cr6.data;
      createdIds.push(r6.id);
      const badUp = await api('PATCH',
        `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(r6.id)}&status=eq.approved`,
        { status: 'published' }
      );
      const empty = Array.isArray(badUp.data) ? badUp.data.length === 0 : badUp.data === null;
      assert.ok(empty, 'TOCTOU guard should prevent stale PATCH');
      console.log('  ✓ TOCTOU guard blocked stale PATCH');
      console.log('  PASS');
    } catch (e) {
      fail(`TOCTOU test failed: ${e.message}`);
    }
  } finally {
    // Cleanup
    console.log('\nCLEANUP: Delete test rows');
    for (const id of createdIds) {
      if (!id) continue;
      const dr = await api('DELETE', `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`);
      console.log(`  DELETE ${id.slice(0, 12)}...: HTTP ${dr.status}`);
    }
  }
}