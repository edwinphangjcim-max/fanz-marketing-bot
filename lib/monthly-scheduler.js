// ============================================
// monthly-scheduler.js — M-6 AutoSchedule
//
// Reads approved content_calendar rows for a plan
// and assigns scheduled_date respecting festival
// constraints, weekly balance, and Malaysia evening time.
// ============================================

const supabase = require('./supabase');
const supabasePlans = require('./supabase-plans');
const { FESTIVAL_KEYWORDS } = require('./festival-handler');

// ============================================
// Helpers
// ============================================

/** Parse a YYYY-MM-DD string to [year, month, day] numbers */
function parseDate(dateStr) {
  return dateStr.split('-').map(Number);
}

/** Format [year, month, day] as YYYY-MM-DD */
function formatDateObj(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Format a Date object as YYYY-MM-DD */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Get day of week for a YYYY-MM-DD date.
 * 0=Sun, 1=Mon, ..., 6=Sat.
 * Uses local-timezone Date constructor (which is timezone-agnostic for y,m,d only).
 */
function getDayOfWeek(dateStr) {
  const [y, m, d] = parseDate(dateStr);
  return new Date(y, m - 1, d).getDay();
}

/** Check if a date is a weekday (Mon-Fri) */
function isWeekday(dateStr) {
  const dow = getDayOfWeek(dateStr);
  return dow >= 1 && dow <= 5;
}

/** Return the next weekday (Mon-Fri) on or after the given date */
function nextWeekday(dateStr) {
  let [y, m, d] = parseDate(dateStr);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow >= 1 && dow <= 5) {
      return formatDateObj(y, m, d);
    }
    // Advance one day
    d++;
    const daysInMonth = new Date(y, m, 0).getDate();
    if (d > daysInMonth) {
      d = 1;
      m++;
      if (m > 12) { m = 1; y++; }
    }
  }
}

/** Add N days to a date string and return YYYY-MM-DD */
function addDays(dateStr, n) {
  let [y, m, d] = parseDate(dateStr);
  d += n;
  // Handle negative (going backwards)
  while (d < 1) {
    m--;
    if (m < 1) { m = 12; y--; }
    d += new Date(y, m, 0).getDate();
  }
  // Handle positive overflow
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const daysInMonth = new Date(y, m, 0).getDate();
    if (d <= daysInMonth) break;
    d -= daysInMonth;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return formatDateObj(y, m, d);
}

/** Subtract N days from a date string and return YYYY-MM-DD */
function subDays(dateStr, n) {
  return addDays(dateStr, -n);
}

/** Return a parsed object for a date string */
function malaysiaMidnight(dateStr) {
  const [y, m, d] = parseDate(dateStr);
  return { year: y, month: m, day: d };
}

/** Generate a random Malaysia evening time (6-9 PM MYT = 10:00-13:00 UTC) */
function randomMalaysiaEveningTime() {
  const hourMYT = 18 + Math.floor(Math.random() * 3); // 18, 19, 20
  const minute = Math.floor(Math.random() * 60);
  // Convert MYT to UTC: MYT = UTC+8, so UTC hour = MYT hour - 8
  const hourUTC = hourMYT - 8;
  return `${String(hourUTC).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+00:00`;
}

/**
 * Get the ISO timestamp for a date at a random Malaysia evening time.
 * Returns ISO 8601 string suitable for timestamptz.
 */
function makeScheduledTimestamp(dateStr) {
  const timePart = randomMalaysiaEveningTime();
  return `${dateStr}T${timePart}`;
}

/**
 * Check if a content_calendar row is a festival post.
 * Uses the same logic as festival-handler but works with any pillar.
 */
function isFestivalRow(row) {
  if (!row) return false;
  // Check pillar first — monthly-plan stored festival as 'story'
  const pillar = (row.pillar || '').toLowerCase();
  // Allow 'festival' pillar or 'story' pillar with festival keywords
  if (pillar === 'festival') return true;
  if (pillar !== 'story') return false;

  const postAngle = (row.post_angle || '').toLowerCase();
  const topic = (row.topic || '').toLowerCase();
  const combinedText = `${postAngle} ${topic}`;

  for (const kw of FESTIVAL_KEYWORDS) {
    if (combinedText.includes(kw)) return true;
  }
  return false;
}

/**
 * Get the week number (1-5) for a date within its month.
 */
function getWeekOfMonth(dateStr) {
  const { day } = malaysiaMidnight(dateStr);
  return Math.ceil(day / 7);
}

/**
 * Count how many posts are already assigned to a specific date in the schedule map.
 */
function countForDate(scheduleMap, dateStr) {
  return (scheduleMap.get(dateStr) || 0);
}

/**
 * Count how many posts are assigned to a given week (by week number) in the schedule map.
 */
function countForWeek(scheduleMap, dateStr) {
  const targetWeek = getWeekOfMonth(dateStr);
  let count = 0;
  for (const [assignedDate, numPosts] of scheduleMap) {
    if (getWeekOfMonth(assignedDate) === targetWeek) {
      count += numPosts;
    }
  }
  return count;
}

// ============================================
// Main scheduling algorithm
// ============================================

/**
 * Schedule all approved posts for a content plan.
 *
 * Algorithm:
 * 1. Fetch all approved content_calendar rows for the plan
 * 2. Separate into festival and regular posts
 * 3. Festival posts: assign to suggested_date (or nearest weekday 1-2 days before)
 * 4. Regular posts: spread Mon-Fri, max 3-4 per week, no two on same day
 * 5. All times set to Malaysia evening (6-9 PM MYT = UTC+8)
 * 6. Update each row's scheduled_date
 * 7. Update content_plans status to 'scheduled'
 *
 * @param {string} planId - UUID of the content plan
 * @param {object} [opts]
 * @param {string[]} [opts.statuses] - which row statuses are schedulable.
 *   Default ['approved'] (worker auto-schedule after image review).
 *   Manual /schedule_month passes post-copy statuses too, so a plan can be
 *   scheduled even if imagery is still pending — scheduling only assigns
 *   dates, it does not change row status.
 * @returns {Promise<Array>} - Array of updated rows with their scheduled dates
 */
async function schedulePlan(planId, opts = {}) {
  if (!planId) throw new Error('schedulePlan: planId is required');
  const statuses = opts.statuses || ['approved'];

  // 1. Fetch all schedulable rows for this plan
  const allRows = await supabase.listContentCalendarByPlanId(planId);
  const approvedRows = allRows.filter(r => statuses.includes(r.status));

  if (approvedRows.length === 0) {
    throw new Error(
      `No schedulable posts (status in: ${statuses.join(', ')}) found for plan ${planId}`
    );
  }

  // 2. Separate festival and regular posts
  const festivalPosts = [];
  const regularPosts = [];

  for (const row of approvedRows) {
    if (isFestivalRow(row)) {
      festivalPosts.push(row);
    } else {
      regularPosts.push(row);
    }
  }

  // 3. Determine the month from suggested_dates
  const allDates = approvedRows
    .map(r => r.suggested_date)
    .filter(Boolean)
    .sort();

  if (allDates.length === 0) {
    throw new Error('No suggested_dates found on approved posts');
  }

  // Find the month/year boundaries
  const firstDate = allDates[0];
  const [year, month] = firstDate.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();

  // 4. Assign dates — track allocated dates to avoid duplicates
  const scheduleMap = new Map(); // dateStr -> count of regular posts assigned

  const result = [];

  // ---- Festival posts ----
  for (const row of festivalPosts) {
    const suggestedDate = row.suggested_date;
    let assignedDate;

    if (suggestedDate) {
      // Try suggested_date first
      const dow = getDayOfWeek(suggestedDate);
      if (dow >= 1 && dow <= 5) {
        // suggested_date is already a weekday — use it
        assignedDate = suggestedDate;
      } else {
        // Find nearest weekday 1-2 days before (weekend festival dates)
        assignedDate = subDays(suggestedDate, dow === 0 ? 2 : 1); // Sun->Fri, Sat->Thu
      }
    } else {
      // No suggested_date — pick the last weekday of the month
      assignedDate = formatDate(new Date(year, month, 0));
      while (!isWeekday(assignedDate)) {
        assignedDate = subDays(assignedDate, 1);
      }
    }

    // Festival posts CAN share dates with regular posts
    const timestamp = makeScheduledTimestamp(assignedDate);
    result.push({
      id: row.id,
      topic: row.topic,
      pillar: row.pillar,
      suggested_date: row.suggested_date,
      scheduled_date: assignedDate,
      scheduled_timestamp: timestamp,
      type: 'festival',
    });
  }

  // ---- Regular posts ----
  // Sort by suggested_date for deterministic assignment
  const sortedRegular = [...regularPosts].sort((a, b) => {
    return (a.suggested_date || '').localeCompare(b.suggested_date || '');
  });

  for (const row of sortedRegular) {
    const suggestedDate = row.suggested_date;
    let assignedDate;

    if (suggestedDate) {
      assignedDate = nextWeekday(suggestedDate);

      // Walk forward until we find a day that:
      // 1. Has no regular post assigned already
      // 2. Has fewer than 4 posts in its week
      let maxIterations = daysInMonth * 3; // safety limit
      while (maxIterations > 0) {
        const dateTaken = countForDate(scheduleMap, assignedDate) > 0;
        const weekFull = countForWeek(scheduleMap, assignedDate) >= 4;
        if (!dateTaken && !weekFull) break;
        assignedDate = nextWeekday(addDays(assignedDate, 1));
        maxIterations--;
      }
    } else {
      // No suggested_date — assign to first available weekday
      assignedDate = nextWeekday(formatDate(new Date(year, month - 1, 1)));
      let maxIterations = daysInMonth * 3;
      while (maxIterations > 0) {
        const dateTaken = countForDate(scheduleMap, assignedDate) > 0;
        const weekFull = countForWeek(scheduleMap, assignedDate) >= 4;
        if (!dateTaken && !weekFull) break;
        assignedDate = nextWeekday(addDays(assignedDate, 1));
        maxIterations--;
      }
    }

    // Mark this date as used
    scheduleMap.set(assignedDate, (scheduleMap.get(assignedDate) || 0) + 1);

    const timestamp = makeScheduledTimestamp(assignedDate);
    result.push({
      id: row.id,
      topic: row.topic,
      pillar: row.pillar,
      suggested_date: row.suggested_date,
      scheduled_date: assignedDate,
      scheduled_timestamp: timestamp,
      type: 'regular',
    });
  }

  // 5. Persist scheduled_date to content_calendar
  const updatedRows = [];
  for (const item of result) {
    try {
      const updated = await supabase.updateContentCalendar(item.id, {
        scheduled_date: item.scheduled_timestamp,
      });
      updatedRows.push({
        id: item.id,
        topic: item.topic,
        pillar: item.pillar,
        suggested_date: item.suggested_date,
        scheduled_date: item.scheduled_date,
        scheduled_timestamp: item.scheduled_timestamp,
        type: item.type,
        status: updated ? updated.status : 'approved',
      });
    } catch (err) {
      console.error(`schedulePlan: failed to update row ${item.id}:`, err.message);
      updatedRows.push({
        id: item.id,
        topic: item.topic,
        pillar: item.pillar,
        suggested_date: item.suggested_date,
        scheduled_date: item.scheduled_date,
        type: item.type,
        error: err.message,
      });
    }
  }

  // 6. Update content_plans status to 'scheduled'
  try {
    await supabasePlans.updateContentPlan(planId, { status: 'scheduled' });
  } catch (err) {
    console.error(`schedulePlan: failed to update plan ${planId} status:`, err.message);
    // Non-fatal — rows are already updated
  }

  return updatedRows;
}

/**
 * Build a formatted table of scheduled dates for display.
 */
function formatScheduleTable(rows) {
  if (!rows || rows.length === 0) return 'No scheduled posts.';

  // Sort by scheduled_date
  const sorted = [...rows].sort((a, b) =>
    (a.scheduled_date || '').localeCompare(b.scheduled_date || '')
  );

  let output = '📅 *Scheduled Posts*\n\n';

  // Group by week
  const weeks = [];
  let currentWeek = [];
  let currentWeekNum = null;

  for (const row of sorted) {
    if (!row.scheduled_date) continue;
    const { year, month, day } = malaysiaMidnight(row.scheduled_date);
    const d = new Date(year, month - 1, day);
    const startOfYear = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((d - startOfYear) / 86400000) + startOfYear.getDay() + 1) / 7);

    if (currentWeekNum !== null && weekNum !== currentWeekNum) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeekNum = weekNum;
    currentWeek.push(row);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const typeEmoji = { festival: '🎊', regular: '📝' };

  for (const week of weeks) {
    output += `━━━ *Week* ━━━\n`;
    for (const row of week) {
      const emoji = typeEmoji[row.type] || '📝';
      const dateFmt = (row.scheduled_date || '').replace(/^\d{4}-/, '');
      const timeFmt = row.scheduled_timestamp
        ? row.scheduled_timestamp.slice(11, 16) + ' UTC'
        : '';
      output += `${emoji} ${dateFmt} ${timeFmt} — *${row.topic}*\n`;
      if (row.type === 'festival') output += `   🎊 Festival post\n`;
      output += `\n`;
    }
  }

  const festivalCount = rows.filter(r => r.type === 'festival').length;
  const regularCount = rows.filter(r => r.type !== 'festival').length;
  output += `✅ *${regularCount} regular + ${festivalCount} festival posts scheduled*`;

  return output;
}

module.exports = {
  schedulePlan,
  formatScheduleTable,
  isFestivalRow,
  // Exported for testing
  _helpers: {
    nextWeekday,
    isWeekday,
    getDayOfWeek,
    formatDate,
    addDays,
    subDays,
    malaysiaMidnight,
    getWeekOfMonth,
    randomMalaysiaEveningTime,
    makeScheduledTimestamp,
    FESTIVAL_KEYWORDS,
  },
};