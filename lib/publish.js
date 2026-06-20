// ============================================
// Publish node — core publish module
//
// DRY_RUN controls whether actual Meta API calls
// are made. Default true (safe — won't actually post).
// ============================================

const DRY_RUN = process.env.DRYRUN !== 'false'; // default true (safe, won't actually send)

/**
 * Assemble publish payload from a content_calendar row
 * All real logic: combines fb_content/ig_content/hashtags into publish structure
 */
function assemblePostPayload(row) {
  return {
    topic: row.topic,
    pillar: row.pillar,
    facebook: { message: row.fb_content || '' },
    instagram: { caption: row.ig_content || '', hashtags: row.hashtags || '' },
    hashtags: row.hashtags,
  };
}

/**
 * Validate payload integrity
 * All real: checks three fields non-empty, no placeholders
 */
function validatePublishPayload(payload) {
  const errors = [];
  if (!payload.facebook.message.trim()) errors.push('Facebook content is empty');
  if (!payload.instagram.caption.trim()) errors.push('Instagram caption is empty');
  if (!payload.instagram.hashtags.trim()) errors.push('Hashtags are empty');

  // Check for placeholders
  const allText = [payload.facebook.message, payload.instagram.caption, payload.instagram.hashtags].join(' ');
  if (/{{|}}|TODO|lorem|ipsum/i.test(allText)) {
    errors.push('Publish payload contains placeholder text');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Execute publish
 * - DRY_RUN=true (default): only simulate, return DRYRUN- prefixed post_id
 * - DRY_RUN=false: call real Meta API (currently throws not-implemented error)
 *
 * dry-run is limited to this one step
 */
async function publishToSocial(row) {
  const payload = assemblePostPayload(row);
  const validation = validatePublishPayload(payload);
  if (!validation.valid) {
    throw new Error(`Cannot publish: ${validation.errors.join('; ')}`);
  }

  if (DRY_RUN) {
    return {
      post_id: `DRYRUN-${Date.now()}`,
      fb_post_id: null,
      ig_post_id: null,
      dry_run: true,
      payload,
    };
  }

  // Real Meta API call — not yet connected, implement after credentials configured
  throw new Error('Real Meta API publish not yet configured. Set DRYRUN=true or configure Meta credentials.');
}

module.exports = {
  assemblePostPayload,
  validatePublishPayload,
  publishToSocial,
  DRY_RUN,
};