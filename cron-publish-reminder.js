#!/usr/bin/env node
// ============================================
// cron-publish-reminder.js — M-7 Cron Reminder
//
// Queries content_calendar for today's posts where
// publish_reminder_sent=false and sends Telegram notifications.
//
// Can be run:
//   - As a cron job: node cron-publish-reminder.js
//   - Called programmatically: checkTodayPosts(chatId)
// ============================================

const supabase = require('./lib/supabase');

// ============================================
// Helpers
// ============================================

/** Get today's date as YYYY-MM-DD in Malaysia timezone (UTC+8) */
function getMalaysiaDateStr() {
  const now = new Date();
  const ms = now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000;
  const myt = new Date(ms);
  const y = myt.getUTCFullYear();
  const m = String(myt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(myt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Get tomorrow's date as YYYY-MM-DD in Malaysia timezone */
function getMalaysiaTomorrowStr() {
  const now = new Date();
  const ms = now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000;
  const myt = new Date(ms);
  myt.setUTCDate(myt.getUTCDate() + 1);
  const y = myt.getUTCFullYear();
  const m = String(myt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(myt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build the reminder message for a single post.
 */
function buildReminderMessage(row) {
  const content = row.ig_content || row.fb_content || '(no content)';
  const hashtags = row.hashtags || '';
  const imageUrl = row.image_url || null;

  let msg = `📢 *Today's post ready to publish!*\n\n`;
  msg += `*Topic:* ${row.topic || '(untitled)'}\n`;
  msg += `*Pillar:* ${row.pillar || '-'}\n\n`;
  msg += `*Content:*\n${content}\n\n`;

  if (hashtags) {
    msg += `*Hashtags:*\n${hashtags}\n\n`;
  }

  if (imageUrl) {
    msg += `*Image:* ${imageUrl}\n\n`;
  }

  msg += `📌 *Please post to Facebook/Instagram manually.*`;

  return { text: msg, imageUrl };
}

/**
 * Query content_calendar for today's posts where publish_reminder_sent=false.
 *
 * Uses raw fetch to query scheduled_date >= today AND scheduled_date < tomorrow.
 *
 * @returns {Promise<Array>} Array of content_calendar rows
 */
async function queryTodayPosts() {
  if (!supabase.isConfigured()) {
    console.warn('Supabase not configured — cannot query today posts');
    return [];
  }

  const today = getMalaysiaDateStr();
  const tomorrow = getMalaysiaTomorrowStr();

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Build query: scheduled_date >= today AND scheduled_date < tomorrow AND publish_reminder_sent=false
  // scheduled_date is timestamptz, so we compare against MYT date range.
  // status=neq.published — a post already marked published needs no reminder.
  const query = `content_calendar?scheduled_date=gte.${today}T00:00:00%2B08:00&scheduled_date=lt.${tomorrow}T00:00:00%2B08:00&publish_reminder_sent=is.false&status=neq.published&order=scheduled_date.asc`;

  const response = await fetch(`${supabaseUrl}/rest/v1/${query}`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`queryTodayPosts failed ${response.status}: ${errText}`);
  }

  const result = await response.json();
  return Array.isArray(result) ? result : [];
}

/**
 * Mark a post as having its reminder sent.
 */
async function markReminderSent(rowId) {
  await supabase.updateContentCalendar(rowId, { publish_reminder_sent: true });
}

/**
 * Send reminder for all today's posts.
 *
 * Target chat resolution: explicit chatId argument wins; otherwise each
 * row's own chat_id is used (rows created via the bot always carry it).
 *
 * IMPORTANT: publish_reminder_sent is only marked after a reminder was
 * actually DELIVERED. Running without a send function (or without any
 * resolvable chat) logs the pending posts but does NOT consume them —
 * otherwise a log-only run would silently swallow reminders forever.
 *
 * @param {Function|null} sendMessageFn - Async function (chatId, text, opts)
 * @param {Function|null} sendPhotoFn - Async function (chatId, url, opts)
 * @param {number|string|null} chatId - Telegram chat ID override (null = use row.chat_id)
 * @returns {Promise<{sent: number, failed: number, skipped: number}>}
 */
async function checkTodayPosts(sendMessageFn, sendPhotoFn, chatId) {
  const rows = await queryTodayPosts();
  console.log(`[cron-reminder] Found ${rows.length} today's posts pending reminder`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const { text, imageUrl } = buildReminderMessage(row);
      const targetChat = chatId || row.chat_id;

      if (!sendMessageFn || !targetChat) {
        // Log-only mode (no bot, or row has no chat) — do NOT mark as sent,
        // the reminder must fire again when a real sender is available.
        console.log(`[cron-reminder] Pending (not delivered): ${row.topic}`);
        console.log(`  Content: ${(row.fb_content || row.ig_content || '').slice(0, 120)}`);
        console.log(`  Image: ${row.image_url || 'none'}`);
        skipped++;
        continue;
      }

      // Inline "Mark as Published" button. callback_data is 'mp:' + uuid
      // = 39 bytes, well under Telegram's 64-byte limit.
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Mark as Published', callback_data: `mp:${row.id}` }],
          ],
        },
      };

      if (imageUrl && sendPhotoFn) {
        // Send as photo with caption if image is available
        try {
          await sendPhotoFn(targetChat, imageUrl, { caption: text, ...opts });
        } catch (photoErr) {
          console.warn(`[cron-reminder] sendPhoto failed for ${row.id}, falling back to text:`, photoErr.message);
          await sendMessageFn(targetChat, text, opts);
        }
      } else {
        await sendMessageFn(targetChat, text, opts);
      }

      await markReminderSent(row.id);
      sent++;
      console.log(`[cron-reminder] Reminder sent for row ${row.id}: "${row.topic}"`);
    } catch (err) {
      console.error(`[cron-reminder] Failed to send reminder for row ${row.id}:`, err.message);
      failed++;
    }
  }

  return { sent, failed, skipped };
}

// ============================================
// Standalone run
// ============================================

if (require.main === module) {
  (async () => {
    console.log(`[cron-reminder] Running at ${new Date().toISOString()}`);
    try {
      const result = await checkTodayPosts(null, null, null);
      console.log(`[cron-reminder] Done: ${result.sent} sent, ${result.failed} failed, ${result.skipped} pending (log-only run, not consumed)`);
      if (result.failed > 0) process.exit(1);
    } catch (err) {
      console.error('[cron-reminder] Fatal error:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  getMalaysiaDateStr,
  getMalaysiaTomorrowStr,
  queryTodayPosts,
  markReminderSent,
  buildReminderMessage,
  checkTodayPosts,
};