// ============================================
// Copywriting node — generates FB + IG copy + hashtags.
//
// Exposes:
//   buildCopywritingPrompt(topic, pillar) → system prompt string
//   parseCopywritingResponse(rawText)     → { fb_content, ig_content, hashtags } | null
//   validateCopywritingResult(parsed)     → { valid, errors, keywordsHit }
//   FORBIDDEN_PLACEHOLDER_PATTERNS        → array of patterns
//   FANZ_KEYWORD_PATTERNS                 → RegExp[]
// ============================================

const { getMalaysiaDate, MONTHS, FESTIVALS } = require('./planning');

// RegExp subclass exposing .includes(needle) over the pattern's source.
// Lets external code introspect the placeholder list by literal substring.
class StringRegExp extends RegExp {
  includes(needle) {
    return typeof needle === 'string' && this.source.includes(needle);
  }
}

const FORBIDDEN_PLACEHOLDER_PATTERNS = [
  new StringRegExp('{{'),
  new StringRegExp('}}'),
  new StringRegExp('TODO', 'i'),
  new StringRegExp('lorem', 'i'),
  new StringRegExp('ipsum', 'i'),
  new StringRegExp('placeholder', 'i'),
  new StringRegExp('insert', 'i'),
];

const FANZ_KEYWORD_PATTERNS = [
  /10.*(?:year|warranty)/i,
  /warranty/i,
  /SIRIM/i,
  /on.?site|onsite/i,
  /DC/i,
  /motor/i,
  /energy/i,
  /Malaysia/i,
  /ceiling.?fan|dc.?fan|smart.?fan/i,
];

// ============================================
// buildCopywritingPrompt
// ============================================

// 硬编码的默认品牌声音（brand_kit.brand_voice 为空时用它）
const DEFAULT_VOICE_BLOCK = `BRAND VOICE:
- Professional, crisp, and confident — every word earns its place
- Short sentences. Rhythmic pacing. Like: "Simple design. Strong airflow. Lasting comfort."
- Use unexpected hooks: "Bigger fan doesn't always mean better airflow"
- Not salesy, not robotic — think of a knowledgeable friend who happens to write great copy
- All copy must be in English only (Malaysia/Singapore English context)`;

/**
 * @param {string} topic
 * @param {string} pillar
 * @param {string} [reviewNotes]
 * @param {string} [brandVoice] - brand_kit.brand_voice；有值则替换默认声音块，
 *   让老板在 Dashboard 调语气不用改代码。语言约束（English only）始终保留。
 */
function buildCopywritingPrompt(topic, pillar, reviewNotes, brandVoice) {
  const now = getMalaysiaDate();
  const currentDate = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const currentMonthNum = now.getMonth();

  const activeSeasons = FESTIVALS
    .filter(f => f.triggerMonths.includes(currentMonthNum))
    .map(f => `${f.name} (${f.range})`)
    .join('; ') || 'no major festival; base on general Malaysia weather/marketing rhythm';

  const voiceBlock = (brandVoice && brandVoice.trim())
    ? `BRAND VOICE (set in Brand Kit):\n${brandVoice.trim()}\n- All copy must be in English only (Malaysia/Singapore English context)`
    : DEFAULT_VOICE_BLOCK;

  let prompt = `You are a senior social media copywriter for Fanz Sdn Bhd, a Malaysian ceiling fan brand.

${voiceBlock}

BRAND IDENTITY (core selling points — weave 2-3 into every product post naturally):
- 10-year motor warranty ⏤ this is our biggest trust signal
- SIRIM certified ⏤ Malaysian quality assurance
- DC motor technology ⏤ energy efficient, whisper quiet
- On-site service across Malaysia & Singapore
- Product liability insurance up to RM 1,000,000
- 10+ years serving Malaysian homes

PRODUCT RANGE:
- FS Series 563 L — 56" smart ceiling fan, perfect for large living rooms
- Grande L Series — 22W LED light, 45"/52" ABS blades, ideal for living & dining rooms
- Smart Series — WiFi-enabled, app control, multi-speed, LED brightness
- AURA Series — compact 36"/48", perfect for bedrooms and small spaces
- Inno Series — 5-blade design, 43"/52", LED dimmer, WiFi

CURRENT CONTEXT:
- Current date (Malaysia): ${currentDate}
- Active seasonal / festival context: ${activeSeasons}

YOUR TASK:
Generate a social media post for this topic and content pillar.

Topic: "${topic}"
Pillar: ${pillar}

OUTPUT FORMAT — you MUST use these exact section headers (the system parses them automatically):

📱 FACEBOOK VERSION
(Hook + value points + CTA. Short sentences, rhythmic pacing. Include 2-3 brand identity points.)
(Use 🌐 https://fanz.my at the end if product/productivity post.)

📸 INSTAGRAM VERSION
(Shorter, punchier. Line breaks OK. Hook → value → CTA. Include 2-3 brand identity points.)
(Use 🌐 https://fanz.my at the end if product/productivity post.)

#⃣ HASHTAGS
(5-8 hashtags from the approved library below)

COPY STRUCTURE (for both FB and IG versions):
1. HOOK (1-2 sentences) — unexpected angle, short statement, or relatable scenario
2. VALUE (2-4 sentences or ✌️ bullets) — highlight features with 2-3 brand identity points
3. CALL-TO-ACTION — choose ONE from:
   - "Head over to the website to learn more about our ceiling fan"
   - "DM us for more details!"
   - "Drop your room type, pm us and we'll suggest the suitable fan size"
   - "Get yours today at fanz.my!"
4. WEBSITE (product/productivity only) — 🌐 https://fanz.my

⚠️ CRITICAL: Hashtags go ONLY in the #⃣ HASHTAGS section below.
Do NOT append hashtags to the end of 📱 FACEBOOK VERSION or 📸 INSTAGRAM VERSION content.
The #⃣ HASHTAGS section must contain all hashtags and nothing else.

HASHTAG GUIDELINES:
Pick from this brand-approved hashtag library, 5-8 per post:

Always include: #FANZ #Fanz
Brand slogans: #TheAirExpert #TheAirMover
Product category: #CeilingFan #DCFan #SmartFan
Market: #Malaysia #Singapore #CeilingFanMalaysia
Lifestyle: #CozyHome #HomeAppliance #RenovationMalaysia #InteriorDesignMalaysia
Series (add if relevant): #GrandeSeries #AURA #SmartSeries #FS563L #InnoSeries
Seasonal/festival: add relevant tags based on current date

EMOJI USAGE:
Use sparingly (2-5 per post), consistent with Fanz brand:
- ✨ brand polish
- ❄️🍃 cool air, natural fresh
- ✌️ bullet points (use in VALUE section)
- 🌐 before website URL
- ‼️ emphasis (rare, one per post max)

PILLAR-STYLE GUIDES:

product — Feature-driven, functional, concise. End with website CTA. Use bullets (✌️) for spec highlights.
  MANDATORY selling points for product pillar: MUST include ALL applicable: SIRIM certified + 10-year motor warranty + DC motor (energy efficient, quiet).

case — Lifestyle storytelling. "Transform your bedroom into..." Paint a picture of the space. Show don't tell. Soft CTA.

promo — Clear offer. Sense of timing/urgency. Engagement-driving CTA (DM us, drop your room type). Numbers stand out.

story — Brand values, emotional connection. "Your comfort is our priority." Less product, more heart. Website CTA, not pushy.

educational — Practical how-to (e.g. "How to choose the right fan size for your room"). Help first, sell second. Soft CTA.

SPECIAL RULE — FESTIVE GREETING POSTS (Hari Raya, CNY, Deepavali, Muharram, Christmas, Merdeka):
- Pure greeting. Do NOT hard-sell products.
- Can include: "Head over to the website" as the only CTA.
- Product references must be subtle (e.g. "celebrating with cool comfort").
- Warm, respectful tone.

FINAL CHECKS BEFORE OUTPUT:
- Is the language 100% English? (No Chinese-Malay mixing)
- Do NOT put hashtags at the end of FB or IG version — they go ONLY in #⃣ HASHTAGS section
- Are hashtags from the approved library?
- No placeholders, no TODOs, no lorem ipsum.
- Product posts must mention 10-year warranty naturally.`;

  // NEW: Append revision context if reviewNotes is provided
  if (reviewNotes && typeof reviewNotes === 'string' && reviewNotes.trim()) {
    prompt += `\n\nREVISION CONTEXT — The previous version of this post was rejected by the reviewer. Please address these specific revision notes in your new version:\n"${reviewNotes}"\n\nDO NOT simply rephrase — actively incorporate the feedback above.\nDO NOT leave placeholders or TODOs.`;
  }

  return prompt;
}

// ============================================
// parseCopywritingResponse
// ============================================

const SECTION_PATTERNS = {
  fb_content: /^\s*(?:📱\s*)?FACEBOOK\s*VERSION/i,
  ig_content: /^\s*(?:📸\s*)?INSTAGRAM\s*VERSION/i,
  hashtags: /^\s*(?:#⃣\s*)?HASHTAGS/i,
};

function parseCopywritingResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const lines = rawText.split('\n');

  // Locate each section header's line index
  const headerHits = []; // { key, lineIndex }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [key, pattern] of Object.entries(SECTION_PATTERNS)) {
      if (pattern.test(line)) {
        headerHits.push({ key, lineIndex: i });
        break; // one header per line
      }
    }
  }

  if (headerHits.length === 0) return null;

  // Sort by line index so we can slice between consecutive headers
  headerHits.sort((a, b) => a.lineIndex - b.lineIndex);

  const sections = { fb_content: '', ig_content: '', hashtags: '' };
  for (let i = 0; i < headerHits.length; i++) {
    const { key, lineIndex } = headerHits[i];
    const nextLine = i + 1 < headerHits.length ? headerHits[i + 1].lineIndex : lines.length;
    const body = lines.slice(lineIndex + 1, nextLine).join('\n').trim();
    sections[key] = body;
  }

  return sections;
}

// ============================================
// validateCopywritingResult
// ============================================

function validateCopywritingResult({ fb_content, ig_content, hashtags }) {
  const errors = [];

  if (!fb_content || !fb_content.trim()) errors.push('fb_content is empty');
  if (!ig_content || !ig_content.trim()) errors.push('ig_content is empty');
  if (!hashtags || !hashtags.trim()) errors.push('hashtags is empty');

  const allText = [fb_content, ig_content, hashtags].filter(Boolean).join(' ');

  for (const pattern of FORBIDDEN_PLACEHOLDER_PATTERNS) {
    if (pattern.test(allText)) {
      errors.push(`forbidden placeholder detected (pattern: ${pattern.source})`);
    }
  }

  const keywordsHit = [];
  for (const pattern of FANZ_KEYWORD_PATTERNS) {
    if (pattern.test(allText)) {
      keywordsHit.push(pattern.source);
    }
  }

  if (keywordsHit.length === 0 && allText.trim()) {
    errors.push('no Fanz brand keyword detected (warranty / SIRIM / on-site / motor / etc.)');
  }

  return {
    valid: errors.length === 0,
    errors,
    keywordsHit,
  };
}

module.exports = {
  buildCopywritingPrompt,
  parseCopywritingResponse,
  validateCopywritingResult,
  FORBIDDEN_PLACEHOLDER_PATTERNS,
  FANZ_KEYWORD_PATTERNS,
};
