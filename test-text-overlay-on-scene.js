// ============================================
// test-text-overlay-on-scene.js — 场景图 + 文字叠加 成品验收
// 用已生成的场景图，叠加 Fanz 真实文案
//
// Run: cd /root/fanz-bots/marketing-bot && node test-text-overlay-on-scene.js
// ============================================
const path = require('path');
const fs = require('fs');
const textOverlay = require('./lib/text-overlay');

const OUTPUT_DIR = '/tmp';

const PRODUCT_TEXTS = {
  title: '开斋节凉爽攻略',
  subtitle: '全屋清凉一夏 · 智能节能新体验',
  selling_point: '10年马达保修 · 马新上门服务 · SIRIM认证',
  cta: '立即咨询 017-707 1366',
  logo_area: 'FANZ',
};

const PROMO_TEXTS = {
  title: '开斋节 RM50 优惠',
  subtitle: '限时促销 · 全系列适用',
  selling_point: '10年马达保修 · SIRIM认证 · 节能静音',
  cta: '立即咨询 017-707 1366',
  logo_area: 'FANZ',
};

async function main() {
  console.log('=== 场景图 + 文字叠加 成品验收 ===\n');

  const tests = [
    { name: 'product', input: '/tmp/test-product.png', output: '/tmp/test-final-product.png', texts: PRODUCT_TEXTS },
    { name: 'promo', input: '/tmp/test-promo.png', output: '/tmp/test-final-promo.png', texts: PROMO_TEXTS },
  ];

  for (const test of tests) {
    console.log('─'.repeat(60));
    console.log(`[${test.name}] ${test.input}`);
    console.log('─'.repeat(60));

    if (!fs.existsSync(test.input)) {
      console.log(`❌ SKIP — input not found: ${test.input}\n`);
      continue;
    }

    const start = Date.now();

    try {
      const result = await textOverlay.applyTextOverlays(
        test.input,
        test.texts,
        test.output
      );

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const stats = fs.statSync(test.output);

      console.log(`✅ SUCCESS`);
      console.log(`   Time: ${elapsed}s`);
      console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB`);
      console.log(`   Elements: ${result.textElements.join(', ')}`);
      console.log(`   Dimensions: ${result.width}x${result.height}`);
      console.log(`   Saved: ${test.output}\n`);
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`❌ FAILED (${elapsed}s)`);
      console.log(`   Error: ${err.message}\n`);
    }
  }

  console.log('='.repeat(60));
  console.log('DONE');
  console.log('='.repeat(60));
}

main();