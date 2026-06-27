// ============================================
// content_calendar planning module
//
// Extracted from index.js for testability.
// Contains: buildPlanSystemPrompt, parsePlanResponse, plan session helpers.
// ============================================

// ============================================
// Timezone-aware date helpers
// ============================================

/** Return a Date in Asia/Kuala_Lumpur timezone. */
function getMalaysiaDate() {
  const now = new Date();
  const ms = now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000; // UTC+8
  return new Date(ms);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const FESTIVALS = [
  { name: 'Chinese New Year (农历新年)', range: 'Jan-Feb', triggerMonths: [0, 1] },
  { name: 'Hari Raya Aidilfitri (开斋节)', range: 'March-April', triggerMonths: [2, 3] },
  { name: 'Deepavali (屠妖节)', range: 'Oct-Nov', triggerMonths: [9, 10] },
  { name: 'Christmas (圣诞节)', range: 'December', triggerMonths: [11] },
  { name: 'National Day / Merdeka (国庆)', range: 'August 31', triggerMonths: [7] },
  { name: 'Malaysia Day (马来西亚日)', range: 'September 16', triggerMonths: [8] },
  { name: 'Mid-year sales (年中促销)', range: 'June-July', triggerMonths: [5, 6] },
  { name: 'School holidays (学校假期)', range: 'March, June, December', triggerMonths: [2, 5, 11] },
  { name: 'Rainy / monsoon season (雨季)', range: 'Nov-Feb', triggerMonths: [10, 11, 0, 1] },
  { name: 'Hot / dry season (热季)', range: 'March-May', triggerMonths: [2, 3, 4] },
];

// ============================================
// buildPlanSystemPrompt
// ============================================

function buildPlanSystemPrompt() {
  const now = getMalaysiaDate();
  const currentMonth = MONTHS[now.getMonth()];
  const currentYear = now.getFullYear();
  const currentDate = `${currentMonth} ${now.getDate()}, ${currentYear}`;
  const currentMonthNum = now.getMonth();

  const nearEvents = FESTIVALS.filter(f => f.triggerMonths.includes(currentMonthNum));
  const nearContext = nearEvents.length > 0
    ? `\nCURRENT SEASONAL HIGHLIGHTS (currently active / approaching):\n${nearEvents.map(f => `- ${f.name} (${f.range})`).join('\n')}`
    : '';

  return `You are a senior social media content strategist for Fanz Sdn Bhd, a Malaysian ceiling fan brand.

Your job: Suggest 3-5 content topics for the coming week that are relevant, timely, and aligned with the current date in Malaysia.

CURRENT DATE: ${currentDate}${nearContext}

MALAYSIA SEASONAL & CULTURAL CONTEXT (full reference):
- Hari Raya Aidilfitri (March-April) — home decoration, family gatherings
- Deepavali (Oct-Nov) — festive lighting, home preparation
- Chinese New Year (Jan-Feb) — spring cleaning, home upgrades
- Christmas (Dec) — year-end festive season
- Muharram / Awal Muharram — Islamic New Year
- National Day (Aug 31) — Merdeka campaigns
- Malaysia Day (Sep 16) — East Malaysia awareness
- School holidays (March, June, December) — family time at home
- Rainy season (Nov-Feb) — enclosed spaces, ventilation
- Hot season (March-May) — peak fan season, heat relief
- Mid-year sales (June-July) — promotion-friendly period
- Year-end sales (Nov-Dec) — year-end campaigns

BRAND & PRODUCTS:
- 10+ years in Malaysia, 10-year motor warranty
- On-site service across Malaysia & Singapore
- SIRIM certified, DC motor technology, energy efficient
- Product liability up to RM 1,000,000
- Products: FS Series 563 L (smart, large living rooms), Grande L Series (22W LED, living/dining), Smart Series (WiFi app control), AURA Series (compact, bedrooms), Inno Series (5-blade, LED dimmer, WiFi)

YOUR TASK:
Based on the CURRENT DATE and Malaysia context above, suggest 3-5 content topics for Fanz's social media this week.

For each topic, include:
1. A catchy title in English (short, punchy, like a real Fanz social media post)
2. A one-sentence explanation of why this topic works now
3. A recommended content direction from exactly one of: product, case, promo, story, educational

Pillar definitions:
- product: Feature-driven, functional selling points, concise, ends with website CTA (https://fanz.my)
- case: Lifestyle-oriented, "transform your space", real-home feel
- promo: Clear offer, urgency, engagement CTA
- story: Brand values, emotional connection, "your comfort is our priority"
- educational: Practical guides (e.g. "how to choose fan size"), problem-solving, soft CTA

Your output MUST follow this exact format — one numbered item per line block with clear separators:

===== 1 =====
Title: [catchy title in English]
Why: [one sentence explaining timeliness/relevance]
Direction: [product|case|promo|story|educational]

===== 2 =====
Title: [catchy title in English]
Why: [one sentence]
Direction: [product|case|promo|story|educational]

... and so on up to 5.

IMPORTANT:
- Titles must be in English only — Fanz posts are always in English
- Do NOT invent holidays or events that don't exist
- If no major event is near the current date, base suggestions on seasons and general marketing timing
- Keep suggestions practical for a ceiling fan brand
- No post content generation — only topic planning`;
}

// ============================================
// parsePlanResponse
// ============================================

/**
 * Parse AI output into structured plan objects.
 *
 * Supports two formats:
 *   A. Block format (explicit "===== N =====" separator):
 *        ===== 1 =====
 *        Title: ...
 *        Why: ...
 *        Direction: ...
 *   B. Numbered list format (freeform "N. Title ..."):
 *        1. Cool Title
 *        Title: Cool Title
 *        Why: ...
 *        Direction: ...
 *
 * Returns [{ number, title, description, direction }]
 *   - number: integer
 *   - title, description: strings (empty if missing)
 *   - direction: one of 'product','case','promo','story' (defaults to 'product' on unknown)
 */
function parsePlanResponse(rawText) {
  const plans = [];
  let currentPlan = null;
  let inBlock = false; // true after "===== N =====" seen — block format active

  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // --- A. Block separator: "===== N ====="
    const blockMatch = trimmed.match(/^=+\s*(\d+)\s*=/);
    if (blockMatch) {
      if (currentPlan && currentPlan.number) {
        plans.push(currentPlan);
      }
      currentPlan = { number: parseInt(blockMatch[1]), title: '', description: '', direction: '' };
      inBlock = true;
      continue;
    }

    // --- B. Numbered list item: "N. Title" — only activates if NOT inside a block
    if (!inBlock) {
      const startMatch = trimmed.match(/^(\d+)[.)]\s+/);
      if (startMatch) {
        if (currentPlan && currentPlan.number) {
          plans.push(currentPlan);
        }
        currentPlan = {
          number: parseInt(startMatch[1]),
          title: trimmed.replace(/^\d+[.)]\s*/, ''),
          description: '',
          direction: '',
        };
        continue;
      }
    }

    if (!currentPlan) continue;

    // --- C. Field labels inside a plan block
    const titleMatch = trimmed.match(/^Title:\s*(.+)/i);
    const whyMatch = trimmed.match(/^Why:\s*(.+)/i);
    const directionMatch = trimmed.match(/^Direction:\s*(.+)/i);

    if (titleMatch) {
      currentPlan.title = titleMatch[1].trim();
    } else if (whyMatch) {
      currentPlan.description = whyMatch[1].trim();
    } else if (directionMatch) {
      const dir = directionMatch[1].trim().toLowerCase();
      if (['product', 'case', 'promo', 'story'].includes(dir)) {
        currentPlan.direction = dir;
      } else {
        currentPlan.direction = 'product'; // default fallback for unknown values
      }
    }
  }

  // Don't forget the last plan (must have number + title to count)
  if (currentPlan && currentPlan.number && currentPlan.title) {
    plans.push(currentPlan);
  }

  return plans;
}

// ============================================
// Selection helpers
// ============================================

/**
 * Find a plan by number in the session.
 * Returns the plan object or null if not found.
 */
function findPlanByNumber(session, num) {
  if (!session || !Array.isArray(session.plans)) return null;
  return session.plans.find(p => p.number === num) || null;
}

/**
 * Validate a selection input.
 * Returns { valid: true, plan, number } or { valid: false, message }.
 */
function validateSelection(session, rawText) {
  if (!session) {
    return { valid: false, message: 'Session expired or not found. Please send /plan to start over.' };
  }

  if (!/^[1-9]\d{0,2}$/.test(rawText)) {
    return { valid: false, message: 'Please reply with a number only.' };
  }

  const num = parseInt(rawText, 10);
  const plan = findPlanByNumber(session, num);

  if (!plan) {
    return { valid: false, message: `Please reply with a number between 1-${session.plans.length}. Or send /plan to start over.` };
  }

  return { valid: true, plan, number: num };
}

/**
 * Build the payload for content_calendar creation from a selected plan.
 */
function createSelectionPayload(plan, chatId) {
  return {
    chat_id: String(chatId),
    pillar: plan.direction,
    topic: plan.title,
    status: 'selected',
  };
}

module.exports = {
  buildPlanSystemPrompt,
  parsePlanResponse,
  findPlanByNumber,
  validateSelection,
  createSelectionPayload,
  getMalaysiaDate,
  MONTHS,
  FESTIVALS,
};