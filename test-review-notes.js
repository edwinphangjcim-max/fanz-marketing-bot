const assert = require('assert');
const { buildCopywritingPrompt } = require('./lib/copywriting');
const { buildRejectPayload, decideMessageIntent } = require('./index');

let passed = 0;
let failed = 0;

function ok(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// 1. No reviewNotes — no REVISION CONTEXT
const p1 = buildCopywritingPrompt('Test Topic', 'product');
ok(!p1.includes('REVISION CONTEXT'), 'no reviewNotes → no REVISION CONTEXT');

// 2. With reviewNotes — contains both header and notes
const p2 = buildCopywritingPrompt('Test Topic', 'product', 'Make it shorter and more engaging');
ok(p2.includes('REVISION CONTEXT'), 'with reviewNotes → contains REVISION CONTEXT');
ok(p2.includes('Make it shorter'), 'with reviewNotes → contains the actual note text');

// 3. null reviewNotes — no REVISION CONTEXT
const p3 = buildCopywritingPrompt('Test Topic', 'product', null);
ok(!p3.includes('REVISION CONTEXT'), 'null reviewNotes → no REVISION CONTEXT');

// 4. empty string reviewNotes — no REVISION CONTEXT
const p4 = buildCopywritingPrompt('Test Topic', 'product', '');
ok(!p4.includes('REVISION CONTEXT'), 'empty reviewNotes → no REVISION CONTEXT');

// 5. buildRejectPayload stores review_notes
const payload = buildRejectPayload('fix this');
ok(payload.review_notes === 'fix this', 'buildRejectPayload stores review_notes');

// 6. Prompt with reviewNotes contains instruction text
const p6 = buildCopywritingPrompt('Topic', 'product', 'fix this');
ok(p6.includes('DO NOT simply rephrase'), 'prompt with reviewNotes includes DO NOT simply rephrase');
ok(p6.includes('actively incorporate'), 'prompt with reviewNotes includes actively incorporate feedback');

console.log(`\n${passed}/${passed + failed} assertions passed`);
process.exit(failed > 0 ? 1 : 0);
