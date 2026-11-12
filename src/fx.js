// src/fx.js — ★ v2.1: ประเมินว่า "ตอนนี้ควรแลกเงินหรือยัง" พร้อมแจ้งเตือน
//
// ═══════════════ สิ่งที่ไฟล์นี้ตอบ และสิ่งที่มันตอบไม่ได้ ═══════════════
//
// ตอบได้:   "เรตวันนี้ถูก/แพงแค่ไหน เมื่อเทียบกับที่มันเคยเป็นมาตลอดปีที่ผ่านมา"
//           และ "ถ้าแลกวันนี้เทียบกับแลกที่ค่าเฉลี่ยปีนี้ ต่างกันกี่บาท"
//
// ตอบไม่ได้: "พรุ่งนี้เรตจะขึ้นหรือลง"
//
// เรื่องนี้ต้องพูดให้ชัดตั้งแต่ต้น เพราะอัตราแลกเปลี่ยนเป็นสิ่งที่ใกล้เคียง random walk มาก
// การที่วันนี้อยู่จุดต่ำสุดของปี ไม่ได้แปลว่าพรุ่งนี้จะเด้งขึ้น มันอาจต่ำลงไปอีกก็ได้
//
// แล้วคะแนนนี้มีประโยชน์ตรงไหน?
// ตรงที่การแลกเงินไม่เหมือนการเทรด — คุณ "ต้อง" แลกอยู่แล้วถ้าจะเติมพอร์ตหรือถอนกำไรกลับ
// คำถามจึงไม่ใช่ "แลกดีไหม" แต่เป็น "จะแลกวันไหนในช่วงที่มีให้เลือก"
// และสำหรับคำถามแบบนั้น การรู้ว่าวันนี้อยู่เปอร์เซ็นไทล์ไหนของปี เป็นข้อมูลที่ใช้ได้จริง
//
// ═══════════════ สองทิศทาง ═══════════════
//   BUY_USD  บาท → ดอลลาร์ (เติมพอร์ต)   → อยากได้เรต USD/THB "ต่ำ"
//   SELL_USD ดอลลาร์ → บาท (ถอนกำไรกลับ) → อยากได้เรต USD/THB "สูง"
// คะแนนของสองทิศทางจึงเป็นภาพสะท้อนกัน (ประมาณ 100 − อีกฝั่ง แต่ไม่เป๊ะ เพราะองค์ประกอบ
// "ทิศทางระยะสั้น" ไม่ได้สมมาตร)
//
// ═══════════════ ส่วนต่างของผู้ให้บริการแลกเงิน (สำคัญมาก) ═══════════════
// เรตที่ได้จาก Yahoo/Twelve Data คือ mid-market rate ซึ่ง "ไม่มีใครได้เรตนั้นจริง"
// ธนาคารไทยกิน 0.3-0.8% ร้านแลกเงินอย่าง Superrich แคบกว่า โบรกเกอร์ต่างประเทศก็มีค่าแปลงสกุล
// นี่คือปัญหาเดียวกับ spread ของหุ้นเป๊ะๆ — ถ้าไม่นับเข้าไป ตัวเลขจะสวยเกินจริง
// ไฟล์นี้จึงแสดง "เรตที่คุณน่าจะได้จริง" ควบคู่ไปเสมอ (ตั้ง fxSpreadPct ในหน้า Settings)

import { EventEmitter } from 'node:events';
import { getFxRate } from './providers/index.js';
import { settings, FX_PAIR_RE, FX_MAX_PAIRS } from './settings.js';
import { log } from './logbus.js';
import { readJsonSync, writeJson, appendToArray } from './store.js';

const FX_STATE_FILE = 'fx-alerts.json';
const FX_HISTORY_FILE = 'fx-alerts-history.json';

// ═══════════════ ★ หลายสกุลเงิน ═══════════════
// เฝ้าดูได้หลายคู่พร้อมกัน (settings.fxPairs) — คู่แรกคือ "คู่หลัก" ที่ settings.fxPair ชี้อยู่
// ทุกคู่มีคะแนน การแจ้งเตือน และเรตเป้าที่ตั้งเอง (settings.fxTargets) แยกกัน
// รายการด้านล่างคือสกุลที่ตรวจแล้วว่า Yahoo ให้ประวัติเทียบบาทได้ (ตรงๆ หรือคำนวณผ่าน USD)
export const CURRENCIES = [
  { code: 'USD', name: 'ดอลลาร์สหรัฐ', short: 'ดอลลาร์', symbol: '$' },
  { code: 'EUR', name: 'ยูโร', short: 'ยูโร', symbol: '€' },
  { code: 'JPY', name: 'เยนญี่ปุ่น', short: 'เยน', symbol: '¥' },
  { code: 'GBP', name: 'ปอนด์สเตอร์ลิง', short: 'ปอนด์', symbol: '£' },
  { code: 'CNY', name: 'หยวนจีน', short: 'หยวน', symbol: 'CN¥' },
  { code: 'SGD', name: 'ดอลลาร์สิงคโปร์', short: 'ดอลลาร์สิงคโปร์', symbol: 'S$' },
  { code: 'HKD', name: 'ดอลลาร์ฮ่องกง', short: 'ดอลลาร์ฮ่องกง', symbol: 'HK$' },
  { code: 'AUD', name: 'ดอลลาร์ออสเตรเลีย', short: 'ดอลลาร์ออสเตรเลีย', symbol: 'A$' },
  { code: 'KRW', name: 'วอนเกาหลีใต้', short: 'วอน', symbol: '₩' },
  { code: 'TWD', name: 'ดอลลาร์ไต้หวัน', short: 'ดอลลาร์ไต้หวัน', symbol: 'NT$' },
  { code: 'CHF', name: 'ฟรังก์สวิส', short: 'ฟรังก์', symbol: 'CHF ' },
  { code: 'CAD', name: 'ดอลลาร์แคนาดา', short: 'ดอลลาร์แคนาดา', symbol: 'C$' },
  { code: 'NZD', name: 'ดอลลาร์นิวซีแลนด์', short: 'ดอลลาร์นิวซีแลนด์', symbol: 'NZ$' },
  { code: 'MYR', name: 'ริงกิตมาเลเซีย', short: 'ริงกิต', symbol: 'RM' },
  { code: 'INR', name: 'รูปีอินเดีย', short: 'รูปี', symbol: '₹' },
  { code: 'IDR', name: 'รูเปียห์อินโดนีเซีย', short: 'รูเปียห์', symbol: 'Rp' },
  { code: 'VND', name: 'ดองเวียดนาม', short: 'ดอง', symbol: '₫' },
  { code: 'PHP', name: 'เปโซฟิลิปปินส์', short: 'เปโซ', symbol: '₱' },
  { code: 'LAK', name: 'กีบลาว', short: 'กีบ', symbol: '₭' },
  { code: 'KHR', name: 'เรียลกัมพูชา', short: 'เรียล', symbol: '៛' },
  { code: 'AED', name: 'ดีแรห์มยูเออี', short: 'ดีแรห์ม', symbol: 'AED ' },
  { code: 'THB', name: 'บาท', short: 'บาท', symbol: '฿' },
];
const CURRENCY_BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));
export const currencyInfo = (code) =>
  CURRENCY_BY_CODE.get(code) || { code, name: code, short: code, symbol: `${code} ` };

export { FX_MAX_PAIRS };

// รายการคู่ที่เฝ้าดูอยู่ — คู่หลักอยู่หน้าเสมอ
export function fxPairList(st = settings.all) {
  const list = Array.isArray(st.fxPairs) ? st.fxPairs.filter((p) => FX_PAIR_RE.test(p)) : [];
  return list.length > 0 ? list : [st.fxPair || 'USD/THB'];
}

// เรตเป้าที่ตั้งเองของคู่หนึ่ง (0 = ไม่ใช้)
// ข้อมูลก่อนมีระบบหลายคู่เก็บไว้ที่ fxBuyBelow/fxSellAbove → ใช้เป็นค่าของคู่หลักถ้ายังไม่เคยตั้งแยก
export function fxTargetsFor(pair, st = settings.all) {
  const t = st.fxTargets?.[pair];
  const legacy = pair === st.fxPair;
  return {
    buyBelow: Number.isFinite(t?.buyBelow) ? t.buyBelow : (legacy ? st.fxBuyBelow || 0 : 0),
    sellAbove: Number.isFinite(t?.sellAbove) ? t.sellAbove : (legacy ? st.fxSellAbove || 0 : 0),
  };
}

// จำนวนทศนิยมตามขนาดของเรต — 33.5800 · 0.21120 · 0.024704 · 0.0012929
export function fmtRate(v) {
  if (!Number.isFinite(v)) return '—';
  const d = v > 0 ? Math.min(8, Math.max(4, 4 - Math.floor(Math.log10(v)))) : 4;
  return v.toFixed(d);
}

// ปัดเป็นเลขสวยๆ 3 หลักสำคัญ — ใช้กับจำนวนเงินที่คำนวณขึ้นเอง (เช่น ¥471,000)
function roundSig(v, sig = 3) {
  if (!Number.isFinite(v) || v <= 0) return v;
  const p = 10 ** (Math.floor(Math.log10(v)) - sig + 1);
  return Math.round(v / p) * p;
}

// คีย์ BUY_USD / SELL_USD คงไว้ตามเดิม (API และไฟล์ประวัติใช้อยู่) แต่ความหมายคือ
// "ซื้อสกุลฐาน" และ "ขายสกุลฐานกลับ" ของคู่ใดก็ได้ ป้ายชื่อสร้างตามคู่เงินจริง
export const DIRECTIONS = {
  BUY_USD: { key: 'BUY_USD', want: 'low' },   // อยากได้เรตต่ำ
  SELL_USD: { key: 'SELL_USD', want: 'high' }, // อยากได้เรตสูง
};

function directionMeta(dirKey, base, quote) {
  const b = currencyInfo(base).short;
  const q = currencyInfo(quote).short;
  const usdPortfolio = base === 'USD'; // เดิมระบบมีไว้เติม/ถอนพอร์ตหุ้นอเมริกา
  return dirKey === 'BUY_USD'
    ? { label: `แลก${q} → ${b}`, purpose: usdPortfolio ? 'เติมพอร์ต' : `ซื้อ${b}ไว้ใช้` }
    : { label: `แลก${b} → ${q}`, purpose: usdPortfolio ? 'ถอนกำไรกลับ' : `แลก${b}กลับเป็น${q}` };
}

// ---------- สถิติพื้นฐาน ----------
function percentileOf(sorted, value) {
  // ★ แก้บั๊ก: เดิมนับเฉพาะค่าที่ "น้อยกว่า" อย่างเดียว
  // ช่วงที่เรตนิ่ง ค่าซ้ำกันเยอะ → วันที่เรตเท่าค่ากลางเป๊ะจะได้เปอร์เซ็นไทล์ 0
  // แล้วระบบจะรายงานว่า "ถูกที่สุดในรอบปี" ทั้งที่เป็นค่าปกติที่สุด
  // ที่ถูกคือใช้จุดกึ่งกลางของช่วงที่ค่าซ้ำกัน (midrank)
  if (sorted.length === 0) return null;
  const bound = (cmp) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(sorted[mid])) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const less = bound((v) => v < value);       // จำนวนที่น้อยกว่า
  const lessEq = bound((v) => v <= value);    // จำนวนที่น้อยกว่าหรือเท่ากัน
  return (((less + lessEq) / 2) / sorted.length) * 100;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdev(arr, m) { return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); }

// แปลงค่าให้เป็นคะแนน 0-100 แบบเส้นตรง (clamp ปลายทั้งสอง)
function lin(v, from, to) {
  if (!Number.isFinite(v)) return null;
  const t = (v - from) / (to - from);
  return Math.max(0, Math.min(100, t * 100));
}

/**
 * ประเมินทิศทางเดียว
 * @param {'low'|'high'} want
 */
function scoreDirection(want, ctx) {
  const { rate, pct, z, sma20, sma60, dir5 } = ctx;

  // ── 1) เปอร์เซ็นไทล์ย้อนหลัง 1 ปี (45%) ──
  // ตัวชี้วัดที่ตรงคำถามที่สุด: "วันนี้ถูก/แพงแค่ไหนเทียบกับปีที่ผ่านมา"
  const pctScore = want === 'low' ? lin(pct, 100, 0) : lin(pct, 0, 100);
  const pctWhy = want === 'low'
    ? `เรตอยู่ที่เปอร์เซ็นไทล์ ${pct.toFixed(0)} ของปีที่ผ่านมา — ถูกกว่า ${(100 - pct).toFixed(0)}% ของวันทั้งหมด`
    : `เรตอยู่ที่เปอร์เซ็นไทล์ ${pct.toFixed(0)} ของปีที่ผ่านมา — แพงกว่า ${pct.toFixed(0)}% ของวันทั้งหมด`;

  // ── 2) ระยะห่างจากค่าเฉลี่ย เป็นหน่วยส่วนเบี่ยงเบนมาตรฐาน (30%) ──
  // ต่างจากเปอร์เซ็นไทล์ตรงที่ตัวนี้บอก "ห่างแค่ไหน" ไม่ใช่แค่ "อันดับที่เท่าไหร่"
  // ปีที่เรตนิ่งมาก เปอร์เซ็นไทล์ 5 อาจห่างค่าเฉลี่ยแค่ 0.2% ซึ่งไม่คุ้มจะตื่นเต้น
  const zScore = want === 'low' ? lin(z, 1.5, -1.5) : lin(z, -1.5, 1.5);
  const zWhy = `ห่างจากค่าเฉลี่ย 1 ปี ${z >= 0 ? '+' : ''}${z.toFixed(2)} ส่วนเบี่ยงเบนมาตรฐาน`;

  // ── 3) ทิศทางระยะสั้น (25%) ──
  // องค์ประกอบนี้ตอบคำถาม "หน้าต่างกำลังเปิดหรือกำลังปิด"
  // ถ้าอยากได้เรตต่ำ: อยู่ใต้ SMA20 = ดี (ถูกกว่าค่าเฉลี่ยเดือน)
  //   แต่ถ้า 5 วันล่าสุดกำลัง "ขึ้น" แปลว่าหน้าต่างถูกกำลังจะปิด → เพิ่มความเร่งด่วน
  //   ส่วนถ้ากำลังลงต่อเนื่อง รอได้อีกหน่อย (ไม่ต้องรีบรับมีดที่กำลังตก)
  const belowSma = Number.isFinite(sma20) && rate < sma20;
  const cheapVsMonth = want === 'low' ? belowSma : !belowSma;
  const turningToward = want === 'low' ? dir5 > 0 : dir5 < 0; // ราคากำลังกลับทิศไปทางที่ไม่เอื้อ = หน้าต่างกำลังปิด
  let turnScore = 50;
  if (cheapVsMonth) turnScore += 25;      // อยู่ฝั่งที่ได้เปรียบเทียบกับค่าเฉลี่ยเดือน
  if (turningToward) turnScore += 25;     // และหน้าต่างกำลังจะปิด → ควรรีบ
  if (!cheapVsMonth && !turningToward) turnScore -= 25;
  turnScore = Math.max(0, Math.min(100, turnScore));
  const turnWhy = `${cheapVsMonth ? 'อยู่ฝั่งที่ได้เปรียบเทียบค่าเฉลี่ย 20 วัน' : 'อยู่ฝั่งที่เสียเปรียบเทียบค่าเฉลี่ย 20 วัน'}` +
    ` · 5 วันล่าสุด ${dir5 >= 0 ? 'ขยับขึ้น' : 'ขยับลง'} ${Math.abs(dir5).toFixed(2)}%` +
    (turningToward ? ' — หน้าต่างกำลังปิด' : ' — ยังพอมีเวลา');

  const factors = [
    { key: 'percentile', label: 'เปอร์เซ็นไทล์ 1 ปี', weight: 45, score: pctScore, raw: `${pct.toFixed(1)}%`, why: pctWhy },
    { key: 'zscore', label: 'ระยะห่างจากค่าเฉลี่ย', weight: 30, score: zScore, raw: `${z >= 0 ? '+' : ''}${z.toFixed(2)} SD`, why: zWhy },
    { key: 'turn', label: 'ทิศทางระยะสั้น', weight: 25, score: turnScore, raw: `${dir5 >= 0 ? '+' : ''}${dir5.toFixed(2)}% / 5 วัน`, why: turnWhy },
  ];

  let total = factors.reduce((a, f) => a + f.score * (f.weight / 100), 0);

  // ★ ช่วงทั้งปีแคบมาก = ไม่มีความต่างที่มีความหมายระหว่างวันไหนๆ
  // ดึงคะแนนเข้าหา 50 เพื่อไม่ให้ระบบเชียร์ให้แลกจากสัญญาณรบกวนทศนิยม
  if (ctx.narrowRange) total = 50 + (total - 50) * 0.25;

  return {
    score: Math.round(total * 10) / 10,
    narrowRange: !!ctx.narrowRange,
    factors,
    topReason: [...factors].sort((a, b) => b.score * b.weight - a.score * a.weight)[0]?.why || '',
  };
}

/**
 * ประเมินสถานการณ์ค่าเงินทั้งหมด
 * @returns {Promise<object>}
 */
export async function evaluateFx(pair = fxPairList()[0]) {
  const st = settings.all;

  const data = await getFxRate(pair, 400);
  // ★ แก้บั๊ก: เดิมกรองแค่ Number.isFinite ซึ่งปล่อยให้ 0 และค่าติดลบผ่านมาได้
  // provider คืน 0 ได้จริงเมื่อข้อมูลวันนั้นขาด และค่าเดียวก็พอทำให้
  // ค่าเฉลี่ย/ส่วนเบี่ยงเบน/จุดต่ำสุดเพี้ยนทั้งชุด แล้วคะแนนก็ผิดตามทั้งหมด
  const rawHist = data.history || [];
  const hist = rawHist.filter((h) => Number.isFinite(h.rate) && h.rate > 0);
  const droppedBadRates = rawHist.length - hist.length;

  if (!Number.isFinite(data.rate) || data.rate <= 0) {
    throw new Error(`เรต ${pair} ที่ได้มาใช้ไม่ได้ (${data.rate}) — provider อาจส่งข้อมูลว่างมา`);
  }
  if (hist.length < 60) {
    throw new Error(`ประวัติค่าเงิน ${pair} ไม่พอสำหรับคำนวณสถิติ (มี ${hist.length} วัน ต้องมีอย่างน้อย 60)`);
  }

  const rate = data.rate;
  const [baseCur, quoteCur] = pair.split('/');
  const baseInfo = currencyInfo(baseCur);
  const quoteInfo = currencyInfo(quoteCur);
  const money = (info, v, digits = 2) =>
    `${info.symbol}${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

  // หน้าต่างสถิติ: 1 ปีทำการ ≈ 252 วัน แต่ค่าเงินซื้อขายเกือบทุกวัน จึงใช้ 365
  const windowDays = Math.min(st.fxLookbackDays || 365, hist.length);
  const win = hist.slice(-windowDays).map((h) => h.rate);
  const sorted = [...win].sort((a, b) => a - b);

  const m = mean(win);
  const sd = stdev(win, m);
  const pct = percentileOf(sorted, rate);
  const z = sd > 0 ? (rate - m) / sd : 0;
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];

  const last20 = hist.slice(-20).map((h) => h.rate);
  const last60 = hist.slice(-60).map((h) => h.rate);
  const sma20 = last20.length ? mean(last20) : null;
  const sma60 = last60.length ? mean(last60) : null;

  const ref5 = hist.length > 5 ? hist[hist.length - 6].rate : rate;
  const dir5 = ref5 > 0 ? ((rate - ref5) / ref5) * 100 : 0;

  // ★ แก้บั๊ก: ถ้าเรตทั้งปีแทบไม่ขยับ สถิติจะไร้ความหมาย
  // ส่วนเบี่ยงเบนที่เกือบเป็นศูนย์ทำให้ z-score ระเบิด (เคยเจอ −4.16 SD จากการขยับ 0.2%)
  // และเปอร์เซ็นไทล์ก็กระโดดจาก 0 ไป 100 ด้วยการขยับทศนิยมตัวท้าย
  // กรณีแบบนี้ต้องบอกว่า "ไม่มีอะไรให้ตัดสิน" ไม่ใช่ให้คะแนนสูงๆ แล้วปล่อยให้เข้าใจผิด
  const rangePct = m > 0 ? ((hi - lo) / m) * 100 : 0;
  const narrowRange = rangePct < (st.fxMinRangePct ?? 1.0);

  const ctx = { rate, pct, z, sma20, sma60, dir5, narrowRange };

  // ---------- ส่วนต่างของผู้ให้บริการ ----------
  // เรตกลางที่ได้มาไม่ใช่เรตที่ใครได้จริง — ซื้อดอลลาร์แพงกว่ากลาง ขายดอลลาร์ถูกกว่ากลาง
  const spreadPct = Number.isFinite(st.fxSpreadPct) ? st.fxSpreadPct : 0.5;
  const effBuyUsd = rate * (1 + spreadPct / 100);   // จ่ายบาทมากกว่าเรตกลางเพื่อได้ 1 ดอลลาร์
  const effSellUsd = rate * (1 - spreadPct / 100);  // ได้บาทน้อยกว่าเรตกลางเมื่อขาย 1 ดอลลาร์

  // ---------- คะแนนทั้งสองทิศทาง ----------
  const targets = fxTargetsFor(pair, st);
  const results = {};
  for (const dir of Object.values(DIRECTIONS)) {
    const sc = scoreDirection(dir.want, ctx);

    // เทียบเป็นเงินจริง — ตัวเลขที่มีความหมายที่สุดของทั้งหน้า
    // "ถ้าแลกจำนวนนี้วันนี้ เทียบกับแลกที่ค่าเฉลี่ย 1 ปี ต่างกันกี่บาท"
    // งบฝั่งซื้อ (fxBuyAmountThb) เป็นเงินบาท → ใช้ได้กับทุกคู่ที่เทียบบาท
    // งบฝั่งขาย (fxSellAmountUsd) เป็นดอลลาร์ → ใช้ตรงๆ เฉพาะคู่ USD
    //   สกุลอื่นใช้ "มูลค่าเท่ากับงบฝั่งซื้อ" แทน เช่น งบ ฿100,000 → ¥471,000
    let amountNote = null;
    let diffVsMean = null;
    if (dir.key === 'BUY_USD') {
      const budget = quoteCur === 'THB' ? st.fxBuyAmountThb : null;
      if (Number.isFinite(budget) && budget > 0) {
        const baseNow = budget / effBuyUsd;
        const baseAtMean = budget / (m * (1 + spreadPct / 100));
        const dp = rate < 1 ? 0 : 2; // สกุลหน่วยเล็ก (เยน วอน ดอง) ไม่ต้องมีทศนิยม
        diffVsMean = baseNow - baseAtMean;
        amountNote = `แลก ${money(quoteInfo, budget, 0)} วันนี้ได้ ${money(baseInfo, baseNow, dp)} ` +
          `(ที่ค่าเฉลี่ย 1 ปีจะได้ ${money(baseInfo, baseAtMean, dp)} — ${diffVsMean >= 0 ? 'ดีกว่า' : 'แย่กว่า'} ${money(baseInfo, Math.abs(diffVsMean), dp)})`;
      }
    } else {
      let amountBase = null;
      if (baseCur === 'USD') amountBase = st.fxSellAmountUsd;
      else if (quoteCur === 'THB' && st.fxBuyAmountThb > 0) amountBase = roundSig(st.fxBuyAmountThb / m);
      if (Number.isFinite(amountBase) && amountBase > 0) {
        const quoteNow = amountBase * effSellUsd;
        const quoteAtMean = amountBase * (m * (1 - spreadPct / 100));
        diffVsMean = quoteNow - quoteAtMean;
        amountNote = `แลก ${money(baseInfo, amountBase, 0)} วันนี้ได้ ${money(quoteInfo, quoteNow, 0)} ` +
          `(ที่ค่าเฉลี่ย 1 ปีจะได้ ${money(quoteInfo, quoteAtMean, 0)} — ${diffVsMean >= 0 ? 'ดีกว่า' : 'แย่กว่า'} ${money(quoteInfo, Math.abs(diffVsMean), 0)})`;
      }
    }

    // ---------- เรตเป้าที่ตั้งเอง (แยกตามคู่เงิน) ----------
    const manual = dir.key === 'BUY_USD' ? targets.buyBelow : targets.sellAbove;
    const manualHit = Number.isFinite(manual) && manual > 0
      ? (dir.key === 'BUY_USD' ? rate <= manual : rate >= manual)
      : false;

    results[dir.key] = {
      ...dir,
      ...directionMeta(dir.key, baseCur, quoteCur),
      score: sc.score,
      factors: sc.factors,
      topReason: sc.topReason,
      effectiveRate: dir.key === 'BUY_USD' ? effBuyUsd : effSellUsd,
      manualTarget: Number.isFinite(manual) && manual > 0 ? manual : null,
      manualHit,
      manualDistancePct: Number.isFinite(manual) && manual > 0 ? ((manual - rate) / rate) * 100 : null,
      scoreHit: sc.score >= (st.fxScoreThreshold ?? 75),
      amountNote,
      diffVsMean,
    };
  }

  return {
    pair, baseCur, quoteCur,
    baseInfo, quoteInfo,
    rate,
    effBuyUsd,
    effSellUsd,
    spreadPct,
    ts: data.ts,
    source: data.source,
    crossVia: data.crossVia || null,
    narrowRange,
    rangePct,
    droppedBadRates,
    stats: {
      windowDays: win.length,
      mean: m,
      stdev: sd,
      percentile: pct,
      z,
      low: lo,
      high: hi,
      sma20, sma60,
      dir5,
      pctFromLow: lo > 0 ? ((rate - lo) / lo) * 100 : null,
      pctFromHigh: hi > 0 ? ((rate - hi) / hi) * 100 : null,
    },
    // เส้นกราฟย่อสำหรับวาดในการ์ด (ย่อเหลือ ~90 จุด ไม่ต้องส่งทั้ง 400 วัน)
    spark: sampleSpark(hist, 90),
    directions: results,
    // คำเตือนที่ต้องติดไปกับข้อมูลเสมอ
    disclaimer: 'คะแนนบอกว่าเรตวันนี้ถูก/แพงแค่ไหนเทียบกับปีที่ผ่านมา ไม่ใช่การพยากรณ์ว่าพรุ่งนี้จะขึ้นหรือลง',
    warnings: [
      ...(narrowRange ? [`เรตทั้งช่วง ${win.length} วันขยับแค่ ${rangePct.toFixed(2)}% — แคบเกินกว่าจะบอกได้ว่าวันไหนคุ้มกว่าวันไหน คะแนนถูกดึงเข้าหากลางแล้ว`] : []),
      ...(droppedBadRates > 0 ? [`ตัดข้อมูล ${droppedBadRates} วันที่เรตเป็น 0 หรือติดลบออก (provider ส่งข้อมูลขาด)`] : []),
    ],
    checkedAt: new Date().toISOString(),
  };
}

function sampleSpark(hist, points) {
  if (hist.length <= points) return hist.map((h) => h.rate);
  const step = hist.length / points;
  const out = [];
  for (let i = 0; i < points; i++) out.push(hist[Math.floor(i * step)].rate);
  out[out.length - 1] = hist[hist.length - 1].rate;
  return out;
}

// ═══════════════════ ตัวเฝ้าดูและแจ้งเตือน ═══════════════════
//
// ค่าเงินขยับช้ากว่าหุ้นมาก จึงมีรอบตรวจของตัวเองแยกจากรอบสแกนหุ้น (ค่าเริ่มต้น 15 นาที)
// และมี cooldown รายวัน เพราะถ้าเตือนทุกรอบตอนเรตค้างอยู่ใต้เป้า คุณจะปิดการแจ้งเตือนทิ้งภายในวันเดียว

export class FxWatcher extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._results = new Map(); // pair → { data, error }
    const saved = readJsonSync(FX_STATE_FILE, null);
    this._state = saved && typeof saved === 'object' ? saved : {};

    // ย้ายสถานะการเตือนแบบเดิม (คีย์ BUY_USD/SELL_USD ตอนมีคู่เดียว) ไปเป็นของคู่หลัก
    // ไม่งั้นทิศที่เพิ่งเตือนไปวันนี้จะถูกนับเป็นยังไม่เคยเตือน แล้วเตือนซ้ำ
    const primary = fxPairList()[0];
    for (const key of Object.keys(DIRECTIONS)) {
      if (this._state[key]) {
        this._state[`${primary}:${key}`] ??= this._state[key];
        delete this._state[key];
      }
    }
  }

  // data / error = ของคู่หลัก (รูปแบบเดิม ให้โค้ดที่อ่านคู่เดียวยังใช้ได้)
  // byPair = ทุกคู่ที่เฝ้าดูอยู่ · pairs = ลำดับที่แสดง · currencies = สกุลที่เลือกเพิ่มได้
  getLast() {
    const pairs = fxPairList();
    const byPair = {};
    for (const p of pairs) {
      const r = this._results.get(p);
      byPair[p] = { data: r?.data ?? null, error: r?.error ?? null };
    }
    return {
      data: byPair[pairs[0]].data,
      error: byPair[pairs[0]].error,
      pairs,
      byPair,
      currencies: CURRENCIES,
      maxPairs: FX_MAX_PAIRS,
      alertState: this._state,
      running: this._timer !== null,
    };
  }

  start() {
    this.stop();
    // ลืมผลของคู่ที่ถูกเอาออกจากรายการแล้ว
    const pairs = new Set(fxPairList());
    for (const p of this._results.keys()) if (!pairs.has(p)) this._results.delete(p);

    if (!settings.get('fxEnabled')) return;
    const sec = Math.max(60, settings.get('fxPollSec') || 900);
    // ตรวจทันทีหนึ่งครั้ง แล้วค่อยตั้งรอบ
    this.checkNow().catch(() => { /* บันทึกไว้ใน _results แล้ว */ });
    this._timer = setInterval(() => {
      this.checkNow().catch(() => { /* เช่นกัน */ });
    }, sec * 1000);
    // ไม่ให้ timer นี้กัน process ไม่ให้ปิด (สำคัญสำหรับ smoke test และการปิดโปรแกรม)
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ระบุ pair = ตรวจคู่เดียว · ไม่ระบุ = ตรวจทุกคู่ทีละคู่ (ไม่ยิงพร้อมกันเพื่อไม่ให้โดน rate limit)
  // คืนข้อมูลของคู่ที่ขอ หรือของคู่หลักเมื่อตรวจทั้งหมด — throw ถ้าคู่นั้นดึงไม่สำเร็จ
  async checkNow(pair = null) {
    const pairs = pair ? [pair] : fxPairList();
    let firstErr = null;
    let firstData = null;
    for (const p of pairs) {
      try {
        const data = await this._checkPair(p);
        if (p === pairs[0]) firstData = data;
      } catch (err) {
        if (p === pairs[0]) firstErr = err;
      }
    }
    if (firstErr) throw firstErr;
    return firstData;
  }

  async _checkPair(pair) {
    try {
      const data = await evaluateFx(pair);
      this._results.set(pair, { data, error: null });
      await this._maybeAlert(data);
      this.emit('update', data);
      return data;
    } catch (err) {
      this._results.set(pair, { data: null, error: err.message });
      this.emit('error', err.message, pair);
      throw err;
    }
  }

  // ---------- ตัดสินว่าจะเตือนไหม ----------
  async _maybeAlert(data) {
    const st = settings.all;
    const todayKey = new Date().toISOString().slice(0, 10);

    for (const dir of Object.values(data.directions)) {
      const stateKey = `${data.pair}:${dir.key}`; // สถานะการเตือนแยกตามคู่เงิน
      const enabled = dir.key === 'BUY_USD' ? st.fxAlertBuy : st.fxAlertSell;
      if (!enabled) continue;

      const reasons = [];
      if (dir.manualHit) {
        reasons.push(dir.key === 'BUY_USD'
          ? `${data.pair} ลงมาถึง ${fmtRate(data.rate)} ซึ่งต่ำกว่าเป้าที่ตั้งไว้ (${fmtRate(dir.manualTarget)})`
          : `${data.pair} ขึ้นถึง ${fmtRate(data.rate)} ซึ่งสูงกว่าเป้าที่ตั้งไว้ (${fmtRate(dir.manualTarget)})`);
      }
      // ★ ช่วงแคบเกินไป → ไม่ส่งการเตือนที่มาจากคะแนน (เรตเป้าที่ตั้งเองยังเตือนตามปกติ)
      if (dir.scoreHit && !data.narrowRange) {
        reasons.push(`คะแนนความคุ้ม ${dir.score.toFixed(0)}/100 ถึงเกณฑ์ ${st.fxScoreThreshold}`);
      }

      // เรตเป้าที่ตั้งเองเป็นคำสั่งของคุณ — ระบบเตือนตามนั้นเสมอ แม้สถิติจะไม่เห็นด้วย
      // แต่ต้องบอกให้รู้ว่ามันไม่เห็นด้วย ไม่ใช่เงียบแล้วปล่อยให้เข้าใจว่าเป็นจังหวะดี
      if (dir.manualHit && !dir.scoreHit) {
        reasons.push(
          `⚠️ แต่คะแนนความคุ้มอยู่แค่ ${dir.score.toFixed(0)}/100 — ` +
          `เรตอยู่ที่เปอร์เซ็นไทล์ ${data.stats.percentile.toFixed(0)} ของปีที่ผ่านมา ` +
          'สถิติไม่เห็นด้วยกับเป้าที่ตั้งไว้ (เตือนเพราะคุณสั่ง ไม่ใช่เพราะเป็นจังหวะดี)'
        );
      }
      if (reasons.length === 0) {
        // หลุดออกจากเงื่อนไขแล้ว → เคลียร์สถานะ เพื่อให้เตือนใหม่ได้เมื่อกลับเข้าเงื่อนไขอีกครั้ง
        if (this._state[stateKey]?.armed === false) {
          this._state[stateKey] = { ...this._state[stateKey], armed: true };
          await writeJson(FX_STATE_FILE, this._state);
        }
        continue;
      }

      const prev = this._state[stateKey] || { armed: true, lastDate: null };

      // กันเตือนซ้ำ 2 ชั้น:
      //   1) armed — เตือนไปแล้วและเรตยังอยู่ในเงื่อนไขเดิม ไม่เตือนซ้ำจนกว่าจะหลุดออกแล้วกลับเข้ามาใหม่
      //   2) lastDate — เตือนทิศทางละไม่เกิน 1 ครั้งต่อวัน ถึงจะหลุดเข้าหลุดออกหลายรอบก็ตาม
      if (prev.armed === false) continue;
      if (prev.lastDate === todayKey) continue;

      const entry = {
        ts: new Date().toISOString(),
        direction: dir.key,
        label: dir.label,
        purpose: dir.purpose,
        pair: data.pair,
        rate: data.rate,
        effectiveRate: dir.effectiveRate,
        score: dir.score,
        manualTarget: dir.manualTarget,
        percentile: data.stats.percentile,
        reasons,
        amountNote: dir.amountNote,
        topReason: dir.topReason,
        disclaimer: data.disclaimer,
      };

      this._state[stateKey] = { armed: false, lastDate: todayKey, triggeredAt: entry.ts, rate: data.rate };
      await writeJson(FX_STATE_FILE, this._state);
      await appendToArray(FX_HISTORY_FILE, entry, 500);

      log.success(
        `💱 ${dir.label} — ${data.pair} ${fmtRate(data.rate)} · คะแนน ${dir.score.toFixed(0)}/100 · ` +
        reasons.join(' · ')
      );
      this.emit('alert', entry);
    }
  }

  // pair + ทิศ = ล้างทิศเดียวของคู่นั้น · pair อย่างเดียว = ทั้งคู่ · ทิศอย่างเดียว = ทิศนั้นของทุกคู่ · ไม่ระบุ = ทั้งหมด
  async resetAlert(directionKey = null, pair = null) {
    for (const key of Object.keys(this._state)) {
      const [p, dir] = key.split(':');
      if ((!pair || p === pair) && (!directionKey || dir === directionKey)) delete this._state[key];
    }
    await writeJson(FX_STATE_FILE, this._state);
    return this._state;
  }

  async getHistory(limit = 100) {
    const all = readJsonSync(FX_HISTORY_FILE, []) || [];
    return all.slice(-limit).reverse();
  }
}

export const fxWatcher = new FxWatcher();
