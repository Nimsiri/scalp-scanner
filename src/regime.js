// src/regime.js — ประเมินภาวะตลาดโดยรวม (market regime)
//   หุ้นอเมริกา: SPY + QQQ · ★ หุ้นไทย: ดัชนี SET + SET50
//
// ย้ายมาจาก market.js เดิม แต่เปลี่ยนให้ใช้ provider registry ตัวใหม่
// จึงได้ประโยชน์จาก fallback หลายแหล่ง + cache + โหมดข้อมูลจำลอง
// (market.js เดิมยังอยู่ ไม่ได้ลบ — monitor.js โหมด CLI ยังใช้ตัวเดิมได้)
//
// ภาวะตลาดใช้ปรับ 2 อย่าง:
//   scoreAdj  — ปรับเกณฑ์คะแนนที่ถือว่าเป็นสัญญาณ (ตลาดแย่ = ต้องคะแนนสูงขึ้นจึงจะนับ)
//   sizeMult  — ปรับขนาดไม้ (ตลาดแย่ = ลดขนาดไม้ลง)

import { getBars } from './providers/index.js';
import { ema, sessionVwap, sessionTwap } from '../indicators.js';
import { log } from './logbus.js';
import { MARKETS } from './markets.js';
import { marketTz } from './market-hours.js';

const cache = new Map(); // market -> { value, ts } — ★ แยกตามตลาด
const TTL_MS = 2 * 60 * 1000; // แคช 2 นาที (ภาวะตลาดไม่เปลี่ยนเร็วขนาดนั้น)

// ให้คะแนนดัชนี 1 ตัว
async function scoreIndex(symbol, tz) {
  const res = await getBars(symbol, '5m', 5);
  const bars = res?.bars;
  if (!bars || bars.length < 25) {
    return { symbol, pts: 0, error: `ข้อมูล ${symbol} ไม่พอสำหรับประเมิน (มี ${bars?.length || 0} แท่ง)`, reasons: [] };
  }

  const closes = bars.map((b) => b.close);
  const vwapSeries = sessionVwap(bars, tz);
  const e20 = ema(closes, 20);

  const last = bars[bars.length - 1];
  let lastVwap = vwapSeries[vwapSeries.length - 1];
  let avgName = 'VWAP';
  // ★ ดัชนีที่ไม่มีวอลุ่ม (SET/SET50 บน Yahoo) → ใช้ราคาเฉลี่ยของวันแบบเท่ากันทุกแท่งแทน
  //    ไม่งั้นข้อนี้ได้ 0 เสมอ และภาวะตลาดไทยจะขึ้น RISK-ON ไม่ได้เลย
  if (!Number.isFinite(lastVwap)) {
    const twap = sessionTwap(bars, tz);
    lastVwap = twap[twap.length - 1];
    avgName = 'ราคาเฉลี่ยของวัน';
  }
  const lastE20 = e20[e20.length - 1];
  const prevE20 = e20.length >= 4 ? e20[e20.length - 4] : null;

  let pts = 0;
  const reasons = [];

  // 1) อยู่เหนือ VWAP = ฝ่ายซื้อคุมเกม (+2)
  if (Number.isFinite(lastVwap) && last.close > lastVwap) {
    pts += 2;
    reasons.push(`เหนือ ${avgName} (+2)`);
  } else if (Number.isFinite(lastVwap)) {
    reasons.push(`ต่ำกว่า ${avgName} (0)`);
  }

  // 2) EMA20 ชี้ขึ้น = แนวโน้มสั้นยังขึ้น (+1)
  if (Number.isFinite(lastE20) && Number.isFinite(prevE20) && lastE20 > prevE20) {
    pts += 1;
    reasons.push('EMA20 ชี้ขึ้น (+1)');
  }

  // 3) %เปลี่ยนแปลงวันนี้
  const prevClose = res.meta?.previousClose ?? bars[0].close;
  const changePct = prevClose > 0 ? ((last.close - prevClose) / prevClose) * 100 : 0;
  if (changePct > 0.25) {
    pts += 1;
    reasons.push(`เปลี่ยนแปลง ${changePct.toFixed(2)}% (+1)`);
  } else if (changePct < -0.5) {
    pts -= 2;
    reasons.push(`เปลี่ยนแปลง ${changePct.toFixed(2)}% (-2)`);
  } else {
    reasons.push(`เปลี่ยนแปลง ${changePct.toFixed(2)}% (0)`);
  }

  return { symbol, pts, changePct, reasons, source: res.source };
}

export async function getRegime({ force = false, market = 'US' } = {}) {
  const m = MARKETS[market] ? market : 'US';
  const hit = cache.get(m);
  if (!force && hit && Date.now() - hit.ts < TTL_MS) return hit.value;

  const symbols = MARKETS[m].regimeSymbols;
  const tz = marketTz(m);
  const detail = {};
  let totalPts = 0;
  let ok = 0;

  for (const sym of symbols) {
    try {
      const s = await scoreIndex(sym, tz);
      detail[sym] = s;
      totalPts += s.pts || 0;
      if (!s.error) ok += 1;
    } catch (err) {
      detail[sym] = { symbol: sym, pts: 0, error: err.message, reasons: [] };
      log.warn(`ประเมินภาวะตลาดจาก ${sym} ไม่สำเร็จ: ${err.message}`);
    }
  }

  const names = symbols.map((s) => s.replace(/^\^/, '').replace(/\.BK$/, '')).join('/');

  // ประเมินไม่ได้เลย → ใช้โหมดระมัดระวังไว้ก่อน (ไม่ใช่ปล่อยผ่านแบบ RISK-ON)
  if (ok === 0) {
    const result = {
      market: m,
      regime: 'UNKNOWN',
      label: 'ประเมินไม่ได้',
      scoreAdj: 8,
      sizeMult: 0.5,
      pts: 0,
      detail,
      note: `ดึงข้อมูล ${names} ไม่ได้ — ใช้โหมดระมัดระวังไว้ก่อน (ลดขนาดไม้ 50% และเพิ่มเกณฑ์คะแนน 8)`,
    };
    cache.set(m, { value: result, ts: Date.now() });
    return result;
  }

  let regime, label, scoreAdj, sizeMult, note;
  if (totalPts >= 5) {
    regime = 'RISK-ON'; label = 'ตลาดเอื้อ';
    scoreAdj = -5; sizeMult = 1.0;
    note = 'ดัชนีหลักแข็งแรงทั้งคู่ — ลดเกณฑ์คะแนนลง 5 และใช้ขนาดไม้เต็ม';
  } else if (totalPts >= 2) {
    regime = 'NEUTRAL'; label = 'ตลาดกลางๆ';
    scoreAdj = 0; sizeMult = 0.75;
    note = 'ดัชนีไม่ชัดทาง — ใช้เกณฑ์ปกติ ลดขนาดไม้เหลือ 75%';
  } else if (totalPts >= 0) {
    regime = 'CAUTIOUS'; label = 'ควรระมัดระวัง';
    scoreAdj = 8; sizeMult = 0.5;
    note = 'ดัชนีอ่อนแรง — เพิ่มเกณฑ์คะแนน 8 และลดขนาดไม้เหลือ 50%';
  } else {
    regime = 'RISK-OFF'; label = 'ตลาดไม่เอื้อ';
    scoreAdj = 15; sizeMult = 0.35;
    note = 'ดัชนีติดลบชัดเจน — เพิ่มเกณฑ์คะแนน 15 และลดขนาดไม้เหลือ 35%';
  }

  const result = { market: m, regime, label, scoreAdj, sizeMult, pts: totalPts, detail, note };
  cache.set(m, { value: result, ts: Date.now() });
  return result;
}

export function clearRegimeCache() { cache.clear(); }
