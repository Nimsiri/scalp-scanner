// src/trend.js — ★ v2: ด่านแนวโน้มระยะกลาง (Trend Template แบบ Minervini) + ความแข็งแกร่งเทียบตลาด (RS)
//
// ═══════════════ ทำไมต้องมีไฟล์นี้ ═══════════════
//
// v1 ตัดสินใจจากแท่ง 5 นาทีล้วนๆ: EMA5 ตัด EMA15, %เปลี่ยนแปลงของวัน, RVOL
// ไม่มีที่ไหนเลยที่ถามว่า "หุ้นตัวนี้อยู่ในขาขึ้นหรือขาลงในกรอบใหญ่"
//
// ผลที่เห็นจริงใน data/signals-history.json:
//   AAPL · score 66.7 · ผ่านเป็น "สัญญาณ" · แต่ changePct = −1.23% และ aboveVwap = false
//   → ระบบสั่งให้ซื้อหุ้นที่กำลังลงและอยู่ใต้ VWAP ของวัน
//
// การเบรกแนวต้านในขาลงส่วนใหญ่คือการเด้งที่ล้มเหลว (ไปไม่ถึงเป้าแล้วย้อนกลับ)
// ซึ่งแปลว่าถึงจะชนะก็ชนะน้อย และแพ้บ่อย — ตรงกับอาการ "กำไรต่อไม้น้อย" ที่เจอ
//
// เกณฑ์ 6 ข้อด้านล่างปรับมาจาก Trend Template ของ Mark Minervini
// (ต้นฉบับใช้ 8 ข้อและเข้มกว่านี้ เพราะเขาถือเป็นสัปดาห์-เดือน ไม่ใช่รายวัน)
//
// ═══════════════ ข้อจำกัดที่ต้องพูดตรงๆ ═══════════════
// 1) ต้องมีแท่งรายวันอย่างน้อย ~200 แท่งจึงคำนวณ SMA200 ได้
//    ถ้า provider ให้ไม่พอ ไฟล์นี้จะคืน unavailable:true และ scanner จะถือเป็น "คำเตือน"
//    ไม่ใช่ "ตกด่าน" — เพราะไม่มีข้อมูลไม่เท่ากับข้อมูลแย่ (หลักเดียวกับ News Sentiment)
// 2) RS ที่นี่คำนวณจากผลตอบแทนเทียบดัชนีอ้างอิง ไม่ใช่ IBD RS Rating (ซึ่งเป็นการจัดอันดับ
//    เทียบหุ้นทุกตัวในตลาด — ทำไม่ได้ด้วย API ฟรี) จึงตั้งชื่อว่า rsScore และบอกที่มาไว้ใน UI

import { getDailyBars } from './providers/index.js';
import { sma, atr } from '../indicators.js';

// แคชผลที่คำนวณแล้ว — แท่งรายวันเปลี่ยนวันละครั้ง ไม่ต้องคำนวณใหม่ทุกรอบสแกน
const TREND_TTL_MS = 30 * 60 * 1000; // 30 นาที
const cache = new Map(); // symbol -> { ts, value }

// แคชผลตอบแทนของดัชนีอ้างอิงแยกต่างหาก (ใช้ร่วมกันทุก symbol ในรอบเดียว)
// ★ แยกตามดัชนี — สแกนหุ้นอเมริกา (SPY) กับหุ้นไทย (^SET.BK) ในรอบเดียวกันจะได้ไม่คำนวณสลับกันไปมา
const benchCache = new Map(); // symbol -> { ts, returns }

// ★ แก้บั๊ก: เดิมขอ 260 "วันปฏิทิน" ซึ่งได้แท่งรายวันจริงแค่ ~178 แท่ง (หักเสาร์-อาทิตย์และวันหยุด)
// แต่ SMA200 ต้องมี 200 แท่ง → Trend Template "ตรวจไม่ได้" ทุกตัว และไม่ได้ ATR รายวันด้วย
// ผลคือ stop/เป้าถูกวัดด้วย ATR ของแท่ง 5 นาทีแทน (เป้ากลางแค่ ~0.2%) จนตกด่าน "ระยะถึงเป้าเล็กเกินไป" แทบทุกตัว
// 400 วันปฏิทิน ≈ 275 วันทำการ (อเมริกา) / ≈ 265 วันทำการ (ไทย) — พอสำหรับ SMA200 + ความชัน 20 วัน
const DAILY_LOOKBACK_DAYS = 400;

const RS_WINDOWS = [
  { days: 21, weight: 0.4, label: '1 เดือน' },
  { days: 63, weight: 0.4, label: '3 เดือน' },
  { days: 126, weight: 0.2, label: '6 เดือน' },
];

function pctReturn(closes, days) {
  const n = closes.length;
  if (n <= days) return null;
  const a = closes[n - 1 - days];
  const b = closes[n - 1];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return (b - a) / a;
}

// คำนวณผลตอบแทนของดัชนีอ้างอิง (SPY) ทุกหน้าต่างเวลา
async function getBenchmarkReturns(symbol) {
  const now = Date.now();
  const hit = benchCache.get(symbol);
  if (hit && now - hit.ts < TREND_TTL_MS) {
    return hit.returns;
  }
  try {
    const res = await getDailyBars(symbol, DAILY_LOOKBACK_DAYS);
    const closes = (res?.bars || []).map((b) => b.close).filter(Number.isFinite);
    if (closes.length < 30) return null;
    const returns = {};
    for (const w of RS_WINDOWS) returns[w.days] = pctReturn(closes, w.days);
    benchCache.set(symbol, { ts: now, returns });
    return returns;
  } catch {
    return null; // ไม่มีดัชนีอ้างอิงก็ยังใช้เกณฑ์อื่นได้ แค่ไม่มี RS
  }
}

// แปลงผลตอบแทนส่วนเกิน (เทียบดัชนี) เป็นคะแนน 0-100
// −10% หรือต่ำกว่า → 0 · เท่าดัชนี → 50 · +20% ขึ้นไป → 100 (เส้นตรงเป็นช่วงๆ)
function excessToScore(excess) {
  if (!Number.isFinite(excess)) return null;
  if (excess <= -0.10) return 0;
  if (excess < 0) return 50 + (excess / 0.10) * 50;   // −0.10..0 → 0..50
  if (excess < 0.20) return 50 + (excess / 0.20) * 50; // 0..0.20 → 50..100
  return 100;
}

// ความชันของเส้นค่าเฉลี่ย: เทียบค่าปัจจุบันกับค่าเมื่อ n วันก่อน
function slopePct(series, back) {
  const n = series.length;
  if (n <= back) return null;
  const a = series[n - 1 - back];
  const b = series[n - 1];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return ((b - a) / a) * 100;
}

// สร้างซีรีส์ SMA เต็มความยาว (indicators.sma คืนค่าเดียว จึงต้องวนเอง)
function smaSeries(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * ประเมินแนวโน้มระยะกลางของหุ้นหนึ่งตัว
 * @returns {Promise<object>} ดู field ใน return ด้านล่าง
 */
export async function getTrendContext(symbol, {
  rsBenchmark = 'SPY',
  minRsScore = 60,
  maxOffHighPct = 30,
  minAboveLowPct = 25,
} = {}) {
  const now = Date.now();
  const hit = cache.get(symbol);
  if (hit && now - hit.ts < TREND_TTL_MS) return hit.value;

  let value;
  try {
    const res = await getDailyBars(symbol, DAILY_LOOKBACK_DAYS);
    const bars = res?.bars || [];
    const closes = bars.map((b) => b.close).filter(Number.isFinite);

    if (closes.length < 200) {
      value = {
        unavailable: true,
        reason: `แท่งรายวันไม่พอสำหรับ SMA200 (มี ${closes.length} ต้องมี 200)`,
        source: res?.source || null,
        checks: [], passCount: 0, totalChecks: 6, passTemplate: null, rsScore: null,
        note: 'ไม่มีข้อมูลแนวโน้มระยะกลาง — ถือเป็นคำเตือน ไม่ใช่การตกด่าน',
      };
      cache.set(symbol, { ts: now, value });
      return value;
    }

    const price = closes[closes.length - 1];
    const s50 = smaSeries(closes, 50);
    const s150 = smaSeries(closes, 150);
    const s200 = smaSeries(closes, 200);
    const last = (arr) => arr[arr.length - 1];

    const sma50 = last(s50);
    const sma150 = last(s150);
    const sma200 = last(s200);
    const slope200 = slopePct(s200, 20);
    const slope50 = slopePct(s50, 10);

    // 52 สัปดาห์ ≈ 252 วันทำการ — ใช้เท่าที่มี
    const win = closes.slice(-252);
    const high52 = Math.max(...win);
    const low52 = Math.min(...win);
    const pctOffHigh = high52 > 0 ? ((high52 - price) / high52) * 100 : null;
    const pctAboveLow = low52 > 0 ? ((price - low52) / low52) * 100 : null;

    // ---------- RS เทียบดัชนี ----------
    const bench = await getBenchmarkReturns(rsBenchmark);
    let rsScore = null;
    const rsDetail = [];
    if (bench) {
      let weighted = 0;
      let wSum = 0;
      for (const w of RS_WINDOWS) {
        const rSym = pctReturn(closes, w.days);
        const rBen = bench[w.days];
        if (!Number.isFinite(rSym) || !Number.isFinite(rBen)) continue;
        const excess = (1 + rSym) / (1 + rBen) - 1;
        const sc = excessToScore(excess);
        if (sc == null) continue;
        weighted += sc * w.weight;
        wSum += w.weight;
        rsDetail.push({
          window: w.label,
          symbolPct: rSym * 100,
          benchPct: rBen * 100,
          excessPct: excess * 100,
          score: sc,
        });
      }
      if (wSum > 0) rsScore = weighted / wSum;
    }

    // ---------- ATR รายวัน (ใช้ทั้งในคะแนนและในการลาก stop) ----------
    const dAtrSeries = atr(bars, 14);
    const dailyAtr = dAtrSeries[dAtrSeries.length - 1];
    const dailyAtrPct = Number.isFinite(dailyAtr) && price > 0 ? (dailyAtr / price) * 100 : null;

    // ---------- เกณฑ์ 6 ข้อ ----------
    const checks = [
      {
        key: 'stack',
        label: 'ราคา > SMA50 > SMA150 > SMA200',
        pass: price > sma50 && sma50 > sma150 && sma150 > sma200,
        detail: `ราคา $${price.toFixed(2)} · SMA50 $${sma50.toFixed(2)} · SMA150 $${sma150.toFixed(2)} · SMA200 $${sma200.toFixed(2)}`,
      },
      {
        key: 'sma200Rising',
        label: 'SMA200 ชี้ขึ้น (20 วัน)',
        pass: Number.isFinite(slope200) && slope200 > 0,
        detail: Number.isFinite(slope200) ? `${slope200 >= 0 ? '+' : ''}${slope200.toFixed(2)}% ใน 20 วัน` : 'คำนวณไม่ได้',
      },
      {
        key: 'sma50Rising',
        label: 'SMA50 ชี้ขึ้น (10 วัน)',
        pass: Number.isFinite(slope50) && slope50 > 0,
        detail: Number.isFinite(slope50) ? `${slope50 >= 0 ? '+' : ''}${slope50.toFixed(2)}% ใน 10 วัน` : 'คำนวณไม่ได้',
      },
      {
        key: 'aboveLow',
        label: `สูงกว่าจุดต่ำสุด 52 สัปดาห์ ≥ ${minAboveLowPct}%`,
        pass: Number.isFinite(pctAboveLow) && pctAboveLow >= minAboveLowPct,
        detail: Number.isFinite(pctAboveLow) ? `+${pctAboveLow.toFixed(1)}% จาก $${low52.toFixed(2)}` : 'คำนวณไม่ได้',
      },
      {
        key: 'nearHigh',
        label: `ห่างจุดสูงสุด 52 สัปดาห์ ≤ ${maxOffHighPct}%`,
        pass: Number.isFinite(pctOffHigh) && pctOffHigh <= maxOffHighPct,
        detail: Number.isFinite(pctOffHigh) ? `ต่ำกว่าจุดสูงสุด ${pctOffHigh.toFixed(1)}% ($${high52.toFixed(2)})` : 'คำนวณไม่ได้',
      },
      {
        key: 'rs',
        label: `แข็งกว่าตลาด (RS ≥ ${minRsScore})`,
        // ไม่มีข้อมูล RS → ไม่นับเป็นผ่าน แต่ก็ไม่ทำให้ทั้งชุด unavailable
        pass: Number.isFinite(rsScore) && rsScore >= minRsScore,
        detail: Number.isFinite(rsScore)
          ? `RS ${rsScore.toFixed(0)}/100 เทียบ ${rsBenchmark}` + (rsDetail.length ? ` · ${rsDetail.map((d) => `${d.window} ${d.excessPct >= 0 ? '+' : ''}${d.excessPct.toFixed(1)}%`).join(' · ')}` : '')
          : `ไม่มีข้อมูลดัชนีอ้างอิง (${rsBenchmark})`,
      },
    ];

    const passCount = checks.filter((c) => c.pass).length;

    value = {
      unavailable: false,
      source: res?.source || null,
      price, sma50, sma150, sma200,
      slope200, slope50,
      high52, low52, pctOffHigh, pctAboveLow,
      rsScore, rsDetail, rsBenchmark,
      dailyAtr, dailyAtrPct,
      checks,
      passCount,
      totalChecks: checks.length,
      passTemplate: passCount === checks.length,
      // ประโยคสรุปสำหรับ UI
      summary: `ผ่าน ${passCount}/${checks.length} ข้อ` +
               (Number.isFinite(rsScore) ? ` · RS ${rsScore.toFixed(0)}` : ' · ไม่มี RS') +
               (Number.isFinite(pctOffHigh) ? ` · ต่ำกว่าจุดสูงสุด 52 สัปดาห์ ${pctOffHigh.toFixed(1)}%` : ''),
    };
  } catch (err) {
    value = {
      unavailable: true,
      reason: `ดึงแท่งรายวันไม่ได้: ${err.message}`,
      checks: [], passCount: 0, totalChecks: 6, passTemplate: null, rsScore: null,
      note: 'ไม่มีข้อมูลแนวโน้มระยะกลาง — ถือเป็นคำเตือน ไม่ใช่การตกด่าน',
    };
  }

  cache.set(symbol, { ts: now, value });
  return value;
}

export function clearTrendCache() {
  cache.clear();
  benchCache.clear();
}
