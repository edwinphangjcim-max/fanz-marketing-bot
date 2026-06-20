// ============================================
// Supabase REST client for content_calendar
//
// Uses service_role key (full read/write) via the PostgREST endpoint.
// No SDK — plain fetch only.
// ============================================

const { transition, isValidStatus } = require('./state-machine');

const TABLE = 'content_calendar';
const INITIAL_STATUS = 'draft';

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY are required'
    );
  }
  return { url: url.replace(/\/+$/, ''), key };
}

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

function buildHeaders(prefer) {
  const { key } = getConfig();
  const h = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

async function request(method, pathAndQuery, body, prefer) {
  const { url } = getConfig();
  const fullUrl = `${url}/rest/v1/${pathAndQuery}`;
  const opts = {
    method,
    headers: buildHeaders(prefer),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(fullUrl, opts);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Supabase ${method} ${pathAndQuery} failed ${res.status}: ${errText}`
    );
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

// ============================================
// CRUD
// ============================================

async function createContentCalendar(data) {
  if (data && data.status !== undefined && data.status !== INITIAL_STATUS) {
    // Anything other than the default initial state must be a legal first-hop from draft.
    transition(INITIAL_STATUS, data.status);
  }
  const result = await request(
    'POST',
    TABLE,
    data,
    'return=representation'
  );
  return Array.isArray(result) ? result[0] : result;
}

async function getContentCalendar(id) {
  if (!id) throw new Error('getContentCalendar: id is required');
  const result = await request(
    'GET',
    `${TABLE}?id=eq.${encodeURIComponent(id)}&limit=1`
  );
  if (Array.isArray(result) && result.length > 0) return result[0];
  return null;
}

async function listContentCalendar(filter = {}) {
  const params = new URLSearchParams();
  if (filter.status) {
    if (!isValidStatus(filter.status)) {
      throw new Error(`listContentCalendar: invalid status filter "${filter.status}"`);
    }
    params.set('status', `eq.${filter.status}`);
  }
  if (filter.pillar) params.set('pillar', `eq.${filter.pillar}`);
  if (filter.chat_id) params.set('chat_id', `eq.${filter.chat_id}`);
  params.set('order', filter.order || 'created_at.desc');
  if (filter.limit) params.set('limit', String(filter.limit));
  const query = params.toString();
  const result = await request('GET', `${TABLE}?${query}`);
  return result || [];
}

async function updateContentCalendar(id, data) {
  if (!id) throw new Error('updateContentCalendar: id is required');
  if (data && data.status !== undefined) {
    const current = await getContentCalendar(id);
    if (!current) {
      throw new Error(`updateContentCalendar: row ${id} not found`);
    }
    // Idempotent: same status = no-op, skip PATCH entirely
    if (current.status === data.status) return current;
    transition(current.status, data.status);
    // Append status filter to PATCH for TOCTOU concurrency guard
    const result = await request(
      'PATCH',
      `${TABLE}?id=eq.${encodeURIComponent(id)}&status=eq.${encodeURIComponent(current.status)}`,
      data,
      'return=representation'
    );
    return Array.isArray(result) ? result[0] : result;
  }
  // No status change — regular field update
  const result = await request(
    'PATCH',
    `${TABLE}?id=eq.${encodeURIComponent(id)}`,
    data,
    'return=representation'
  );
  return Array.isArray(result) ? result[0] : result;
}

async function getPendingReview() {
  return listContentCalendar({ status: 'pending_review', order: 'created_at.desc' });
}

module.exports = {
  isConfigured,
  createContentCalendar,
  getContentCalendar,
  listContentCalendar,
  updateContentCalendar,
  getPendingReview,
};
