// ============================================
// content_calendar image sub-workflow state machine + Supabase CRUD
//
// Image states (separate from main status):
//   pending → generating → generated → composited → stored
//              ↑              ↓            ↓
//              +--- failed <--+------------+
//              ↑                           |
//              +---------------------------+
// ============================================

const IMAGE_STATES = [
  'pending', 'generating', 'generated', 'composited', 'stored', 'failed'
];

const IMAGE_TRANSITIONS = {
  pending: ['generating'],
  generating: ['generated', 'failed'],
  generated: ['composited', 'failed'],
  composited: ['stored', 'failed'],
  stored: ['generating', 'failed'],   // regenerate
  failed: ['generating'],              // retry
};

function isValidImageStatus(status) {
  return typeof status === 'string' && IMAGE_STATES.includes(status);
}

function allowedImageTransitions(status) {
  if (!isValidImageStatus(status)) {
    throw new Error(
      `Invalid image status: "${status}". Valid statuses: ${IMAGE_STATES.join(', ')}`
    );
  }
  return IMAGE_TRANSITIONS[status].slice();
}

function transitionImageStatus(current, target) {
  if (!isValidImageStatus(current)) {
    throw new Error(
      `Invalid current image status: "${current}". Valid statuses: ${IMAGE_STATES.join(', ')}`
    );
  }
  if (!isValidImageStatus(target)) {
    throw new Error(
      `Invalid target image status: "${target}". Valid statuses: ${IMAGE_STATES.join(', ')}`
    );
  }
  const allowed = IMAGE_TRANSITIONS[current];
  if (!allowed.includes(target)) {
    throw new Error(
      `Invalid image transition: "${current}" → "${target}". ` +
      `Allowed from "${current}": ${allowed.join(', ')}`
    );
  }
  return target;
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY are required'
    );
  }
  return { url: url.replace(/\/+$/, ''), key };
}

const TABLE = 'content_calendar';
const REQUEST_TIMEOUT_MS = 15_000;

function buildHeaders() {
  const { key } = getSupabaseConfig();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function updateImageRow(id, data, expectedImageStatus) {
  if (!id) throw new Error('updateImageRow: id is required');
  if (expectedImageStatus === undefined || expectedImageStatus === null) {
    throw new Error('updateImageRow: expectedImageStatus is required for TOCTOU guard');
  }

  const { url } = getSupabaseConfig();
  const pathAndQuery = `${TABLE}?id=eq.${encodeURIComponent(id)}&image_status=eq.${encodeURIComponent(expectedImageStatus)}`;
  const fullUrl = `${url}/rest/v1/${pathAndQuery}`;

  // Field whitelist: only allow image-related fields, prevent writing non-image fields (e.g. status)
  const ALLOWED_FIELDS = ['image_status', 'scene_image_url', 'source_product_image', 'image_url'];
  const filteredData = {};
  for (const [key, value] of Object.entries(data)) {
    if (ALLOWED_FIELDS.includes(key)) {
      filteredData[key] = value;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const opts = {
    method: 'PATCH',
    headers: {
      ...buildHeaders(),
      Prefer: 'return=representation',
    },
    body: JSON.stringify(filteredData),
    signal: controller.signal,
  };

  let res;
  try {
    res = await fetch(fullUrl, opts);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Supabase PATCH ${pathAndQuery} failed ${res.status}: ${errText}`
    );
  }

  const text = await res.text();
  if (!text) {
    throw new Error('TOCTOU conflict');
  }

  const result = JSON.parse(text);
  if (!result || (Array.isArray(result) && result.length === 0)) {
    throw new Error('TOCTOU conflict');
  }

  return Array.isArray(result) ? result[0] : result;
}

async function resetImageStatus(id) {
  const { getContentCalendar } = require('./supabase');
  const current = await getContentCalendar(id);
  if (!current) {
    throw new Error(`resetImageStatus: row ${id} not found`);
  }
  // Validate transition is legal
  transitionImageStatus(current.image_status, 'generating');
  // Persist — TOCTOU guard uses current.image_status
  return updateImageRow(id, { image_status: 'generating' }, current.image_status);
}

module.exports = {
  IMAGE_STATES,
  IMAGE_TRANSITIONS,
  isValidImageStatus,
  allowedImageTransitions,
  transitionImageStatus,
  getSupabaseConfig,
  updateImageRow,
  resetImageStatus,
};