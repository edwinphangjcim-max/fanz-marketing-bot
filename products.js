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

module.exports = { brand, products };
