#!/usr/bin/env node
// ============================================
// Publish module tests (lib/publish.js)
//
// Tests all functions with real production code.
// No mocks, no fake data that bypasses real logic.
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

function assertStartsWith(actual, prefix, name) {
  if (typeof actual === 'string' && actual.startsWith(prefix)) {
    pass(name);
  } else {
    fail(name, new Error(`expected "${actual}" to start with "${prefix}"`));
  }
}

function assertDeepEqual(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass(name);
  } else {
    fail(name, new Error(`expected ${e}, got ${a}`));
  }
}

// ============================================
// Load production module
// ============================================
const publishPath = path.join(__dirname, 'lib', 'publish.js');
let publish;
try {
  publish = require(publishPath);
  pass('lib/publish.js loads');
} catch (err) {
  fail('lib/publish.js loads', err);
  process.exit(1);
}

const { assemblePostPayload, validatePublishPayload, publishToSocial, DRY_RUN } = publish;

// ============================================
// Test 1: assemblePostPayload returns correct structure
// ============================================
console.log('\n--- assemblePostPayload ---');

const row = {
  topic: 'Summer Fan Sale',
  pillar: 'promo',
  fb_content: 'Check out our summer sale!',
  ig_content: 'Summer vibes with Fanz!',
  hashtags: '#Fanz #SummerSale',
};

const payload = assemblePostPayload(row);
assert(typeof payload === 'object', '1a. assemblePostPayload returns an object');
assert(payload.topic === 'Summer Fan Sale', '1b. payload.topic matches');
assert(payload.pillar === 'promo', '1c. payload.pillar matches');
assert(payload.facebook.message === 'Check out our summer sale!', '1d. payload.facebook.message matches');
assert(payload.instagram.caption === 'Summer vibes with Fanz!', '1e. payload.instagram.caption matches');
assert(payload.hashtags === '#Fanz #SummerSale', '1f. payload.hashtags matches');
assert(payload.instagram.hashtags === '#Fanz #SummerSale', '1g. payload.instagram.hashtags matches');

// ============================================
// Test 2: assemblePostPayload handles missing fields
// ============================================
console.log('\n--- assemblePostPayload missing fields ---');

const emptyRow = {};
const payload2 = assemblePostPayload(emptyRow);
assert(payload2.topic === undefined, '2a. missing topic is undefined');
assert(payload2.pillar === undefined, '2b. missing pillar is undefined');
assert(payload2.facebook.message === '', '2c. missing fb_content defaults to empty string');
assert(payload2.instagram.caption === '', '2d. missing ig_content defaults to empty string');
assert(payload2.instagram.hashtags === '', '2e. missing hashtags defaults to empty string');
assert(payload2.hashtags === undefined, '2f. missing hashtags is undefined');

// ============================================
// Test 3: validatePublishPayload passes valid payload
// ============================================
console.log('\n--- validatePublishPayload (valid) ---');

const validPayload = {
  facebook: { message: 'Great product from Fanz!' },
  instagram: { caption: 'Love this fan!', hashtags: '#Fanz #Cool' },
};
const result3 = validatePublishPayload(validPayload);
assert(result3.valid === true, '3a. valid payload passes');
assert(Array.isArray(result3.errors) && result3.errors.length === 0, '3b. no errors for valid payload');

// ============================================
// Test 4: validatePublishPayload rejects empty fb_content
// ============================================
console.log('\n--- validatePublishPayload (empty fb_content) ---');

const emptyFbPayload = {
  facebook: { message: '   ' },
  instagram: { caption: 'Love this fan!', hashtags: '#Fanz #Cool' },
};
const result4 = validatePublishPayload(emptyFbPayload);
assert(result4.valid === false, '4a. empty fb_content is invalid');
assert(result4.errors.some(e => e.includes('Facebook content')), '4b. error mentions Facebook content');

// ============================================
// Test 5: validatePublishPayload rejects empty ig_content
// ============================================
console.log('\n--- validatePublishPayload (empty ig_content) ---');

const emptyIgPayload = {
  facebook: { message: 'Great product!' },
  instagram: { caption: '', hashtags: '#Fanz #Cool' },
};
const result5 = validatePublishPayload(emptyIgPayload);
assert(result5.valid === false, '5a. empty ig_content is invalid');
assert(result5.errors.some(e => e.includes('Instagram caption')), '5b. error mentions Instagram caption');

// ============================================
// Test 6: validatePublishPayload rejects placeholder text
// ============================================
console.log('\n--- validatePublishPayload (placeholder text) ---');

const todoPayload = {
  facebook: { message: 'TODO: write content here' },
  instagram: { caption: 'Love this fan!', hashtags: '#Fanz #Cool' },
};
const result6 = validatePublishPayload(todoPayload);
assert(result6.valid === false, '6a. TODO placeholder is rejected');
assert(result6.errors.some(e => e.includes('placeholder')), '6b. error mentions placeholder');

// Also test with {{placeholder}}
const curlyPayload = {
  facebook: { message: 'Check out {{product_name}}' },
  instagram: { caption: 'Love this fan!', hashtags: '#Fanz #Cool' },
};
const result6b = validatePublishPayload(curlyPayload);
assert(result6b.valid === false, '6c. {{}} placeholder is rejected');

// Also test with lorem ipsum
const loremPayload = {
  facebook: { message: 'Lorem ipsum dolor sit amet' },
  instagram: { caption: 'Love this fan!', hashtags: '#Fanz #Cool' },
};
const result6c = validatePublishPayload(loremPayload);
assert(result6c.valid === false, '6d. lorem ipsum placeholder is rejected');

// ============================================
// Test 7: publishToSocial returns DRYRUN- post_id
// ============================================
console.log('\n--- publishToSocial (dry-run) ---');

const publishRow = {
  topic: 'Test',
  pillar: 'product',
  fb_content: 'Test Facebook content for publish',
  ig_content: 'Test Instagram content for publish',
  hashtags: '#Test #Publish',
};

(async () => {
  try {
    const result = await publishToSocial(publishRow);
    assertStartsWith(result.post_id, 'DRYRUN-', '7a. post_id starts with DRYRUN-');
    assert(result.dry_run === true, '8a. dry_run is true on result');
    assert(typeof result.payload === 'object', '9a. payload is present on result');
    assert(result.payload.facebook.message === 'Test Facebook content for publish', '9b. payload contains fb_content');
    assert(result.payload.instagram.caption === 'Test Instagram content for publish', '9c. payload contains ig_content');
    assert(result.payload.hashtags === '#Test #Publish', '9d. payload contains hashtags');
  } catch (err) {
    fail('publishToSocial dry-run', err);
  }

  // ============================================
  // Test 10: DRY_RUN constant
  // ============================================
  console.log('\n--- DRY_RUN constant ---');
  // Save current env, unset DRYRUN to test default
  const savedDryrun = process.env.DRYRUN;
  delete process.env.DRYRUN;
  
  // Re-require to get fresh default
  delete require.cache[require.resolve(path.join(__dirname, 'lib', 'publish.js'))];
  const publishFresh = require(path.join(__dirname, 'lib', 'publish.js'));
  assert(publishFresh.DRY_RUN === true, '10a. DRY_RUN defaults to true when DRYRUN env not set');

  // Test that DRYRUN=false works
  process.env.DRYRUN = 'false';
  delete require.cache[require.resolve(path.join(__dirname, 'lib', 'publish.js'))];
  const publishFalse = require(path.join(__dirname, 'lib', 'publish.js'));
  assert(publishFalse.DRY_RUN === false, '10b. DRY_RUN is false when DRYRUN=false');

  // Restore
  if (savedDryrun !== undefined) {
    process.env.DRYRUN = savedDryrun;
  } else {
    delete process.env.DRYRUN;
  }

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n========================================');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log('========================================');
  process.exit(failed === 0 ? 0 : 1);
})();