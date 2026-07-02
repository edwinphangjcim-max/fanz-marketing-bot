// ============================================
// store-image.js — 成品图存储 [I-4]
//
// 流水线：本地成品图 → Supabase Storage → 公开 URL → content_calendar.image_url
//
// 红线：上传失败明确报错不静默
// 幂等：已写入 image_url 的 row 不重复上传
// ============================================

const fs = require('fs');
const path = require('path');

const BUCKET = 'content-images';
const SUPABASE_TIMEOUT_MS = 30_000;

// ============================================
// Config helpers
// ============================================

function getStorageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY are required'
    );
  }
  return {
    baseUrl: url.replace(/\/+$/, ''),
    key,
  };
}

// ============================================
// Upload to Supabase Storage
// ============================================

/**
 * Upload a local file to Supabase Storage bucket.
 *
 * @param {string} localPath - Absolute path to the local file
 * @param {string} storagePath - Path within the bucket (e.g. '2026/06/final-image.png')
 * @returns {Promise<{path: string, publicUrl: string}>}
 */
async function uploadFile(localPath, storagePath) {
  if (!localPath || !fs.existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`);
  }

  const { baseUrl, key } = getStorageConfig();
  const fileBuffer = fs.readFileSync(localPath);
  const contentType = guessMimeType(localPath);

  const uploadUrl = `${baseUrl}/storage/v1/object/${BUCKET}/${storagePath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': contentType,
      },
      body: fileBuffer,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Supabase Storage upload failed (${response.status}): ${errText.slice(0, 200)}`
    );
  }

  const publicUrl = `${baseUrl}/storage/v1/object/public/${BUCKET}/${storagePath}`;

  return {
    path: storagePath,
    publicUrl,
  };
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// ============================================
// Build storage path from row data
// ============================================

/**
 * Build a unique storage path for a final image.
 * Format: {Y}/{M}/{D}/{rowId-short}-{ts}.png
 *
 * The path was previously deterministic per row per day, which made any
 * same-day regeneration fail with 409 Duplicate on upload (and an upsert
 * would serve a stale public URL from CDN cache). Timestamp suffix keeps
 * every upload unique; content_calendar.image_url always points at the
 * latest one.
 */
function buildStoragePath(rowId, extension) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const shortId = rowId ? rowId.replace(/-/g, '').slice(0, 12) : 'unknown';
  const ext = extension || '.png';
  return `${y}/${m}/${d}/${shortId}-${Date.now()}${ext}`;
}

// ============================================
// Orchestrator — store final image
// ============================================

/**
 * Store a final composited image (scene + text) to Supabase Storage
 * and write the public URL back to content_calendar.image_url.
 *
 * Idempotent: if row already has image_url, skips upload.
 *
 * @param {string} rowId - content_calendar row UUID
 * @param {string} localPath - path to the final image file
 * @returns {Promise<{success: boolean, imageUrl?: string, idempotent?: boolean, error?: string}>}
 */
async function storeFinalImage(rowId, localPath) {
  const { updateContentCalendar } = require('./supabase');

  try {
    // Step 0: Read current row to check idempotency
    let row;

    // Use direct fetch to check current state
    const { baseUrl, key } = getStorageConfig();
    const readUrl = `${baseUrl}/rest/v1/content_calendar?id=eq.${encodeURIComponent(rowId)}&select=id,image_url&limit=1`;

    let readRes;
    const readController = new AbortController();
    const readTimer = setTimeout(() => readController.abort(), 15_000);
    try {
      readRes = await fetch(readUrl, {
        signal: readController.signal,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
      });
    } finally {
      clearTimeout(readTimer);
    }

    if (readRes.ok) {
      const rows = await readRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        row = rows[0];
      }
    }

    // Idempotency: skip if image_url already set
    if (row && row.image_url && row.image_url.trim().length > 0) {
      return {
        success: true,
        imageUrl: row.image_url,
        idempotent: true,
      };
    }

    // Step 1: Read the local file
    if (!localPath || !fs.existsSync(localPath)) {
      throw new Error(`Final image file not found: ${localPath}`);
    }

    // Step 2: Determine file extension
    const ext = path.extname(localPath).toLowerCase() || '.png';

    // Step 3: Build storage path
    const storagePath = buildStoragePath(rowId, ext);

    // Step 4: Upload to Supabase Storage
    const { publicUrl } = await uploadFile(localPath, storagePath);

    // Step 5: Verify the uploaded URL is accessible
    const verifyController = new AbortController();
    const verifyTimer = setTimeout(() => verifyController.abort(), SUPABASE_TIMEOUT_MS);
    let verifyRes;
    try {
      verifyRes = await fetch(publicUrl, {
        method: 'HEAD',
        signal: verifyController.signal,
      });
    } finally {
      clearTimeout(verifyTimer);
    }
    if (!verifyRes.ok) {
      throw new Error(
        `Uploaded file not accessible: ${publicUrl} returned HTTP ${verifyRes.status}`
      );
    }

    // Step 6: Write URL back to content_calendar
    const updateData = { image_url: publicUrl };
    await updateContentCalendar(rowId, updateData);

    return {
      success: true,
      imageUrl: publicUrl,
      idempotent: false,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  uploadFile,
  buildStoragePath,
  storeFinalImage,
  guessMimeType,
  BUCKET,
};