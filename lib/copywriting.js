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
  /10.*(?:年|year|warranty)/i,
  /warranty/i,
  /SIRIM/i,
  /上门/i,
  /onsite|on-site/i,
  /马达|motor/i,
  /DC/i,
  /节能|energy/i,
  /保修/i,
  /Malaysia/i,
];

// ============================================
// buildCopywritingPrompt
// ============================================

function buildCopywritingPrompt(topic, pillar, reviewNotes) {
  const now = getMalaysiaDate();
  const currentDate = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const currentMonthNum = now.getMonth();

  const activeSeasons = FESTIVALS
    .filter(f => f.triggerMonths.includes(currentMonthNum))
    .map(f => `${f.name} (${f.range})`)
    .join('; ') || 'no major festival; base on general Malaysia weather/marketing rhythm';

  let prompt = `You are a senior social media copywriter for Fanz Sdn Bhd, a Malaysian ceiling fan and air cooler brand.

BRAND VOICE:
- Professional and warm — trustworthy, like a helpful friend
- Mixed Chinese-English (Malaysian style 中英混杂)
- Authentic, not robotic, not overly salesy

BRAND IDENTITY:
- 10+ years serving Malaysian homes
- 10-year motor warranty (major trust signal)
- On-site service across Malaysia & Singapore
- SIRIM certified — Malaysian quality assurance
- DC motor technology — energy efficient and quiet
- RM 1,000,000 product liability insurance

PRODUCT RANGE:
- FS Series 563 L: Smart ceiling fan, 56" L-type blades, large living rooms
- Grande L Series: 22W LED light + 56" blades, ideal for living/dining rooms
- Smart Series: WiFi app control, multi-speed, modern households
- AURA Series: Compact, perfect for bedrooms and small spaces

CURRENT CONTEXT:
- Current date (Malaysia): ${currentDate}
- Active seasonal / festival context: ${activeSeasons}

YOUR TASK:
Generate a social media post for this topic and content pillar.
- Topic: "${topic}"
- Pillar: ${pillar}  (one of: product | case | promo | story)

OUTPUT FORMAT — you MUST follow this exact structure, with the section headers exactly as shown:

📱 FACEBOOK VERSION
(2-4 sentences, Facebook style — hook + key value + soft CTA)

📸 INSTAGRAM VERSION
(2-4 sentences, Instagram style — punchier, line breaks OK, emoji-friendly)

#⃣ HASHTAGS
(8-12 Hashtags, mix of Chinese and English, include #FanzMalaysia)

IMPORTANT RULES:
- Always highlight the 10-year motor warranty
- Mention on-site service for Malaysia & Singapore
- Reference SIRIM certification naturally
- Reflect the current date and season above when relevant
- DO NOT output template-style double-curly placeholders
- DO NOT write "TODO" or leave anything unfinished
- DO NOT use lorem ipsum or other dummy text
- DO NOT invent specific discounts, prices, or promo codes
    - Mix Chinese and English naturally — write like a real Malaysian post`;

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
