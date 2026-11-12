// src/settings.js — ศูนย์รวมค่าตั้งค่าที่แก้ผ่านหน้าเว็บได้
// ลำดับความสำคัญ: data/settings.json  >  .env  >  ค่า default ในไฟล์นี้
// ทุกครั้งที่ user กด Save ในหน้า Settings จะเขียนลง data/settings.json
// แล้ว emit event 'change' ให้ scanner รู้ว่าต้องใช้ค่าใหม่ (ไม่ต้องรีสตาร์ท server)

import 'dotenv/config';
import { EventEmitter } from 'node:events';
import { readJsonSync, writeJson } from './store.js';
import { TH_UNIVERSE_DEFAULT } from './markets.js'; // ★ หุ้นไทย

const SETTINGS_FILE = 'settings.json';

// ★ ค่าเงินหลายคู่ — ใช้ร่วมกับ src/fx.js
export const FX_PAIR_RE = /^[A-Z]{3}\/[A-Z]{3}$/;
export const FX_MAX_PAIRS = 8;

// ทำให้ fxPair / fxPairs / fxTargets สอดคล้องกันเสมอ
//   - fxPairs ต้องไม่ว่าง และคู่แรกคือ fxPair
//   - ไฟล์ตั้งค่าจากก่อนมีระบบหลายคู่: มีแค่ fxPair → ใช้เป็นรายการคู่เดียว
//   - เรตเป้าแบบเดิม (fxBuyBelow/fxSellAbove) → ย้ายเข้า fxTargets ของคู่หลัก
function normalizeFx(d, saved) {
  const hadPairs = Array.isArray(saved?.fxPairs) && saved.fxPairs.length > 0;
  let pairs = (hadPairs ? saved.fxPairs : [saved?.fxPair || d.fxPair || 'USD/THB'])
    .map((p) => String(p).trim().toUpperCase())
    .filter((p, i, arr) => FX_PAIR_RE.test(p) && arr.indexOf(p) === i)
    .slice(0, FX_MAX_PAIRS);
  if (pairs.length === 0) pairs = ['USD/THB'];
  d.fxPairs = pairs;
  d.fxPair = pairs[0];

  if (!d.fxTargets || typeof d.fxTargets !== 'object' || Array.isArray(d.fxTargets)) d.fxTargets = {};
  if (!d.fxTargets[d.fxPair] && (d.fxBuyBelow > 0 || d.fxSellAbove > 0)) {
    d.fxTargets = { ...d.fxTargets, [d.fxPair]: { buyBelow: d.fxBuyBelow || 0, sellAbove: d.fxSellAbove || 0 } };
  }
  return d;
}

// ---------- helper อ่าน .env ----------
function envNum(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}
function envBool(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const s = raw.trim().toLowerCase();
  return s === 'true' || s === '1';
}
function envList(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------- ค่า default ทั้งหมด ----------
// เริ่มจาก .env (เพื่อให้คนที่ตั้ง .env ไว้แล้วไม่ต้องตั้งใหม่) แล้วให้ settings.json ทับได้
function buildDefaults() {
  return {
    // ===== รอบการทำงาน =====
    scanIntervalSec: Math.round(envNum('POLL_MS', 60_000) / 1000), // วินาที/รอบ
    session: process.env.SESSION || 'regular', // regular | pre | post | all
    timeframes: envList('TIMEFRAMES', ['5m', '15m']),

    // ===== เงินทุน / ความเสี่ยง =====
    accountSize: envNum('ACCOUNT_SIZE', 10_000),
    riskPct: envNum('RISK_PCT', 1),
    // ⚠️ ค่า default เปลี่ยนจาก 1.5 → 1.0 เพราะ 1.5 เป็นค่าแบบ day trade
    // ทำให้ stop กว้างเกินไปสำหรับ scalping และ R:R ไม่มีทางถึง 1:1.5
    // (ดูคำอธิบายเต็มใน src/scoring.js ฟังก์ชัน riskReward)
    atrStopMult: envNum('ATR_STOP_MULT', 1.0),
    minStopAtr: envNum('MIN_STOP_ATR', 0.35),   // ระยะ stop ขั้นต่ำ (กันสัญญาณรบกวน)
    targetExtAtr: envNum('TARGET_EXT_ATR', 1.0), // ขยายเป้าเลยแนวต้านกี่เท่าของ ATR
    minRR: envNum('MIN_RR', 1.5), // กรองสัญญาณที่ R:R ต่ำกว่านี้ออก (ข้อ 6)

    // ═══════════ ★ v2: คณิตศาสตร์ความเสี่ยง (แก้อาการ "กำไรต่อไม้น้อย") ═══════════
    // สาเหตุที่พบจาก data/signals-history.json จริง: stop = 0.35 × ATR(5m) = 0.21% ของราคา
    // ทำให้ทั้งไม้ (stop ถึงเป้า) อยู่ในระยะ 0.2-0.6% ซึ่งเล็กกว่าสัญญาณรบกวนของแท่งเดียว
    // และ spread อย่างเดียวกินกำไรขั้นต้นไป 15% ก่อนคิดคอมมิชชัน
    minStopPct: envNum('MIN_STOP_PCT', 0.6),       // ระยะ stop ขั้นต่ำเป็น % ของราคา
    // 'daily' = วัด stop/เป้าด้วย ATR รายวัน (ยืดกรอบเวลาของไม้) · 'intraday' = พฤติกรรมแบบ v1
    tradeAtrBasis: process.env.TRADE_ATR_BASIS || 'daily',
    stopAtrDaily: envNum('STOP_ATR_DAILY', 0.35),   // stop = กี่เท่าของ ATR รายวัน
    targetAtrDaily: envNum('TARGET_ATR_DAILY', 1.2), // เป้า = กี่เท่าของ ATR รายวัน
    costPct: envNum('COST_PCT', 0.10),             // คอมมิชชัน + slippage ไป-กลับ (% ของราคา) นอกเหนือจาก spread
    minTargetMovePct: envNum('MIN_TARGET_MOVE_PCT', 0.8), // เป้าต้องห่างจากราคาเข้าอย่างน้อยกี่ % ไม่งั้นเป็นไม้ที่เล็กเกินคุ้ม

    // ═══════════ ★ v2: ด่าน Trend Template (Minervini) ═══════════
    requireTrendTemplate: envBool('REQUIRE_TREND_TEMPLATE', true),
    minTrendChecks: envNum('MIN_TREND_CHECKS', 5),  // ต้องผ่านกี่ข้อจาก 6
    minRsScore: envNum('MIN_RS_SCORE', 60),         // คะแนนความแข็งแกร่งเทียบตลาด 0-100
    rsBenchmark: process.env.RS_BENCHMARK || 'SPY',
    requireAboveVwap: envBool('REQUIRE_ABOVE_VWAP', true), // ห้ามซื้อใต้ VWAP ของวัน

    // ═══════════ ★ v2: ยืนยันการเบรกด้วยวอลุ่ม (เสี่ยยักษ์) ═══════════
    // anticipate = เข้าก่อนแนวต้าน (ของเดิม, ×0.999) · confirm = รอทะลุจริงพร้อมวอลุ่ม
    entryMode: process.env.ENTRY_MODE || 'confirm',
    confirmOffsetPct: envNum('CONFIRM_OFFSET_PCT', 0.05), // โหมด confirm: เหนือแนวต้านกี่ %
    breakoutRvolMin: envNum('BREAKOUT_RVOL_MIN', 1.5),    // วอลุ่มแท่งล่าสุดต้อง ≥ เท่านี้เท่าของค่าเฉลี่ย 20 แท่ง

    // ═══════════ ★ v2: การจัดการไม้ที่เปิดอยู่ (ข้อ P1 ที่ค้างไว้) ═══════════
    trackTrades: envBool('TRACK_TRADES', true),
    maxOpenTrades: envNum('MAX_OPEN_TRADES', 4),
    dailyLossLimitR: envNum('DAILY_LOSS_LIMIT_R', 3),  // ขาดทุนสะสมถึงกี่ R ให้หยุดสแกนอัตโนมัติ
    tp1R: envNum('TP1_R', 1.0),          // ขายบางส่วนที่กี่ R
    tp1Pct: envNum('TP1_PCT', 50),       // ขายกี่ % ของไม้ที่ TP1
    breakevenAfterTp1: envBool('BREAKEVEN_AFTER_TP1', true),
    trailAtrMult: envNum('TRAIL_ATR_MULT', 2.0), // หลัง TP1 ลาก stop ตามจุดสูงสุด − กี่เท่าของ ATR
    timeStopMin: envNum('TIME_STOP_MIN', 45),    // ไม่ไปไหนภายในกี่นาที ให้ออก
    exitOnEmaLost: envBool('EXIT_ON_EMA_LOST', true),
    exitOnVwapLost: envBool('EXIT_ON_VWAP_LOST', true),
    exitAtTarget: envBool('EXIT_AT_TARGET', false), // false = ปล่อยให้ trailing stop เป็นตัวพาออก (ดูหมายเหตุใน src/trades.js)
    pyramidEnabled: envBool('PYRAMID_ENABLED', true), // เติมไม้เมื่อกำไรแล้ว (Livermore)
    pyramidMinR: envNum('PYRAMID_MIN_R', 1.0),        // เติมได้เมื่อกำไรถึงกี่ R
    pyramidMaxAdds: envNum('PYRAMID_MAX_ADDS', 2),

    // ═══════════ ★ v2: ความเร็ว ═══════════
    scanConcurrency: envNum('SCAN_CONCURRENCY', 5), // วิเคราะห์พร้อมกันกี่ตัว (เดิมทีละตัว)
    hotPollSec: envNum('HOT_POLL_SEC', 20),         // ยิงราคาถี่เฉพาะตัวที่ใกล้ระดับเป้า (0 = ปิด) · ต่ำกว่า 20 ไม่ได้ผล เพราะ cache ราคาคือ 20 วินาที
    hotDistanceAtr: envNum('HOT_DISTANCE_ATR', 0.6),// "ใกล้" คือห่างเป้าไม่เกินกี่ ATR

    // ===== universe =====
    useAutoScreener: envBool('USE_AUTO_SCREENER', true),
    screeners: envList('SCREENERS', ['day_gainers', 'most_actives']),
    screenerSize: envNum('UNIVERSE_SIZE', 30),
    minPrice: envNum('MIN_PRICE', 2),
    maxPrice: envNum('MAX_PRICE', 1000),
    minAvgVolume: envNum('MIN_AVG_VOLUME', 1_000_000),

    // ===== คุณภาพข้อมูล (ด่านแข็ง — ตกแล้วคัดออก) =====
    maxSpreadPct: envNum('MAX_SPREAD_PCT', 0.35),
    maxQuoteStaleSec: envNum('MAX_QUOTE_STALE_SEC', 90),
    haltGapSec: envNum('HALT_GAP_SEC', 420),
    minDollarVolume5m: envNum('MIN_DOLLAR_VOLUME_5M', 500_000),
    minBars: envNum('MIN_BARS', 45),

    // ===== Relative Volume =====
    // จำนวนวันย้อนหลังที่ใช้เทียบ volume ในช่วงเวลาเดียวกัน
    // (แก้บั๊ก: scanner.js เรียก st.rvolDays แต่เดิมไม่มีนิยามที่นี่ จึงตกไปใช้ค่า fallback 10 เสมอ)
    rvolDays: envNum('RVOL_DAYS', 10),

    // ===== แนวต้าน =====
    lookback: envNum('LOOKBACK', 20),
    pivotK: envNum('PIVOT_K', 2), // จำนวนแท่งซ้าย/ขวาที่ใช้ยืนยัน swing high
    clusterAtrMult: envNum('CLUSTER_ATR_MULT', 0.25), // pivot ห่างกันไม่เกินนี้ = โซนเดียวกัน
    alertOffsetPct: envNum('ALERT_OFFSET_PCT', 0.1), // แนวต้าน −0.1% (ข้อ 4)

    // ===== น้ำหนักคะแนน 6 ปัจจัย (ข้อ 6) — รวมต้องได้ 100 =====
    weights: {
      rvol: envNum('W_RVOL', 25),
      volatility: envNum('W_VOLATILITY', 20),
      resistance: envNum('W_RESISTANCE', 15),
      momentum: envNum('W_MOMENTUM', 15),
      sentiment: envNum('W_SENTIMENT', 15),
      liquidity: envNum('W_LIQUIDITY', 10),
    },
    // ถ้าปัจจัยไหนไม่มีข้อมูล: true = เกลี่ยน้ำหนักไปปัจจัยที่มีข้อมูล, false = ให้ 50 คะแนนกลางๆ
    renormalizeWeights: envBool('RENORMALIZE_WEIGHTS', false),
    // ⚠️ หมายเหตุการย้ายชื่อค่า (สำคัญ ถ้ามี .env เดิมอยู่แล้ว)
    // โค้ดเดิมมี MIN_SCORE=70 ซึ่งหมายถึง "คะแนนขั้นต่ำที่ถือว่าเป็นสัญญาณ"
    // เวอร์ชันนี้แยกเป็น 2 ค่าที่ความหมายต่างกัน:
    //   signalScore    = คะแนนที่ถือว่าเป็น "สัญญาณ"  (ความหมายเดิมของ MIN_SCORE)
    //   hideBelowScore = ซ่อนแถวที่คะแนนต่ำกว่านี้ออกจากตารางเลย (ค่าใหม่ default 0 = แสดงทุกตัว)
    //
    // signalScore จึงยังอ่าน MIN_SCORE เป็นค่าสำรอง เพื่อให้ .env เดิมใช้ต่อได้เหมือนเดิม
    // และค่าใหม่ใช้ชื่อ HIDE_BELOW_SCORE ไม่ทับชื่อเดิม
    // (ตอนแรกเผลอใช้ชื่อ MIN_SCORE กับค่าใหม่ ทำให้ .env ที่มี MIN_SCORE=70 ซ่อนทุกแถวหมด)
    signalScore: envNum('SIGNAL_SCORE', envNum('MIN_SCORE', 70)),
    hideBelowScore: envNum('HIDE_BELOW_SCORE', 0),

    // ===== ATR sweet spot (ปัจจัย volatility เป็นระฆัง ไม่ใช่ยิ่งมากยิ่งดี) =====
    atrPctLow: envNum('ATR_PCT_LOW', 1.5), // ต่ำกว่านี้ = นิ่งเกินไป
    atrPctHigh: envNum('ATR_PCT_HIGH', 3.0), // สูงกว่านี้ = เหวี่ยงเกินคุมความเสี่ยง

    // ===== API keys =====
    apiKeys: {
      finnhub: process.env.FINNHUB_API_KEY || '',
      alphavantage: process.env.ALPHAVANTAGE_API_KEY || '',
      twelvedata: process.env.TWELVEDATA_API_KEY || '',
      marketaux: process.env.MARKETAUX_API_KEY || '',
      fmp: process.env.FMP_API_KEY || '',
    },
    // ลำดับ provider สำหรับข่าว/sentiment (Alpha Vantage โควตาแคบ อาจอยากให้ Marketaux นำ)
    newsProviderOrder: envList('NEWS_PROVIDER_ORDER', ['alphavantage', 'marketaux', 'finnhub']),
    sentimentTopN: envNum('SENTIMENT_TOP_N', 3), // เรียก sentiment เฉพาะ N ตัวคะแนนสูงสุด/รอบ

    // ═══════════ ★ v2.1: ค่าเงิน (USD/THB) ═══════════
    // คะแนนบอกว่าเรตวันนี้ถูก/แพงแค่ไหนเทียบกับปีที่ผ่านมา ไม่ใช่การพยากรณ์
    fxEnabled: envBool('FX_ENABLED', true),
    fxPair: process.env.FX_PAIR || 'USD/THB',     // คู่หลัก = fxPairs[0] เสมอ (ระบบดูแลให้ตรงกันเอง)
    // ★ เฝ้าดูได้หลายคู่พร้อมกัน เช่น FX_PAIRS=USD/THB,EUR/THB,JPY/THB
    fxPairs: envList('FX_PAIRS', [process.env.FX_PAIR || 'USD/THB']),
    // เรตเป้าที่ตั้งเองแยกตามคู่: { 'EUR/THB': { buyBelow: 37.5, sellAbove: 40 } }
    fxTargets: {},
    fxPollSec: envNum('FX_POLL_SEC', 900),        // 15 นาที — ค่าเงินขยับช้ากว่าหุ้นมาก
    fxLookbackDays: envNum('FX_LOOKBACK_DAYS', 365),
    // ส่วนต่างของธนาคาร/ร้านแลกเงิน — เรตจาก provider เป็น mid-market ที่ไม่มีใครได้จริง
    // ธนาคารไทยราว 0.3-0.8% · ร้านแลกเงินแคบกว่า · ตั้งให้ตรงกับที่คุณใช้จริง
    fxSpreadPct: envNum('FX_SPREAD_PCT', 0.5),
    fxScoreThreshold: envNum('FX_SCORE_THRESHOLD', 75), // คะแนนที่ถือว่า "ควรแลกแล้ว"
    // ถ้าเรตทั้งช่วงขยับน้อยกว่านี้ ถือว่าไม่มีอะไรให้ตัดสิน → ดึงคะแนนเข้าหากลางและไม่เตือนจากคะแนน
    fxMinRangePct: envNum('FX_MIN_RANGE_PCT', 1.0),
    fxAlertBuy: envBool('FX_ALERT_BUY', true),    // เตือนทิศบาท → ดอลลาร์
    fxAlertSell: envBool('FX_ALERT_SELL', true),  // เตือนทิศดอลลาร์ → บาท
    // เรตเป้าที่ตั้งเอง (0 = ไม่ใช้ ให้ดูจากคะแนนอย่างเดียว)
    fxBuyBelow: envNum('FX_BUY_BELOW', 0),        // แลกบาท→ดอลลาร์ เมื่อเรตต่ำกว่าค่านี้
    fxSellAbove: envNum('FX_SELL_ABOVE', 0),      // แลกดอลลาร์→บาท เมื่อเรตสูงกว่าค่านี้
    // จำนวนเงินที่ตั้งใจจะแลก — ใช้แปลงคะแนนเป็น "ต่างกันกี่บาท" ซึ่งมีความหมายกว่าคะแนน
    fxBuyAmountThb: envNum('FX_BUY_AMOUNT_THB', 100_000),
    fxSellAmountUsd: envNum('FX_SELL_AMOUNT_USD', 3_000),

    // ═══════════ ★ กฎแจ้งเตือน (ตั้งจากปุ่ม "กฎแจ้งเตือน" ในแดชบอร์ด) ═══════════
    // หุ้น: เตือนเมื่อคะแนนถึงเกณฑ์ — หุ้นละไม่เกิน 1 ครั้งต่อวัน รวมทั้งรอบเป็นข้อความเดียว
    scoreAlertEnabled: envBool('SCORE_ALERT_ENABLED', false),
    scoreAlertMin: envNum('SCORE_ALERT_MIN', 70),
    scoreAlertScope: process.env.SCORE_ALERT_SCOPE || 'all',          // 'all' | 'watchlist'
    scoreAlertRequirePassed: envBool('SCORE_ALERT_REQUIRE_PASSED', true),
    scoreAlertLine: envBool('SCORE_ALERT_LINE', true),
    scoreAlertBrowser: envBool('SCORE_ALERT_BROWSER', true),
    // ช่องทางของการแจ้งเตือนแบบเดิม (ค่าเริ่มต้น = พฤติกรรมเดิมทุกอย่าง)
    priceAlertLine: envBool('PRICE_ALERT_LINE', true),   // ราคาแตะเป้า (รายการเฝ้าดู) → LINE
    fxAlertLine: envBool('FX_ALERT_LINE', true),         // ค่าเงินเข้าเงื่อนไข → LINE
    fxAlertBrowser: envBool('FX_ALERT_BROWSER', true),   // ค่าเงินเข้าเงื่อนไข → เสียง + แจ้งเตือนเบราว์เซอร์

    // ===== LINE (ช่องเสริม) =====
    // lineEnabled = สวิตช์หลัก: ปิดอยู่ = ไม่มีอะไรส่งเข้า LINE เลย ไม่ว่ากฎไหนจะติ๊ก LINE ไว้
    lineEnabled: envBool('LINE_ENABLED', false),
    lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    lineTarget: process.env.LINE_TARGET_ID || '',

    // ===== สแกนตอนตลาดปิดหรือไม่ =====
    // true (default) = สแกนต่อแม้ตลาดปิด (เห็นราคาล่าสุดก่อนปิด + ทดลองระบบได้)
    // false = ข้ามรอบไปเลยเมื่ออยู่นอกช่วง session ที่เลือก (ประหยัดโควตา API)
    scanWhenClosed: envBool('SCAN_WHEN_CLOSED', true),

    // ═══════════ ★ หลายตลาด: หุ้นอเมริกา + หุ้นไทย (SET) ═══════════
    // สองตลาดเปิดคนละเวลา (ไทย 10:00-16:30 · อเมริกา 20:30-03:00 เวลาไทย) ระบบสแกนตามตลาดที่เปิดอยู่
    usEnabled: envBool('US_ENABLED', true),
    thEnabled: envBool('TH_ENABLED', true),
    // รายชื่อหุ้นไทยที่สแกน (ชื่อย่อ ไม่ต้องมี .BK) — ตั้งต้นเป็นหุ้นใหญ่ 100 ตัวใกล้เคียง SET100
    thUseUniverse: envBool('TH_USE_UNIVERSE', true),
    thUniverse: envList('TH_UNIVERSE', TH_UNIVERSE_DEFAULT),
    // ค่าที่ผูกกับสกุลเงิน/ตลาด (ค่าอื่นใช้ร่วมกับหุ้นอเมริกา)
    thAccountSize: envNum('TH_ACCOUNT_SIZE', 300_000),        // เงินทุนสำหรับหุ้นไทย (บาท)
    thCostPct: envNum('TH_COST_PCT', 0.35),                   // ค่าคอม+VAT+ค่าธรรมเนียมตลาด ไป-กลับ (%) — เช็คกับโบรกเกอร์ของคุณ
    thMaxSpreadTicks: envNum('TH_MAX_SPREAD_TICKS', 2),       // spread ไม่เกินกี่ช่องราคา
    thMaxSpreadPct: envNum('TH_MAX_SPREAD_PCT', 0.5),         // หรือไม่เกินกี่ % (ผ่านข้อใดข้อหนึ่ง)
    thMinValue5m: envNum('TH_MIN_VALUE_5M', 300_000),         // มูลค่าซื้อขายขั้นต่ำต่อ 5 นาที (บาท)
    thDataDelayMin: envNum('TH_DATA_DELAY_MIN', 30),          // ข้อมูลฟรีช้ากว่าจริงกี่นาที (สแกนต่อหลังปิดแต่ละช่วงเท่านี้)
    thMaxQuoteStaleSec: envNum('TH_MAX_QUOTE_STALE_SEC', 2700), // เก่ากว่านี้ = ข้อมูลไม่อัปเดต (45 นาที)
    thAtrPctLow: envNum('TH_ATR_PCT_LOW', 1.0),               // หุ้นใหญ่ของไทยแกว่งน้อยกว่าหุ้นอเมริกา
    thAtrPctHigh: envNum('TH_ATR_PCT_HIGH', 2.5),
  };

  // หมายเหตุ v2: ค่าการติดตามไม้ที่เปิดอยู่ย้ายเข้ามาอยู่ที่นี่แล้ว (trackTrades ... pyramidMaxAdds)
  // เพราะหน้าเว็บมีตาราง "ไม้ที่เปิดอยู่" จริงแล้ว (src/trades.js) — ไม่ใช่ค่าที่แก้ได้แต่ไม่มีใครอ่านอีกต่อไป
}

// ---------- merge แบบลึก (เฉพาะ object ธรรมดา ไม่ยุ่งกับ array) ----------
function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class SettingsStore extends EventEmitter {
  constructor() {
    super();
    const defaults = buildDefaults();
    const saved = readJsonSync(SETTINGS_FILE, null);
    this._data = normalizeFx(saved ? deepMerge(defaults, saved) : defaults, saved || defaults);
    this._defaults = defaults;
  }

  get all() {
    return this._data;
  }

  get(key) {
    return this._data[key];
  }

  // คืนค่าที่ปลอดภัยสำหรับส่งไปหน้าเว็บ — mask API key และ LINE token
  // (ไม่ส่งค่าเต็มกลับไป เพราะหน้าเว็บไม่จำเป็นต้องรู้ และกันหลุดใน devtools/screenshot)
  get publicView() {
    const d = this._data;
    const maskedKeys = {};
    for (const [k, v] of Object.entries(d.apiKeys)) {
      maskedKeys[k] = v ? `••••${String(v).slice(-4)}` : '';
    }
    return {
      ...d,
      apiKeys: maskedKeys,
      lineToken: d.lineToken ? `••••${d.lineToken.slice(-4)}` : '',
      lineTarget: d.lineTarget ? `••••${d.lineTarget.slice(-4)}` : '',
    };
  }

  // อัปเดตค่า แล้วบันทึกลงไฟล์ + emit ให้ scanner รู้
  // ค่าที่เป็นสตริง mask (••••xxxx) จะถูกข้าม = ไม่ทับ key เดิมด้วยค่าที่ mask แล้ว
  async update(patch) {
    const cleaned = stripMasked(patch);
    const validated = validate(cleaned, this._data);
    this._data = deepMerge(this._data, validated.value);
    await writeJson(SETTINGS_FILE, this._data);
    this.emit('change', this._data);
    return { settings: this.publicView, warnings: validated.warnings };
  }

  async reset() {
    const defaults = buildDefaults();
    this._data = normalizeFx(defaults, defaults);
    await writeJson(SETTINGS_FILE, this._data);
    this.emit('change', this._data);
    return this.publicView;
  }
}

// ตัดค่าที่เป็น mask ออก (user ไม่ได้แก้ key ก็ไม่ต้องเขียนทับ)
function stripMasked(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [...obj] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.startsWith('••••')) continue; // ข้าม ค่าที่ mask
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = stripMasked(v);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------- ตรวจความถูกต้องของค่าที่ user กรอก ----------
// คืน { value, warnings } — ค่าที่ผิดจะถูกปรับให้อยู่ในช่วงที่ใช้งานได้ พร้อมคำเตือน
function validate(patch, current) {
  const warnings = [];
  const v = { ...patch };

  const clamp = (key, min, max, label) => {
    if (v[key] === undefined) return;
    const n = Number(v[key]);
    if (!Number.isFinite(n)) {
      warnings.push(`${label} ไม่ใช่ตัวเลข — ใช้ค่าเดิม`);
      delete v[key];
      return;
    }
    if (n < min || n > max) {
      warnings.push(`${label} ต้องอยู่ระหว่าง ${min}-${max} — ปรับให้เป็น ${Math.min(max, Math.max(min, n))}`);
    }
    v[key] = Math.min(max, Math.max(min, n));
  };

  clamp('scanIntervalSec', 10, 3600, 'ช่วงเวลาสแกน (วินาที)');
  clamp('accountSize', 1, 1e9, 'เงินทุน');
  clamp('riskPct', 0.01, 100, '% ความเสี่ยงต่อไม้');
  clamp('minRR', 0, 100, 'R:R ขั้นต่ำ');
  clamp('atrStopMult', 0.1, 10, 'ตัวคูณ ATR สำหรับ stop');
  clamp('minStopAtr', 0.05, 5, 'ระยะ stop ขั้นต่ำ (เท่าของ ATR)');
  clamp('targetExtAtr', 0, 5, 'ส่วนขยายเป้าเลยแนวต้าน (เท่าของ ATR)');
  clamp('maxSpreadPct', 0.01, 100, 'spread สูงสุด');
  clamp('lookback', 5, 500, 'จำนวนแท่งย้อนหลัง');
  clamp('rvolDays', 3, 60, 'จำนวนวันย้อนหลังสำหรับคำนวณ RVOL');
  clamp('minRR', 0, 100, 'R:R ขั้นต่ำ');
  clamp('pivotK', 1, 10, 'จำนวนแท่งยืนยัน pivot');
  clamp('alertOffsetPct', 0, 10, 'ระยะห่างจากแนวต้าน (%)');
  clamp('screenerSize', 1, 100, 'จำนวนหุ้นจาก screener');
  clamp('hideBelowScore', 0, 100, 'ซ่อนแถวที่คะแนนต่ำกว่า');
  clamp('signalScore', 0, 100, 'คะแนนที่ถือว่าเป็นสัญญาณ');
  clamp('sentimentTopN', 0, 20, 'จำนวนหุ้นที่เรียก sentiment');
  clamp('atrPctLow', 0.05, 50, 'ATR% ขั้นต่ำ');
  clamp('atrPctHigh', 0.1, 100, 'ATR% ขั้นสูง');

  // ★ v2
  clamp('minStopPct', 0.05, 20, 'ระยะ stop ขั้นต่ำ (% ของราคา)');
  clamp('stopAtrDaily', 0.05, 5, 'stop เป็นกี่เท่าของ ATR รายวัน');
  clamp('targetAtrDaily', 0.1, 10, 'เป้าเป็นกี่เท่าของ ATR รายวัน');
  clamp('costPct', 0, 5, 'ต้นทุนคอมมิชชัน+slippage (%)');
  clamp('minTargetMovePct', 0, 50, 'ระยะเป้าขั้นต่ำ (%)');
  clamp('minTrendChecks', 0, 6, 'จำนวนข้อ Trend Template ที่ต้องผ่าน');
  clamp('minRsScore', 0, 100, 'คะแนน RS ขั้นต่ำ');
  clamp('confirmOffsetPct', 0, 5, 'ระยะยืนยันเหนือแนวต้าน (%)');
  clamp('breakoutRvolMin', 0, 20, 'วอลุ่มแท่งเบรกขั้นต่ำ (เท่า)');
  clamp('maxOpenTrades', 1, 50, 'จำนวนไม้ที่เปิดพร้อมกันสูงสุด');
  clamp('dailyLossLimitR', 0.5, 50, 'ลิมิตขาดทุนต่อวัน (R)');
  clamp('tp1R', 0.2, 10, 'TP1 ที่กี่ R');
  clamp('tp1Pct', 0, 100, '% ที่ขายออกที่ TP1');
  clamp('trailAtrMult', 0.3, 10, 'ตัวคูณ ATR สำหรับลาก stop');
  clamp('timeStopMin', 1, 1440, 'Time stop (นาที)');
  clamp('pyramidMinR', 0.2, 10, 'เติมไม้เมื่อกำไรถึงกี่ R');
  clamp('pyramidMaxAdds', 0, 10, 'จำนวนครั้งที่เติมไม้ได้');
  clamp('scanConcurrency', 1, 20, 'จำนวนหุ้นที่วิเคราะห์พร้อมกัน');
  clamp('hotPollSec', 0, 600, 'ช่วงยิงราคาถี่ (วินาที)');
  clamp('hotDistanceAtr', 0, 5, 'ระยะที่ถือว่าใกล้เป้า (ATR)');

  // ★ v2.1 — ค่าเงิน
  clamp('fxPollSec', 60, 86400, 'รอบตรวจค่าเงิน (วินาที)');
  clamp('fxLookbackDays', 60, 2000, 'ช่วงย้อนหลังที่ใช้คำนวณสถิติค่าเงิน (วัน)');
  clamp('fxSpreadPct', 0, 10, 'ส่วนต่างของธนาคาร/ร้านแลกเงิน (%)');
  clamp('fxScoreThreshold', 0, 100, 'คะแนนค่าเงินที่ถือว่าควรแลก');
  clamp('fxMinRangePct', 0, 50, 'ช่วงแกว่งขั้นต่ำที่ถือว่ามีความหมาย (%)');
  clamp('fxBuyBelow', 0, 1e6, 'เรตเป้าสำหรับแลกบาทเป็นดอลลาร์');
  clamp('fxSellAbove', 0, 1e6, 'เรตเป้าสำหรับแลกดอลลาร์เป็นบาท');
  clamp('fxBuyAmountThb', 0, 1e12, 'จำนวนบาทที่ตั้งใจจะแลก');
  clamp('fxSellAmountUsd', 0, 1e12, 'จำนวนดอลลาร์ที่ตั้งใจจะแลก');

  // ★ หุ้นไทย
  clamp('thAccountSize', 1, 1e12, 'เงินทุนสำหรับหุ้นไทย (บาท)');
  clamp('thCostPct', 0, 5, 'ต้นทุนซื้อขายหุ้นไทยไป-กลับ (%)');
  clamp('thMaxSpreadTicks', 1, 20, 'spread หุ้นไทยสูงสุด (ช่องราคา)');
  clamp('thMaxSpreadPct', 0.01, 100, 'spread หุ้นไทยสูงสุด (%)');
  clamp('thMinValue5m', 0, 1e12, 'มูลค่าซื้อขายหุ้นไทยขั้นต่ำต่อ 5 นาที (บาท)');
  clamp('thDataDelayMin', 0, 120, 'ความช้าของข้อมูลหุ้นไทย (นาที)');
  clamp('thMaxQuoteStaleSec', 60, 86400, 'เกณฑ์ข้อมูลหุ้นไทยไม่อัปเดต (วินาที)');
  clamp('thAtrPctLow', 0.05, 50, 'ATR% ขั้นต่ำของหุ้นไทย');
  clamp('thAtrPctHigh', 0.1, 100, 'ATR% ขั้นสูงของหุ้นไทย');
  for (const k of ['usEnabled', 'thEnabled', 'thUseUniverse']) {
    if (v[k] !== undefined) v[k] = v[k] === true || v[k] === 'true';
  }
  // รายชื่อหุ้นไทย: รับได้ทั้ง array และข้อความคั่นด้วย comma/ช่องว่าง/ขึ้นบรรทัด · ตัด .BK ออกให้เหลือชื่อย่อ
  if (v.thUniverse !== undefined) {
    const raw = Array.isArray(v.thUniverse) ? v.thUniverse : String(v.thUniverse).split(/[\s,;]+/);
    const ok = [];
    const bad = [];
    for (const item of raw) {
      const c = String(item).trim().toUpperCase().replace(/\.BK$/, '');
      if (!c) continue;
      if (!/^[A-Z0-9][A-Z0-9&\-]{0,11}$/.test(c)) bad.push(c);
      else if (!ok.includes(c)) ok.push(c);
    }
    if (bad.length > 0) warnings.push(`ชื่อย่อหุ้นไทยไม่ถูกรูปแบบ — ข้าม: ${bad.slice(0, 10).join(', ')}`);
    if (ok.length > 300) {
      warnings.push('รายชื่อหุ้นไทยสแกนได้สูงสุด 300 ตัว (แต่ละตัวใช้คำขอหลายครั้งต่อรอบ) — ใช้ 300 ตัวแรก');
      ok.length = 300;
    }
    v.thUniverse = ok;
  }
  {
    const tlo = v.thAtrPctLow ?? current.thAtrPctLow;
    const thi = v.thAtrPctHigh ?? current.thAtrPctHigh;
    if (Number.isFinite(tlo) && Number.isFinite(thi) && tlo >= thi) {
      warnings.push(`ATR% ขั้นต่ำของหุ้นไทย (${tlo}) ต้องน้อยกว่าขั้นสูง (${thi}) — สลับค่าให้แล้ว`);
      v.thAtrPctLow = Math.min(tlo, thi);
      v.thAtrPctHigh = Math.max(tlo, thi);
    }
  }

  // ★ กฎแจ้งเตือน
  clamp('scoreAlertMin', 0, 100, 'คะแนนขั้นต่ำที่จะแจ้งเตือน');
  if (v.scoreAlertScope !== undefined && !['all', 'watchlist'].includes(v.scoreAlertScope)) {
    warnings.push(`ขอบเขตการแจ้งเตือนคะแนน "${v.scoreAlertScope}" ไม่รู้จัก — ใช้ค่าเดิม`);
    delete v.scoreAlertScope;
  }
  for (const k of ['scoreAlertEnabled', 'scoreAlertRequirePassed', 'scoreAlertLine', 'scoreAlertBrowser',
    'priceAlertLine', 'fxAlertLine', 'fxAlertBrowser']) {
    if (v[k] !== undefined) v[k] = v[k] === true || v[k] === 'true';
  }

  if (v.fxPair !== undefined) {
    const p = String(v.fxPair).trim().toUpperCase();
    if (!FX_PAIR_RE.test(p)) {
      warnings.push('คู่เงินต้องอยู่ในรูป XXX/YYY เช่น USD/THB — ใช้ค่าเดิม');
      delete v.fxPair;
    } else {
      v.fxPair = p;
    }
  }

  // ★ หลายคู่เงิน — รับได้ทั้ง array และสตริงคั่นด้วย comma
  if (v.fxPairs !== undefined) {
    const raw = Array.isArray(v.fxPairs) ? v.fxPairs : String(v.fxPairs).split(',');
    const ok = [];
    const bad = [];
    for (const item of raw) {
      const p = String(item).trim().toUpperCase();
      if (!p) continue;
      if (!FX_PAIR_RE.test(p)) bad.push(p);
      else if (!ok.includes(p)) ok.push(p);
    }
    if (bad.length > 0) warnings.push(`คู่เงินต้องอยู่ในรูป XXX/YYY เช่น EUR/THB — ข้าม: ${bad.join(', ')}`);
    if (ok.length > FX_MAX_PAIRS) {
      warnings.push(`เฝ้าดูได้สูงสุด ${FX_MAX_PAIRS} คู่ (แต่ละคู่ใช้ API ทุกรอบตรวจ) — ใช้ ${FX_MAX_PAIRS} คู่แรก`);
      ok.length = FX_MAX_PAIRS;
    }
    if (ok.length === 0) {
      warnings.push('ต้องเฝ้าดูอย่างน้อย 1 คู่เงิน — ใช้ค่าเดิม');
      delete v.fxPairs;
    } else {
      v.fxPairs = ok;
      v.fxPair = ok[0];
    }
  } else if (v.fxPair !== undefined) {
    // ตั้งคู่หลักแบบเดิม (คู่เดียว) → ย้ายคู่นั้นขึ้นหน้ารายการ
    v.fxPairs = [v.fxPair, ...(current.fxPairs || []).filter((p) => p !== v.fxPair)].slice(0, FX_MAX_PAIRS);
  }

  // ★ เรตเป้าแยกตามคู่ (0 = ไม่ใช้)
  const primaryPair = v.fxPair ?? current.fxPair;
  if (v.fxTargets !== undefined) {
    if (!v.fxTargets || typeof v.fxTargets !== 'object' || Array.isArray(v.fxTargets)) {
      warnings.push('รูปแบบเรตเป้าแยกตามคู่เงินไม่ถูกต้อง — ใช้ค่าเดิม');
      delete v.fxTargets;
    } else {
      const cleaned = {};
      for (const [pair, t] of Object.entries(v.fxTargets)) {
        const p = String(pair).trim().toUpperCase();
        if (!FX_PAIR_RE.test(p) || !t || typeof t !== 'object') continue;
        const entry = {};
        for (const k of ['buyBelow', 'sellAbove']) {
          if (t[k] === undefined || t[k] === null || t[k] === '') continue;
          const n = Number(t[k]);
          if (!Number.isFinite(n)) { warnings.push(`เรตเป้า ${p} ไม่ใช่ตัวเลข — ข้าม`); continue; }
          entry[k] = Math.min(1e6, Math.max(0, n));
        }
        cleaned[p] = entry;
      }
      v.fxTargets = cleaned;
    }
  }
  // ช่องแบบเดิม (fxBuyBelow/fxSellAbove) = เรตเป้าของคู่หลัก → เขียนลง fxTargets ของคู่หลักด้วย
  if (v.fxBuyBelow !== undefined || v.fxSellAbove !== undefined) {
    v.fxTargets = { ...(v.fxTargets || {}) };
    v.fxTargets[primaryPair] = {
      ...(v.fxTargets[primaryPair] || {}),
      ...(v.fxBuyBelow !== undefined ? { buyBelow: v.fxBuyBelow } : {}),
      ...(v.fxSellAbove !== undefined ? { sellAbove: v.fxSellAbove } : {}),
    };
  }
  // และกลับกัน: ช่องแบบเดิมสะท้อนค่าของคู่หลักเสมอ (คู่หลักอาจเพิ่งเปลี่ยน)
  {
    const saved = current.fxTargets?.[primaryPair] || {};
    const legacy = primaryPair === current.fxPair ? { buyBelow: current.fxBuyBelow, sellAbove: current.fxSellAbove } : {};
    const t = { ...legacy, ...saved, ...(v.fxTargets?.[primaryPair] || {}) };
    v.fxBuyBelow = Number.isFinite(t.buyBelow) ? t.buyBelow : 0;
    v.fxSellAbove = Number.isFinite(t.sellAbove) ? t.sellAbove : 0;
  }
  // เรตเป้าที่ทับช่วงกันของคู่อื่น (คู่หลักตรวจในบล็อกถัดไป)
  for (const [pair, t] of Object.entries(v.fxTargets || {})) {
    if (pair === primaryPair) continue;
    const merged = { ...(current.fxTargets?.[pair] || {}), ...t };
    if (merged.buyBelow > 0 && merged.sellAbove > 0 && merged.buyBelow >= merged.sellAbove) {
      warnings.push(`${pair}: เรตเป้าขัดกันเอง (ซื้อเมื่อต่ำกว่า ${merged.buyBelow} แต่ขายเมื่อสูงกว่า ${merged.sellAbove}) ` +
        '— ควรตั้งเป้าซื้อให้ต่ำกว่าเป้าขาย');
    }
  }

  // เรตเป้าที่ขัดกันเอง: ซื้อเมื่อต่ำกว่า X แต่ X สูงกว่าเป้าขาย Y → เข้าเงื่อนไขพร้อมกันทั้งสองทาง
  {
    const b = v.fxBuyBelow ?? current.fxBuyBelow;
    const sAbove = v.fxSellAbove ?? current.fxSellAbove;
    if (b > 0 && sAbove > 0 && b >= sAbove) {
      warnings.push(`เรตเป้าขัดกันเอง: จะแลกเป็นดอลลาร์เมื่อต่ำกว่า ${b} และแลกกลับเป็นบาทเมื่อสูงกว่า ${sAbove} ` +
        '— ช่วงนี้ทับกัน ทำให้เตือนทั้งสองทางพร้อมกัน ควรตั้งเป้าซื้อให้ต่ำกว่าเป้าขาย');
    }
  }

  // entryMode ต้องเป็น 1 ใน 2 ค่า
  if (v.tradeAtrBasis !== undefined) {
    const ok = ['daily', 'intraday'];
    if (!ok.includes(v.tradeAtrBasis)) {
      warnings.push(`tradeAtrBasis "${v.tradeAtrBasis}" ไม่รู้จัก — ใช้ค่าเดิม (${current.tradeAtrBasis})`);
      delete v.tradeAtrBasis;
    }
  }
  if (v.entryMode !== undefined) {
    const ok = ['anticipate', 'confirm'];
    if (!ok.includes(v.entryMode)) {
      warnings.push(`entryMode "${v.entryMode}" ไม่รู้จัก — ใช้ค่าเดิม (${current.entryMode})`);
      delete v.entryMode;
    }
  }
  if (v.rsBenchmark !== undefined) {
    const sym = String(v.rsBenchmark).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) {
      warnings.push('สัญลักษณ์ดัชนีอ้างอิงไม่ถูกรูปแบบ — ใช้ค่าเดิม');
      delete v.rsBenchmark;
    } else {
      v.rsBenchmark = sym;
    }
  }

  // session ต้องเป็น 1 ใน 4 ค่าที่รู้จัก
  if (v.session !== undefined) {
    const ok = ['regular', 'pre', 'post', 'all'];
    if (!ok.includes(v.session)) {
      warnings.push(`session "${v.session}" ไม่รู้จัก — ใช้ค่าเดิม (${current.session})`);
      delete v.session;
    }
  }

  // timeframe ต้องเป็นค่าที่ provider รองรับ
  if (v.timeframes !== undefined) {
    const ok = ['1m', '5m', '15m', '30m', '1h'];
    const filtered = (Array.isArray(v.timeframes) ? v.timeframes : [v.timeframes])
      .map((s) => String(s).trim())
      .filter((s) => ok.includes(s));
    if (filtered.length === 0) {
      warnings.push('ไม่มี timeframe ที่ใช้ได้ — ใช้ค่าเดิม');
      delete v.timeframes;
    } else {
      v.timeframes = filtered;
    }
  }

  // ATR sweet spot: low ต้องน้อยกว่า high
  const lo = v.atrPctLow ?? current.atrPctLow;
  const hi = v.atrPctHigh ?? current.atrPctHigh;
  if (lo >= hi) {
    warnings.push(`ATR% ขั้นต่ำ (${lo}) ต้องน้อยกว่าขั้นสูง (${hi}) — สลับค่าให้แล้ว`);
    v.atrPctLow = Math.min(lo, hi);
    v.atrPctHigh = Math.max(lo, hi);
  }

  // น้ำหนักคะแนน: ต้องไม่ติดลบ และรวมได้ 100 (ถ้าไม่ใช่ จะ normalize ให้)
  if (v.weights) {
    const keys = ['rvol', 'volatility', 'resistance', 'momentum', 'sentiment', 'liquidity'];
    const w = { ...current.weights, ...v.weights };
    for (const k of keys) {
      const n = Number(w[k]);
      w[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
    const sum = keys.reduce((a, k) => a + w[k], 0);
    if (sum <= 0) {
      warnings.push('น้ำหนักรวมเป็น 0 — คืนค่าน้ำหนักเริ่มต้น');
      v.weights = { rvol: 25, volatility: 20, resistance: 15, momentum: 15, sentiment: 15, liquidity: 10 };
    } else if (Math.abs(sum - 100) > 0.01) {
      // ปรับสัดส่วนให้รวมได้ 100 พอดี โดยรักษาอัตราส่วนที่ user ตั้งไว้
      for (const k of keys) w[k] = Math.round((w[k] / sum) * 1000) / 10;
      warnings.push(`น้ำหนักรวมได้ ${sum.toFixed(1)} ไม่ใช่ 100 — ปรับสัดส่วนให้รวม 100 แล้ว`);
      v.weights = w;
    } else {
      v.weights = w;
    }
  }

  return { value: v, warnings };
}

export const settings = new SettingsStore();
export { buildDefaults };
