// ============================================
// seed-brand-kit.mjs — 一次性：把占位 logo 传云 + 填 brand_kit 默认
//
// 只灌 brand_kit（色板/声音/背景风格/默认版式）和占位 logo，
// 不灌产品——Edwin 要用 Dashboard UI 亲手传真实产品图做测试，
// 灌进占位产品反而碍事。产品库为空时管线回退到 assets/products/。
//
// 幂等：logo 按固定 storage 路径 upsert；brand_kit 单行 update。
// 运行：source .env && node scripts/seed-brand-kit.mjs
// ============================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = 'content-images';

if (!SUPABASE_URL || !KEY) {
  console.error('need SUPABASE_URL + SUPABASE_SERVICE_KEY (source .env)');
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function uploadToStorage(localPath, storagePath, contentType) {
  const bytes = fs.readFileSync(localPath);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`upload ${storagePath} failed ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

async function rest(method, pathAndQuery, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { ...H, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} failed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

(async () => {
  // 1) 占位 logo 传云 + 入 brand_assets（幂等：先查同名，有则复用）
  const logoLocal = path.join(ROOT, 'assets', 'brand', 'fanz-logo.png');
  const logoUrl = await uploadToStorage(logoLocal, 'brand-assets/logo/fanz-logo-placeholder.png', 'image/png');
  console.log('logo uploaded:', logoUrl);

  const existing = await rest('GET', `brand_assets?kind=eq.logo&name=eq.${encodeURIComponent('Fanz Logo (placeholder)')}&select=id&limit=1`);
  let logoId;
  if (Array.isArray(existing) && existing[0]) {
    logoId = existing[0].id;
    await rest('PATCH', `brand_assets?id=eq.${logoId}`, { public_url: logoUrl, storage_path: 'brand-assets/logo/fanz-logo-placeholder.png' });
    console.log('logo asset updated:', logoId);
  } else {
    const ins = await rest('POST', 'brand_assets', {
      kind: 'logo',
      name: 'Fanz Logo (placeholder)',
      storage_path: 'brand-assets/logo/fanz-logo-placeholder.png',
      public_url: logoUrl,
      has_transparency: true,
      is_active: true,
      metadata: { placeholder: true, note: 'replace with official transparent Fanz logo' },
    }, 'return=representation');
    logoId = ins[0].id;
    console.log('logo asset inserted:', logoId);
  }

  // 2) brand_kit 默认值（只填空字段，不覆盖 Edwin 已改的）
  const kitRows = await rest('GET', 'brand_kit?id=eq.1&select=*&limit=1');
  const kit = (Array.isArray(kitRows) && kitRows[0]) || {};
  const patch = {};
  if (!kit.logo_asset_id) patch.logo_asset_id = logoId;
  if (!kit.colors || Object.keys(kit.colors).length === 0) {
    patch.colors = { title: '#FFFFFF', stroke: '#1A1A1A', cta_fill: '#FFD700', cta_stroke: '#1A1A1A' };
  }
  if (!kit.background_style) {
    patch.background_style =
      'bright, airy, modern Malaysian home interior; natural daylight; warm, clean, aspirational lifestyle aesthetic; uncluttered composition';
  }
  if (!kit.brand_voice) {
    patch.brand_voice =
      'Warm, knowledgeable and down-to-earth — like a helpful friend who knows fans. Confident but never pushy or salesy. Malaysia/Singapore English.';
  }
  if (!kit.default_layout || Object.keys(kit.default_layout).length === 0) {
    patch.default_layout = { title_slot: 'bottom_center', product_slot: 'top_center' };
  }

  if (Object.keys(patch).length) {
    await rest('PATCH', 'brand_kit?id=eq.1', patch);
    console.log('brand_kit seeded:', Object.keys(patch).join(', '));
  } else {
    console.log('brand_kit already configured — nothing overwritten');
  }

  const products = await rest('GET', 'brand_assets?kind=eq.product&select=id');
  console.log(`\nproduct library: ${Array.isArray(products) ? products.length : 0} products (empty is expected — upload via Dashboard /brand)`);
  console.log('done.');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
