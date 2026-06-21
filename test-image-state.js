const assert = require('assert');
const {
  IMAGE_STATES,
  IMAGE_TRANSITIONS,
  isValidImageStatus,
  allowedImageTransitions,
  transitionImageStatus,
  updateImageRow,
  resetImageStatus,
  getSupabaseConfig,
} = require('./lib/image-state');

let failures = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${label}: ${err.message}`);
  }
}

// ============================================
// Main
// ============================================
(async function main() {
  console.log('\nPart A: State machine pure functions\n');

  // 1. isValidImageStatus('pending') === true
  await test('isValidImageStatus("pending") === true', () => {
    assert.strictEqual(isValidImageStatus('pending'), true);
  });

  // 2. isValidImageStatus('invalid_status') === false
  await test('isValidImageStatus("invalid_status") === false', () => {
    assert.strictEqual(isValidImageStatus('invalid_status'), false);
  });

  // 3. allowedImageTransitions('pending') → ['generating']
  await test('allowedImageTransitions("pending") → ["generating"]', () => {
    assert.deepStrictEqual(allowedImageTransitions('pending'), ['generating']);
  });

  // 4. allowedImageTransitions('stored') → ['generating', 'failed']
  await test('allowedImageTransitions("stored") → ["generating", "failed"]', () => {
    const actual = allowedImageTransitions('stored');
    assert.ok(actual.includes('generating'));
    assert.ok(actual.includes('failed'));
  });

  // 5. allowedImageTransitions('failed') → ['generating']
  await test('allowedImageTransitions("failed") → ["generating"]', () => {
    assert.deepStrictEqual(allowedImageTransitions('failed'), ['generating']);
  });

  // 6. transitionImageStatus('pending', 'generating') → 'generating'
  await test('transitionImageStatus("pending", "generating") → "generating"', () => {
    assert.strictEqual(transitionImageStatus('pending', 'generating'), 'generating');
  });

  // 7. transitionImageStatus('pending', 'stored') throws Error (skip)
  await test('transitionImageStatus("pending", "stored") throws Error', () => {
    assert.throws(() => transitionImageStatus('pending', 'stored'), Error);
  });

  // 8. transitionImageStatus('generated', 'composited') → 'composited'
  await test('transitionImageStatus("generated", "composited") → "composited"', () => {
    assert.strictEqual(transitionImageStatus('generated', 'composited'), 'composited');
  });

  // 9. transitionImageStatus('generated', 'failed') → 'failed'
  await test('transitionImageStatus("generated", "failed") → "failed"', () => {
    assert.strictEqual(transitionImageStatus('generated', 'failed'), 'failed');
  });

  // 10. transitionImageStatus('stored', 'generating') → 'generating' (regenerate)
  await test('transitionImageStatus("stored", "generating") → "generating"', () => {
    assert.strictEqual(transitionImageStatus('stored', 'generating'), 'generating');
  });

  // 11. transitionImageStatus('stored', 'pending') throws Error (invalid rollback)
  await test('transitionImageStatus("stored", "pending") throws Error', () => {
    assert.throws(() => transitionImageStatus('stored', 'pending'), Error);
  });

  // 12. Every state can reach 'failed' via valid transitions
  await test('Every state can reach "failed" via valid transitions', () => {
    for (const state of IMAGE_STATES) {
      if (state === 'failed') continue;
      const allowed = allowedImageTransitions(state);
      // Direct transition or multi-hop
      if (!allowed.includes('failed')) {
        // Check if any single hop leads to a state that can reach failed
        let canReach = false;
        for (const hop of allowed) {
          if (allowedImageTransitions(hop).includes('failed')) {
            canReach = true;
            break;
          }
        }
        assert.ok(canReach, `State "${state}" cannot reach "failed"`);
      }
    }
  });

  // 13. IMAGE_STATES JSON matches DB CHECK constraint
  await test('IMAGE_STATES JSON matches DB CHECK constraint', () => {
    assert.strictEqual(
      JSON.stringify(IMAGE_STATES),
      '["pending","generating","generated","composited","stored","failed"]'
    );
  });

  // 14. allowedImageTransitions('bogus') throws Error
  await test('allowedImageTransitions("bogus") throws Error', () => {
    assert.throws(() => allowedImageTransitions('bogus'), Error);
  });

  // 15. transitionImageStatus('generating', 'generated') → 'generated'
  await test('transitionImageStatus("generating", "generated") → "generated"', () => {
    assert.strictEqual(transitionImageStatus('generating', 'generated'), 'generated');
  });

  // 16. transitionImageStatus('generating', 'failed') → 'failed'
  await test('transitionImageStatus("generating", "failed") → "failed"', () => {
    assert.strictEqual(transitionImageStatus('generating', 'failed'), 'failed');
  });

  // 17. transitionImageStatus('composited', 'stored') → 'stored'
  await test('transitionImageStatus("composited", "stored") → "stored"', () => {
    assert.strictEqual(transitionImageStatus('composited', 'stored'), 'stored');
  });

  // 18. transitionImageStatus('composited', 'failed') → 'failed'
  await test('transitionImageStatus("composited", "failed") → "failed"', () => {
    assert.strictEqual(transitionImageStatus('composited', 'failed'), 'failed');
  });

  // 19. transitionImageStatus('failed', 'generating') → 'generating' (retry)
  await test('transitionImageStatus("failed", "generating") → "generating"', () => {
    assert.strictEqual(transitionImageStatus('failed', 'generating'), 'generating');
  });

  // ============================================
  // Part B — DB integration tests
  // ============================================
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.log('\nPart B: Skipping (no DB — SUPABASE_URL or SUPABASE_SERVICE_KEY missing)');
    if (failures > 0) {
      console.log(`\n${failures} test(s) FAILED`);
      process.exit(1);
    }
    console.log('\nAll tests passed.');
    process.exit(0);
  }

  console.log('\nPart B: DB integration tests\n');

  const { getContentCalendar } = require('./lib/supabase');
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const TABLE = 'content_calendar';

  let testRowId = null;

  try {
    // 20. Create a test row via REST API
    console.log('  Creating test row...');

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
        topic: 'test',
        chat_id: 'test-image-state',
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create test row: ${createRes.status} ${errText}`);
    }

    const createData = await createRes.json();
    const created = Array.isArray(createData) ? createData[0] : createData;
    testRowId = created.id;

    await test('Test row created with image_status="pending"', () => {
      assert.strictEqual(created.image_status, 'pending');
    });

    // 21. updateImageRow to set scene_image_url and image_status='generated'
    await test('updateImageRow sets scene_image_url and image_status="generated"', async () => {
      const updated = await updateImageRow(
        testRowId,
        {
          image_status: 'generated',
          scene_image_url: 'https://example.com/test-scene.png',
        },
        'pending'
      );
      assert.strictEqual(updated.image_status, 'generated');
      assert.strictEqual(updated.scene_image_url, 'https://example.com/test-scene.png');
    });

    // 22. TOCTOU conflict test: wrong expectedImageStatus should throw
    await test('TOCTOU conflict with wrong expectedImageStatus throws Error', async () => {
      try {
        await updateImageRow(
          testRowId,
          { image_status: 'composited' },
          'pending' // wrong — current is 'generated'
        );
        assert.fail('Should have thrown TOCTOU conflict error');
      } catch (err) {
        assert.ok(
          err.message.includes('TOCTOU') || err.message.includes('conflict'),
          `Expected TOCTOU conflict error, got: "${err.message}"`
        );
      }
    });

    // 23. resetImageStatus test
    let resetRowId = null;
    try {
      const createResetRes = await fetch(`${baseUrl}/rest/v1/${TABLE}`, {
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
          topic: 'test-reset',
          chat_id: 'test-image-state',
        }),
      });
      if (!createResetRes.ok) {
        const errText = await createResetRes.text();
        throw new Error(`Failed to create reset test row: ${createResetRes.status} ${errText}`);
      }
      const createResetData = await createResetRes.json();
      const resetRow = Array.isArray(createResetData) ? createResetData[0] : createResetData;
      resetRowId = resetRow.id;

// First transition to generating
      await updateImageRow(resetRowId, { image_status: 'generating' }, 'pending');
      // Then to generated
      await updateImageRow(resetRowId, { image_status: 'generated', scene_image_url: 'http://test.img' }, 'generating');
      // Then to composited
      await updateImageRow(resetRowId, { image_status: 'composited' }, 'generated');
      // Then to stored (from stored, can regenerate)
      await updateImageRow(resetRowId, { image_status: 'stored' }, 'composited');
      // reset — should go from stored → generating
      await test('resetImageStatus: stored → generating', async () => {
        const resetResult = await resetImageStatus(resetRowId);
        assert.strictEqual(resetResult.image_status, 'generating');
      });
    } finally {
      if (resetRowId) {
        try {
          await fetch(`${baseUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(resetRowId)}`, {
            method: 'DELETE',
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
            },
          });
        } catch (_) {}
      }
    }

    // 24. Cleanup: delete the test row
    await test('Cleanup test row', async () => {
      const deleteRes = await fetch(
        `${baseUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(testRowId)}`,
        {
          method: 'DELETE',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        }
      );
      if (!deleteRes.ok && deleteRes.status !== 204) {
        throw new Error(`Failed to delete test row: ${deleteRes.status}`);
      }
      // Verify it's gone
      const deleted = await getContentCalendar(testRowId);
      assert.strictEqual(deleted, null);
    });

  } catch (err) {
    console.error(`\n❌ Part B fatal error: ${err.message}`);
    failures++;
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

  if (failures > 0) {
    console.log(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll tests passed.');
  process.exit(0);
})();
