// Fanz Sdn Bhd — Product & Brand Database for Marketing Bot
// Independent copy for Railway deployment

const brand = {
  name: "Fanz Sdn Bhd",
  yearsInBusiness: "10 years (Malaysia)",
  keySellingPoints: [
    "10-year motor warranty",
    "On-site service (Malaysia & Singapore)",
    "SIRIM certified — Malaysian quality assurance",
    "DC motor technology (energy saving, quiet operation)",
    "Product liability insurance RM 1,000,000",
  ],
  contactPhone: "+60 17-707 1366",
  contactEmail: "contact@fanz.my",
  businessHours: "Monday to Friday 9:00 AM – 5:30 PM / 周一至五 9:00AM–5:30PM",
  address: "No 5, Jalan Ekoperniagaan 1/26, Taman Ekoperniagaan, 81100 Johor Bahru, Johor",
};

const products = [
  {
    id: "fs-series",
    name: "FS Series 563 L",
    nameZh: "FS系列 563升",
    type: "Ceiling Fan (Smart)",
    typeZh: "智能款",
    description: '56" L-type fan blades, DC motor, smart control. Suitable for large living rooms.',
    descriptionZh: "56寸L型扇叶，智能控制，DC马达，适合客厅大空间",
    keySellingPoints: [
      "10-year motor warranty",
      "DC motor — energy saving & quiet",
      "Smart control compatible",
      "SIRIM certified",
      "Ideal for large living rooms & big spaces",
    ],
  },
  {
    id: "grande-l",
    name: "Grande L Series",
    nameZh: "Grande L系列",
    type: "Ceiling Fan (Non-Smart)",
    typeZh: "非智能款",
    description: '56" ABS fan blades with 22W LED light, DC motor, energy saving.',
    descriptionZh: "56寸ABS扇叶，22W LED灯，DC马达节能，适合客厅餐厅",
    keySellingPoints: [
      "10-year motor warranty",
      "Built-in 22W LED light",
      "DC motor — energy saving & quiet",
      "SIRIM certified",
      "Ideal for living room & dining room",
    ],
  },
  {
    id: "smart-series",
    name: "Smart Series",
    nameZh: "Smart系列",
    type: "Smart Ceiling Fan",
    typeZh: "智能款",
    description: "WiFi-enabled smart ceiling fan with app control, multi-speed, LED brightness, scheduled timing.",
    descriptionZh: "WiFi远程控制、多档调速、多级LED亮度、定时排程",
    keySellingPoints: [
      "10-year motor warranty",
      "WiFi remote control via app",
      "Multi-speed adjustment",
      "Multi-level LED brightness",
      "Scheduled timing & smart home integration",
      "SIRIM certified",
    ],
  },
  {
    id: "aura",
    name: "AURA Series",
    nameZh: "AURA系列",
    type: "Ceiling Fan (Compact)",
    typeZh: "非智能款",
    description: "Compact design, perfect for small spaces and low ceilings. Ideal for bedrooms.",
    descriptionZh: "紧凑型，适合小空间低天花、卧室小房间",
    keySellingPoints: [
      "10-year motor warranty",
      "Compact design — fits small spaces",
      "Low ceiling friendly",
      "Quiet DC motor",
      "Energy efficient",
      "SIRIM certified",
    ],
  },
];

// ============================================
// 型号族参考（来自 27 张真实经销商发票，2026-07-08）
// 归一化用：变体写法 → 规范型号族 → 品牌。零客户 PII。
// 完整归一化表见 fanz-customer-service-bot/docs/model-normalization.md
// brand: 'fanz'（马达 10 年）| 'vioz'（Fanz 低价子线，马达 5 年，待最终确认）
// ============================================
const modelFamilies = [
  // ── Fanz 主线（10 年）──
  { family: "FS", brand: "fanz", sizes: ['42"', '48"', '52"', '56"'], variants: ["FS 423 N", "FS 423L", "FANZ-FS 423-L", "FS 563 N", "FS 563L", "FANZ-FS 48-L", "FS525N", "FANZ-FS525N"], note: "遥控 LED 吊扇，主力" },
  { family: "Grande", brand: "fanz", sizes: ['52"'], variants: ["Grande L Series", "FANZ-GRANDE 523-L", "Grande 525L"], note: "Smart LED RC v2" },
  { family: "Aura", brand: "fanz", sizes: ['36"', '48"'], variants: ["AURA Series", "FANZ-AURA 36L", "FANZ-AURA 48L", 'FANZ-48"-AURA'], note: "Smart WiFi + LED" },
  { family: "Inno", brand: "fanz", sizes: [], variants: ["FANZ INNO 435 L", "FANZ-INNO 435-L"], note: "Smart LED RC v2" },
  { family: "Eco", brand: "fanz", sizes: [], variants: ["Fanz Eco 435L"], note: "早期型号" },
  { family: "Axel", brand: "fanz", sizes: ['16"'], variants: ["SERIE AXEL-PINEWOOD", "Fanz-Fanzo-Axel", "AXEL-16"], note: "含吊扇+壁扇" },
  { family: "Gaze", brand: "fanz", sizes: ['66"'], variants: ["GAZE-66N-MB"], note: '66" 3 叶 DC' },
  { family: "Spinor", brand: "fanz", sizes: [], variants: ["FANZ-SPINOR"], note: "角扇" },
  { family: "V605", brand: "fanz", sizes: [], variants: ["V605"], note: "主线型号 Matt Black（非 Vioz）" },
  { family: "Smart", brand: "fanz", sizes: [], variants: ["Smart Series"], note: "通用智能款" },
  // ── Vioz 子线（5 年，待确认）──
  { family: "Vioz Windy", brand: "vioz", sizes: ['42"', '56"'], variants: ["VIOZ WINDY MK II", "WINDY-56-MK2", "VIOZ-WINDY", "MK11 56 MB"], note: "MK II，DC 5 叶，RM139–175" },
  { family: "Vioz Vetta", brand: "vioz", sizes: ['56"'], variants: ["VIOZ-VETTA", "VETTA-56N"], note: "Oak+MB" },
  { family: "Vioz CF16", brand: "vioz", sizes: [], variants: ["FANZ-VIOZ CF16"], note: "角扇" },
  { family: "Vioz FF565", brand: "vioz", sizes: [], variants: ["FZ-VIOZ C/FAN FF 565"], note: "" },
];

// 颜色代号归一化
const colorAliases = {
  bk: "Black", black: "Black",
  oak: "Oakwood", oakwood: "Oakwood", mahogany: "Oakwood",
  pw: "Pinewood", pinewood: "Pinewood",
  mw: "Matt White", "matt white": "Matt White",
  mb: "Matt Black", mbk: "Matt Black", "matt black": "Matt Black", "matte black": "Matt Black",
};

module.exports = { brand, products, modelFamilies, colorAliases };
