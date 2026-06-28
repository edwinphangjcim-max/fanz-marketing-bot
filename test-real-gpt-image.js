// ============================================
// test-real-gpt-image.js — GPT Image 2 批量场景生成验收
// 4 pillar: product/case/promo/story
//
// Run: cd /root/fanz-bots/marketing-bot && railway run node test-real-gpt-image.js
// ============================================
const path = require('path');
const fs = require('fs');
const sceneGen = require('./lib/scene-gen');

const PRODUCT_IMAGE = path.join(__dirname, 'assets', 'products', 'fanz-product-test.png');
const OUTPUT_DIR = '/tmp';

const TEST_PILLARS = [
  { pillar: 'product', topic: 'FS Series 563 客厅吊扇' },
  { pillar: 'case', topic: 'Grande L 家庭安装实景' },
  { pillar: 'promo', topic: '开斋节促销优惠' },
  { pillar: 'story', topic: 'AURA 现代家居生活方式' },
];

async function main() {
  console.log('=== GPT Image 2 批量场景生成验收 ===\n');

  if (!fs.existsSync(PRODUCT_IMAGE)) {
    console.error(`ERROR: Product image not found: ${PRODUCT_IMAGE}`);
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not set. Run with: railway run node test-real-gpt-image.js');
    process.exit(1);
  }

  const stats = fs.statSync(PRODUCT_IMAGE);
  console.log(`Product image: ${PRODUCT_IMAGE}`);
  console.log(`Image size: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log(`Quality: medium\n`);

  const results = [];

  for (const test of TEST_PILLARS) {
    const { pillar, topic } = test;

    console.log('─'.repeat(60));
    console.log(`[${pillar}] ${topic}`);
    console.log('─'.repeat(60));

    // Build scene prompt
    const prompt = sceneGen.buildScenePrompt(pillar, topic);
    console.log(`Prompt: ${prompt}\n`);

    const start = Date.now();

    try {
      const result = await sceneGen.callGptImage2(prompt, PRODUCT_IMAGE);

      if (result.dryRun) {
        console.log(`RESULT: DRY RUN (placeholder) — OPENAI_API_KEY not detected\n`);
        results.push({ pillar, topic, status: 'DRYRUN', elapsed: 0 });
        continue;
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const ext = result.mimeType === 'image/png' ? '.png' : '.jpg';
      const outputPath = path.join(OUTPUT_DIR, `test-${pillar}${ext}`);
      fs.writeFileSync(outputPath, result.data);

      console.log(`RESULT: SUCCESS`);
      console.log(`Time: ${elapsed}s`);
      console.log(`Size: ${(result.data.length / 1024).toFixed(1)} KB`);
      console.log(`Saved: ${outputPath}\n`);

      results.push({ pillar, topic, status: 'SUCCESS', elapsed, path: outputPath });
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`RESULT: FAILED`);
      console.log(`Time: ${elapsed}s`);
      console.log(`Error: ${err.message}\n`);

      results.push({ pillar, topic, status: 'FAILED', elapsed, error: err.message });
    }
  }

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  let success = 0;
  let failed = 0;
  let dryrun = 0;

  for (const r of results) {
    const icon = r.status === 'SUCCESS' ? '✅' : r.status === 'DRYRUN' ? '⚠️' : '❌';
    const time = r.elapsed ? `${r.elapsed}s` : '-';
    console.log(`${icon} [${r.pillar}] ${r.status} (${time})${r.error ? ': ' + r.error.slice(0, 100) : ''}`);
    if (r.status === 'SUCCESS') success++;
    else if (r.status === 'FAILED') failed++;
    else dryrun++;
  }

  console.log(`\nTotal: ${results.length} | ✅ ${success} | ❌ ${failed} | ⚠️ ${dryrun}`);

  // Write results marker
  fs.writeFileSync('/tmp/gpt-image2-batch-result.txt',
    results.map(r => `${r.pillar}|${r.status}|${r.elapsed || '-'}|${r.path || ''}|${r.error || ''}`).join('\n'));

  process.exit(failed > 0 ? 1 : 0);
}

main();