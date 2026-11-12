// market.js — ประเมินภาวะตลาดโดยรวม (regime) จาก SPY และ QQQ เพื่อปรับความเข้มงวดของสัญญาณ
import { getBars } from './datafeed.js';
import { ema, sessionVwap } from './indicators.js';

let cache = null;
let cacheTs = 0;
const REGIME_TTL_MS = 2 * 60 * 1000; // แคชผลลัพธ์ไว้ 2 นาที

// ให้คะแนน symbol เดียว (ใช้กับ SPY, QQQ)
async function scoreSymbol(symbol) {
  const bars = await getBars(symbol, '5m', 5);
  if (!bars || bars.length < 25) {
    return { pts: 0, error: `ข้อมูล ${symbol} ไม่พอสำหรับประเมิน` };
  }

  const closes = bars.map((b) => b.close);
  const vwapSeries = sessionVwap(bars);
  const e20 = ema(closes, 20);

  const last = bars[bars.length - 1];
  const lastVwap = vwapSeries[vwapSeries.length - 1];
  const lastE20 = e20[e20.length - 1];
  const prevE20 = e20.length >= 4 ? e20[e20.length - 4] : null;

  let pts = 0;
  const reasons = [];

  const aboveVwap = lastVwap != null && last.close > lastVwap;
  if (aboveVwap) {
    pts += 2;
    reasons.push('เหนือ VWAP (+2)');
  }

  const e20Up = lastE20 != null && prevE20 != null && lastE20 > prevE20;
  if (e20Up) {
    pts += 1;
    reasons.push('EMA20 ชี้ขึ้น (+1)');
  }

  const prevClose = bars.meta?.previousClose ?? bars.meta?.chartPreviousClose ?? bars[0].close;
  const changePct = prevClose ? ((last.close - prevClose) / prevClose) * 100 : 0;
  if (changePct > 0.25) {
    pts += 1;
    reasons.push(`เปลี่ยนแปลง ${changePct.toFixed(2)}% (+1)`);
  } else if (changePct < -0.5) {
    pts -= 2;
    reasons.push(`เปลี่ยนแปลง ${changePct.toFixed(2)}% (-2)`);
  }

  return { pts, changePct, aboveVwap, e20Up, reasons };
}

// ประเมินภาวะตลาดโดยรวม คืน {regime, scoreAdj, sizeMult, pts, detail}
export async function getRegime() {
  if (cache && Date.now() - cacheTs < REGIME_TTL_MS) return cache;

  const detail = {};
  let totalPts = 0;
  try {
    for (const sym of ['SPY', 'QQQ']) {
      const s = await scoreSymbol(sym);
      detail[sym] = s;
      totalPts += s.pts || 0;
    }
  } catch (err) {
    console.error(`⚠️  ประเมินภาวะตลาด (market regime) ไม่สำเร็จ: ${err.message} — ใช้โหมดระมัดระวังไว้ก่อน`);
  }

  let regime;
  let scoreAdj;
  let sizeMult;
  if (totalPts >= 5) {
    regime = 'RISK-ON';
    scoreAdj = -5;
    sizeMult = 1.0;
  } else if (totalPts >= 2) {
    regime = 'NEUTRAL';
    scoreAdj = 0;
    sizeMult = 0.75;
  } else if (totalPts >= 0) {
    regime = 'CAUTIOUS';
    scoreAdj = 8;
    sizeMult = 0.5;
  } else {
    regime = 'RISK-OFF';
    scoreAdj = 15;
    sizeMult = 0.35;
  }

  const result = { regime, scoreAdj, sizeMult, pts: totalPts, detail };
  cache = result;
  cacheTs = Date.now();
  return result;
}
