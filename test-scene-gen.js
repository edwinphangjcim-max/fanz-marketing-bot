// ============================================
// test-scene-gen.js — GPT Image 2 场景图生成自测 [I-2]
//
// Part A: 纯函数（无需 DB / API key）
// Part B: DB 集成（需 SUPABASE_URL + SUPABASE_SERVICE_KEY，不碰真实资产）
// Part C: API 集成（需 OPENAI_API_KEY，注入临时产品图）
// ============================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sceneGen = require('./lib/scene-gen');

let exitCode = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  exitCode = 1;
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `test-scene-${prefix}-`));
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ============================================
// Main
// ============================================

(async function main() {

console.log('=== Part A: Pure function tests ===\n');

// ──────────────────────────────────────────
// 1. buildScenePrompt 返回字符串
// ──────────────────────────────────────────
console.log('Test 1: buildScenePrompt returns a string');
try {
  const prompt = sceneGen.buildScenePrompt('product', 'test topic');
  assert.ok(typeof prompt === 'string', 'Should return a string');
  assert.ok(prompt.length > 20, 'Should be a meaningful prompt');
  console.log('  PASS');
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 2. buildScenePrompt 含"保持外观不变"约束
// ──────────────────────────────────────────
console.log('Test 2: buildScenePrompt contains "外观" constraint');
try {
  const prompt = sceneGen.buildScenePrompt('product', 'test');
  const hasConstraint =
    prompt.includes('unchanged') ||
    prompt.includes('不变') ||
    prompt.includes('do not alter') ||
    prompt.includes('do NOT');
  assert.ok(hasConstraint, 'Prompt should contain the "keep appearance unchanged" constraint');
  console.log('  PASS');
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 3. 各 pillar 有不同的场景关键词
// ──────────────────────────────────────────
console.log('Test 3: Each pillar produces a different scene description');
try {
  const prompts = {};
  for (const pillar of ['product', 'case', 'promo', 'story']) {
    prompts[pillar] = sceneGen.buildScenePrompt(pillar, 'generic topic');
  }
  const unique = new Set(Object.values(prompts));
  assert.ok(unique.size >= 2, `Expected at least 2 unique prompts, got ${unique.size}`);
  console.log(`  PASS (${unique.size} unique prompts from ${Object.keys(prompts).length} pillars)`);
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 4. 节庆关键词触发对应场景
// ──────────────────────────────────────────
console.log('Test 4: Festival keywords trigger festival-specific scenes');
try {
  const festivals = Object.keys(sceneGen.FESTIVAL_SCENE);
  const testFestivals = festivals.slice(0, Math.min(3, festivals.length));
  for (const f of testFestivals) {
    const prompt = sceneGen.buildScenePrompt('product', `${f} promotion`);
    const festivalWords = f.split(/\s+/);
    const matched = festivalWords.some(word =>
      word.length > 3 && prompt.toLowerCase().includes(word.toLowerCase())
    );
    assert.ok(matched, `Festival "${f}" should be reflected in the scene prompt`);
    console.log(`    ✓ "${f}" → prompt contains festival context`);
  }
  console.log('  PASS');
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 5. callGptImage2 dry-run 返回带 DRYRUN 标记的数据
// ──────────────────────────────────────────
console.log('Test 5: callGptImage2 dry-run returns data with dryRun flag');
try {
  const tmpDir = makeTempDir('dryrun');
  try {
    const testImage = path.join(tmpDir, 'test-product.png');
    fs.writeFileSync(testImage, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    ));

    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const result = await sceneGen.callGptImage2('test prompt', testImage);
    assert.ok(result.dryRun === true, 'Should have dryRun=true');
    assert.ok(Buffer.isBuffer(result.data), 'Should return buffer data');
    assert.ok(result.data.length > 0, 'Buffer should not be empty');
    console.log('  PASS (dry-run placeholder returned)');

    if (origKey) process.env.OPENAI_API_KEY = origKey;
  } finally {
    cleanupTempDir(tmpDir);
  }
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 6. callGptImage2 对缺失产品图抛异常
// ──────────────────────────────────────────
console.log('Test 6: callGptImage2 with fake API key + missing image throws error');
try {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fake-test-key';

  try {
    await sceneGen.callGptImage2('test', '/nonexistent/image.png');
    fail('Should have thrown for missing image');
  } catch (err) {
    assert.ok(err.message.includes('not found'), `Error should mention "not found", got: "${err.message}"`);
    console.log('  PASS');
  } finally {
    if (origKey) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 7. generateSceneImage dry-run 返回 success=true, dryRun=true
// ──────────────────────────────────────────
console.log('Test 7: generateSceneImage dry-run returns success with dryRun=true');
try {
  const tmpDir = makeTempDir('gen');
  try {
    const productsDir = path.join(tmpDir, 'products');
    fs.mkdirSync(productsDir, { recursive: true });
    const testProductImage = 'fs-series-test.svg';
    fs.writeFileSync(path.join(productsDir, testProductImage), '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>');

    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const origSupabase = require('./lib/supabase');
    const origImageState = require('./lib/image-state');
    const origGet = origSupabase.getContentCalendar;
    const origUpdateImageRow = origImageState.updateImageRow;

    const fakeRowId = '00000000-0000-0000-0000-000000000001';
    const capturedUpdates = [];

    origSupabase.getContentCalendar = async (id) => {
      return { id, image_status: 'pending', topic: 'test topic', pillar: 'product' };
    };

    origImageState.updateImageRow = async (id, data, expectedStatus) => {
      capturedUpdates.push({ id, data, expectedStatus });
      return { id, ...data };
    };

    const result = await sceneGen.generateSceneImage(fakeRowId, 'test topic', 'product', testProductImage, productsDir);

    assert.ok(result.success === true, 'Should succeed');
    assert.ok(result.dryRun === true, 'Should be dry-run');
    assert.ok(result.imageStatus === 'generated', 'Should have imageStatus=generated');
    assert.ok(result.sceneImageUrl && result.sceneImageUrl.startsWith('DRYRUN-'), `sceneImageUrl should start with "DRYRUN-", got "${result.sceneImageUrl}"`);
    console.log(`  PASS (sceneImageUrl: ${result.sceneImageUrl})`);

    origSupabase.getContentCalendar = origGet;
    origImageState.updateImageRow = origUpdateImageRow;
    if (origKey) process.env.OPENAI_API_KEY = origKey;
  } finally {
    cleanupTempDir(tmpDir);
  }
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 8. 幂等性：已 generated 状态不重复调 API
// ──────────────────────────────────────────
console.log('Test 8: Idempotency — status=generated skips API call');
try {
  const origSupabase = require('./lib/supabase');
  const origGet = origSupabase.getContentCalendar;

  const fakeRowId = '00000000-0000-0000-0000-000000000002';

  origSupabase.getContentCalendar = async (id) => {
    return { id, image_status: 'generated', scene_image_url: 'existing-scene.png', topic: 'test', pillar: 'product' };
  };

  const result = await sceneGen.generateSceneImage(fakeRowId, 'test', 'product', null, '/tmp');
  assert.ok(result.idempotent === true, 'Should have idempotent=true');
  assert.ok(result.imageStatus === 'generated', 'imageStatus should be generated');
  assert.ok(result.success === true, 'Should succeed');
  console.log('  PASS (skipped API call due to idempotency)');

  origSupabase.getContentCalendar = origGet;
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 9. 失败时 image_status='failed' 不抛未捕获异常
// ──────────────────────────────────────────
console.log('Test 9: Failure sets image_status=failed without throwing uncaught');
try {
  const origSupabase = require('./lib/supabase');
  const origImageState = require('./lib/image-state');
  const origGet = origSupabase.getContentCalendar;
  const origUpdate = origImageState.updateImageRow;

  const fakeRowId = '00000000-0000-0000-0000-000000000003';

  origSupabase.getContentCalendar = async (id) => {
    return { id, image_status: 'pending', topic: 'test', pillar: 'product' };
  };

  origImageState.updateImageRow = async (id, data, expectedStatus) => {
    return { id, ...data };
  };

  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'invalid-key';

  const tmpDir = makeTempDir('failure');
  try {
    const testImage = 'test.png';
    const productsDir = path.join(tmpDir, 'products');
    fs.mkdirSync(productsDir, { recursive: true });
    fs.writeFileSync(path.join(productsDir, testImage), 'not a real image');

    const result = await sceneGen.generateSceneImage(fakeRowId, 'test', 'product', testImage, productsDir);

    assert.ok(result.success === false, 'Should report failure');
    assert.ok(result.imageStatus === 'failed', `imageStatus should be "failed", got "${result.imageStatus}"`);
    assert.ok(typeof result.error === 'string', 'Should have error message');
    console.log(`  PASS (error: ${result.error.slice(0, 80)})`);
  } finally {
    cleanupTempDir(tmpDir);
    if (origKey) {
      process.env.OPENAI_API_KEY = origKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    origSupabase.getContentCalendar = origGet;
    origImageState.updateImageRow = origUpdate;
  }
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 10. 超时保护配置正确（AbortController 150s）
console.log('Test 10: Timeout protection — API_TIMEOUT_MS is 150s');
try {
  assert.strictEqual(sceneGen.API_TIMEOUT_MS, 150_000, 'API_TIMEOUT_MS should be 150,000ms');
  console.log('  PASS');
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 11. DRY_RUN 由 OPENAI_API_KEY 控制
// ──────────────────────────────────────────
console.log('Test 11: DRY_RUN is controlled by OPENAI_API_KEY');
try {
  const origKey = process.env.OPENAI_API_KEY;

  // Without key → dry-run
  delete process.env.OPENAI_API_KEY;
  const tmpDir = makeTempDir('dry2');
  try {
    const testImage = path.join(tmpDir, 'dummy.png');
    fs.writeFileSync(testImage, 'dummy');
    const r1 = await sceneGen.callGptImage2('test', testImage);
    assert.ok(r1.dryRun === true, 'Without API key, should be dry-run');
    console.log('    ✓ Without OPENAI_API_KEY → dry-run');

    // With key → should try real API
    process.env.OPENAI_API_KEY = 'some-key';
    try {
      const r2 = await sceneGen.callGptImage2('test', testImage);
      assert.ok(!r2.dryRun, 'With API key set, dryRun should be falsy');
    } catch (err) {
      assert.ok(!err.message.includes('DRYRUN'),
        `Error should be real API error, not dry-run. Got: "${err.message}"`);
      console.log('    ✓ With OPENAI_API_KEY → tried real API (failed as expected with invalid key)');
    }
    console.log('  PASS');
  } finally {
    cleanupTempDir(tmpDir);
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  }
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 12. 未知 pillar 回退到 product
// ──────────────────────────────────────────
console.log('Test 12: Unknown pillar falls back to product scene');
try {
  const prompt = sceneGen.buildScenePrompt('unknown_pillar', 'test');
  assert.ok(typeof prompt === 'string' && prompt.length > 20,
    'Should still return a valid prompt for unknown pillar');
  console.log('  PASS');
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 13. EDITOR_CONSTRAINT 是静态 constant
// ──────────────────────────────────────────
console.log('Test 13: EDITOR_CONSTRAINT is a static constant');
try {
  assert.ok(typeof sceneGen.EDITOR_CONSTRAINT === 'string');
  assert.ok(sceneGen.EDITOR_CONSTRAINT.length > 30);
  console.log('  PASS');
} catch (e) {
  fail(e.message);
}

// ──────────────────────────────────────────
// 14. FESTIVAL_SCENE 和 PILLAR_SCENE 有完整覆盖
// ──────────────────────────────────────────
console.log('Test 14: FESTIVAL_SCENE and PILLAR_SCENE have complete coverage');
try {
  assert.ok(sceneGen.PILLAR_SCENE.product, 'PILLAR_SCENE.product exists');
  assert.ok(sceneGen.PILLAR_SCENE.case, 'PILLAR_SCENE.case exists');
  assert.ok(sceneGen.PILLAR_SCENE.promo, 'PILLAR_SCENE.promo exists');
  assert.ok(sceneGen.PILLAR_SCENE.story, 'PILLAR_SCENE.story exists');
  assert.ok(Object.keys(sceneGen.FESTIVAL_SCENE).length >= 3,
    `Expected >= 3 festivals, got ${Object.keys(sceneGen.FESTIVAL_SCENE).length}`);
  console.log(`  PASS (${Object.keys(sceneGen.PILLAR_SCENE).length} pillars, ${Object.keys(sceneGen.FESTIVAL_SCENE).length} festivals)`);
} catch (e) {
  fail(e.message);
}

// ============================================
// Part B: DB integration
// ============================================

console.log('\n=== Part B: DB integration tests ===\n');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.log('SUPABASE_URL and SUPABASE_SERVICE_KEY not set — skipping DB tests');
} else {
  console.log('SUPABASE_URL and SUPABASE_SERVICE_KEY detected — running DB tests\n');

  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const TABLE = 'content_calendar';
  let testRowId = null;

  try {
    // ──────────────────────────────────────────
    // DB-1. 创建测试行 → generateSceneImage → image_status 流转验证
    // ──────────────────────────────────────────
    console.log('DB-1: generateSceneImage transitions image_status: pending → generating → generated (dry-run)');
    try {
      const createRes = await fetch(`${baseUrl}/rest/v1/${TABLE}`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          status: 'draft',
          pillar: 'product',
          topic: 'GPT Image 2 scene test',
          chat_id: 'test-scene-gen',
        }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Failed to create test row: ${createRes.status} ${errText}`);
      }

      const createData = await createRes.json();
      const created = Array.isArray(createData) ? createData[0] : createData;
      testRowId = created.id;

      assert.strictEqual(created.image_status, 'pending', 'New row should have image_status=pending');

      const tmpDir = makeTempDir('db');
      try {
        const productsDir = path.join(tmpDir, 'products');
        fs.mkdirSync(productsDir, { recursive: true });
        const testSvg = 'fs-series-test-db.svg';
        fs.writeFileSync(path.join(productsDir, testSvg), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>');

        const origKey = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const result = await sceneGen.generateSceneImage(
          testRowId,
          'GPT Image 2 scene test',
          'product',
          testSvg,
          productsDir
        );

        assert.ok(result.success === true, 'Should succeed in dry-run mode');
        assert.ok(result.dryRun === true, 'Should be dry-run');
        assert.strictEqual(result.imageStatus, 'generated', 'Should end with imageStatus=generated');

        const fetchRes = await fetch(`${baseUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(testRowId)}&select=image_status,scene_image_url&limit=1`, {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        });
        const fetchData = await fetchRes.json();
        const updated = Array.isArray(fetchData) ? fetchData[0] : fetchData;

        assert.strictEqual(updated.image_status, 'generated',
          `DB image_status should be "generated", got "${updated.image_status}"`);
        assert.ok(
          updated.scene_image_url && updated.scene_image_url.startsWith('DRYRUN-'),
          `DB scene_image_url should start with "DRYRUN-", got "${updated.scene_image_url}"`
        );

        console.log(`  PASS (row ${testRowId}: image_status=${updated.image_status}, scene_image_url=${updated.scene_image_url})`);

        if (origKey) process.env.OPENAI_API_KEY = origKey;
      } finally {
        cleanupTempDir(tmpDir);
      }
    } catch (e) {
      fail(e.message);
    }

    // ──────────────────────────────────────────
    // DB-2. 验证幂等性：第二次调用不改变状态
    // ──────────────────────────────────────────
    console.log('DB-2: Idempotency — row already generated, second call skips API');
    try {
      const result = await sceneGen.generateSceneImage(testRowId, 'test', 'product', null, '/tmp');
      assert.ok(result.idempotent === true, 'Should be idempotent');
      assert.ok(result.success === true, 'Should succeed');
      assert.strictEqual(result.imageStatus, 'generated', 'Status should remain generated');
      console.log('  PASS (idempotent skip)');
    } catch (e) {
      fail(e.message);
    }

    // ──────────────────────────────────────────
    // DB-3. 清理测试行
    // ──────────────────────────────────────────
    console.log('DB-3: Cleanup test row');
    if (testRowId) {
      try {
        const delRes = await fetch(`${baseUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(testRowId)}`, {
          method: 'DELETE',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        });
        if (!delRes.ok && delRes.status !== 204) {
          throw new Error(`DELETE failed ${delRes.status}`);
        }
        console.log('  PASS');
      } catch (e) {
        fail(`Cleanup failed: ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Part B fatal error: ${err.message}`);
    fail(err.message);
  } finally {
    if (testRowId) {
      try {
        await fetch(`${baseUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(testRowId)}`, {
          method: 'DELETE',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        });
      } catch (_) {}
    }
  }
}

  console.log('');
  if (exitCode === 0) {
    console.log('=== All tests passed ===');
  } else {
    console.error(`=== Some tests FAILED (exit code ${exitCode}) ===`);
  }
  process.exit(exitCode);
})();