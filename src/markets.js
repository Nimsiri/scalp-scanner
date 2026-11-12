// src/markets.js — ★ หลายตลาด: หุ้นอเมริกา (US) + หุ้นไทย (TH / ตลาดหลักทรัพย์แห่งประเทศไทย)
//
// หลักการ: โค้ดสแกนเดิมทั้งหมดเขียนไว้สำหรับหุ้นอเมริกา และต้องทำงานเหมือนเดิมทุกอย่าง
// หุ้นไทยจึงไม่ได้มีเส้นทางแยก แต่ใช้เครื่องยนต์เดียวกัน โดยเปลี่ยนเฉพาะ "สิ่งที่ต่างจริง":
//
//   สิ่งที่ต่าง              หุ้นอเมริกา                  หุ้นไทย
//   เขตเวลา                  America/New_York              Asia/Bangkok
//   เวลาทำการ                09:30-16:00 ต่อเนื่อง          10:00-12:30 · พักเที่ยง · 14:30-16:30
//   สกุลเงิน                  $                             ฿
//   ขนาดซื้อขายขั้นต่ำ        1 หุ้น                        100 หุ้น (1 board lot)
//   ช่วงราคา (tick)           $0.01                         ตามตาราง SET (0.01 ถึง 2 บาท ตามระดับราคา)
//   ข้อมูลฟรีจาก Yahoo       เกือบ realtime                 ช้ากว่าจริงราว 15-30 นาที
//   ดัชนีวัดภาวะตลาด         SPY + QQQ                     SET + SET50
//   ข่าว/sentiment ฟรี       มี (Alpha Vantage ฯลฯ)        ไม่มี → ข้าม ไม่เปลืองโควตา
//
// สัญลักษณ์หุ้นไทยใช้รูปแบบของ Yahoo คือชื่อย่อ + ".BK" เช่น PTT.BK, DELTA.BK

export const MARKET_IDS = ['US', 'TH'];

export const MARKETS = {
  US: {
    id: 'US',
    label: 'หุ้นอเมริกา',
    tz: 'America/New_York',
    tzLabel: 'นิวยอร์ก',
    currency: 'USD',
    cur: '$',
    lotSize: 1,
    sessionHours: 6.5,
    regimeSymbols: ['SPY', 'QQQ'],
  },
  TH: {
    id: 'TH',
    label: 'หุ้นไทย',
    tz: 'Asia/Bangkok',
    tzLabel: 'ไทย',
    currency: 'THB',
    cur: '฿',
    lotSize: 100,
    sessionHours: 4.5, // 10:00-12:30 + 14:30-16:30
    regimeSymbols: ['^SET.BK', '^SET50.BK'],
    benchmark: '^SET.BK',
    // มูลค่าซื้อขายต่อ 5 นาที (ล้านบาท) → คะแนนสภาพคล่อง
    // ตลาดไทยสภาพคล่องต่ำกว่าอเมริกามาก ถ้าใช้เกณฑ์ดอลลาร์คูณอัตราแลกเปลี่ยน หุ้นไทยเกือบทุกตัวจะได้ 0
    valueCurve: [[0.2, 0], [1, 40], [5, 75], [25, 100]],
  },
};

// ---------- หุ้นตัวนี้อยู่ตลาดไหน ----------
export function marketOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  return s.endsWith('.BK') || s.startsWith('^SET') ? 'TH' : 'US';
}

export function marketInfo(symbol) {
  return MARKETS[marketOf(symbol)];
}

// ---------- ช่วงราคาขั้นต่ำ (tick size) ----------
// ตารางช่วงราคาของตลาดหลักทรัพย์ฯ (หุ้นสามัญ) — ⚠️ ถ้า SET ประกาศเปลี่ยน ต้องแก้ที่นี่
export function setTickSize(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 0.01;
  if (p < 2) return 0.01;
  if (p < 5) return 0.02;
  if (p < 10) return 0.05;
  if (p < 25) return 0.10;
  if (p < 100) return 0.25;
  if (p < 200) return 0.50;
  if (p < 400) return 1.00;
  return 2.00;
}

export function tickSize(price, market) {
  return market === 'TH' ? setTickSize(price) : 0.01;
}

// ---------- รายชื่อหุ้นไทยตั้งต้น (100 ตัว) ----------
// คัดจากหุ้นขนาดใหญ่ที่ Yahoo มีข้อมูล 5 นาทีจริง เรียงตามมูลค่าตลาด
// และมีมูลค่าซื้อขายเฉลี่ยอย่างน้อย 20 ล้านบาท/วัน (ตรวจเมื่อ 30 ก.ย. 2026)
// ใกล้เคียงหลักเกณฑ์ SET100 แต่ไม่ใช่รายชื่อทางการ — แก้ไขได้ในหน้า Settings
export const TH_UNIVERSE_DEFAULT = [
  'DELTA', 'PTT', 'ADVANC', 'GULF', 'AOT', 'PTTEP', 'KTB', 'KBANK', 'SCB', 'TRUE',
  'CPALL', 'BBL', 'BDMS', 'SCC', 'CPN', 'TTB', 'PTTGC', 'CRC', 'THAI', 'CPF',
  'BH', 'TOP', 'IVL', 'CPAXT', 'OR', 'GPSC', 'TLI', 'SCGP', 'MINT', 'AWC',
  'TISCO', 'KKP', 'CCET', 'BEM', 'KTC', 'KCE', 'TCAP', 'HMPRO', 'RATCH', 'BCP',
  'COM7', 'BJC', 'WHA', 'EGCO', 'SPRC', 'IRPC', 'CENTEL', 'MTC', 'TFG', 'CBG',
  'ITC', 'TU', 'BGRIM', 'OSP', 'TIDLOR', 'GUNKUL', 'HANA', 'BANPU', 'LH', 'BA',
  'TTW', 'BLA', 'BTG', 'RCL', 'AMATA', 'SAWAD', 'GLOBAL', 'STA', 'BTS', 'CK',
  'PLANB', 'SPALI', 'MEGA', 'STGT', 'TOA', 'BCH', 'MBK', 'WHAUP', 'TASCO', 'SIRI',
  'TVO', 'AP', 'AEONTS', 'BAM', 'EA', 'VGI', 'BCPG', 'PRM', 'M', 'ERW',
  'AURA', 'ICHI', 'EPG', 'TPIPL', 'SJWD', 'CHG', 'PR9', 'JMT', 'JMART', 'PSL',
];

// ชื่อย่อ → สัญลักษณ์ Yahoo (PTT → PTT.BK)
export function toThSymbol(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  return c.endsWith('.BK') ? c : `${c}.BK`;
}

// ---------- ค่าตั้งค่าที่ใช้จริงของแต่ละตลาด ----------
// หุ้นอเมริกาใช้ค่าตั้งค่าเดิมทุกตัว (ไม่เปลี่ยนพฤติกรรม)
// หุ้นไทยใช้ค่าเดิมเป็นฐาน แล้วทับเฉพาะค่าที่ผูกกับสกุลเงิน/ตลาด ด้วยค่า th* จากหน้า Settings
export function marketSettings(st, market) {
  if (market !== 'TH') return { ...st, market: 'US', lotSize: 1, cur: '$' };
  const staleSec = st.thMaxQuoteStaleSec ?? 2700;
  return {
    ...st,
    market: 'TH',
    lotSize: MARKETS.TH.lotSize,
    cur: MARKETS.TH.cur,
    accountSize: st.thAccountSize ?? 300_000,
    costPct: st.thCostPct ?? 0.35,
    maxSpreadPct: st.thMaxSpreadPct ?? 0.5,
    maxSpreadTicks: st.thMaxSpreadTicks ?? 2,
    minDollarVolume5m: st.thMinValue5m ?? 300_000,
    maxQuoteStaleSec: staleSec,
    // ข้อมูลช้าอยู่แล้วโดยธรรมชาติ — เตือน "แท่งล่าสุดเก่า" เฉพาะเมื่อเก่ากว่าความช้าปกติ
    haltGapSec: Math.max(st.haltGapSec ?? 420, staleSec + 420),
    atrPctLow: st.thAtrPctLow ?? 1.0,
    atrPctHigh: st.thAtrPctHigh ?? 2.5,
    rsBenchmark: MARKETS.TH.benchmark,
  };
}

// ---------- เปลี่ยนสัญลักษณ์ $ เป็นสกุลเงินของตลาดในข้อความที่คำนวณมาแล้ว ----------
// ข้อความอธิบายทั้งหมด (เหตุผลตกด่าน แผนความเสี่ยง ที่มาของเป้า ฯลฯ) ถูกเขียนด้วย "$" มาตั้งแต่ต้น
// แทนที่จะไล่แก้ทุกบรรทัดใน scoring/levels/trend ให้รับสกุลเงิน ใช้ตัวนี้แปลงผลลัพธ์ของหุ้นไทยที่เดียว
// แปลงเฉพาะ "$" ที่ตามด้วยตัวเลข/เครื่องหมายลบ/วงเล็บ — ไม่แตะข้อความอื่น
const MONEY_RE = /\$(?=[\d\-−(.])/g;

export function localizeText(s, cur) {
  return typeof s === 'string' && cur && cur !== '$' ? s.replace(MONEY_RE, cur) : s;
}

export function localizeCurrency(value, cur) {
  if (!cur || cur === '$') return value;
  const walk = (v) => {
    if (typeof v === 'string') return v.replace(MONEY_RE, cur);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}
