// src/backtest.js — วิเคราะห์ย้อนหลังว่าสัญญาณที่ระบบเคยให้ ถ้าเข้าตามนั้นจริงจะได้ผลยังไง (สเปกข้อ 7)
//
// อ่านจาก data/signals-history.json (scanner บันทึกทุกสัญญาณลงไป)
// แล้วเอาแท่งเทียนหลังเวลาที่ให้สัญญาณ มาดูว่าราคาไปแตะ stop ก่อน หรือแตะเป้าก่อน
//
// คำนวณ:
//   win rate       — ชนะกี่ %
//   avg gain/loss  — กำไร/ขาดทุนเฉลี่ยเป็นหน่วย R
//   max drawdown   — จุดที่ทุนสะสมลดลงจากยอดสูงสุดมากที่สุด (peak-to-trough ของ equity curve แบบ R)
//   expectancy     — ค่าคาดหวังต่อไม้ (R)
//   แยกตามช่วงคะแนน — ตรวจว่าคะแนนสูงได้ผลดีจริงหรือไม่
//   แยกตามปัจจัย   — ปัจจัยไหนสัมพันธ์กับผลลัพธ์ที่ดี
//
// ⚠️ ข้อจำกัดที่ต้องรู้ (เขียนไว้ในผลลัพธ์ด้วย เพื่อไม่ให้เข้าใจผิด):
//   1) ใช้แท่งเทียน ไม่ใช่ tick — ถ้าแท่งเดียวแตะทั้ง stop และเป้า จะนับเป็น "แพ้"
//      (สมมติแบบระมัดระวัง เพราะไม่รู้ว่าอะไรเกิดก่อนภายในแท่ง)
//   2) ไม่คิดค่าคอมมิชชั่น, slippage, ค่าธรรมเนียม — ผลจริงจะแย่กว่านี้
//   3) ไม่คิดว่าอาจไม่ได้ราคาที่ต้องการ (partial fill)
//   4) เป็นการทดสอบย้อนหลังบนข้อมูลที่มี ไม่ใช่การรับประกันผลในอนาคต

import { readJson } from './store.js';
import { getBars } from './providers/index.js';
import { log } from './logbus.js';

const SIGNALS_FILE = 'signals-history.json';

// ---------- ประเมินผลสัญญาณ 1 รายการ ----------
async function evaluateSignal(sig, windowMin) {
  const entry = Number(sig.entry);
  const stop = Number(sig.stop);
  // เป้าใช้ตัวเดียวกับที่ระบบคำนวณไว้ตอนให้สัญญาณ
  const target = Number(sig.targetBreakout ?? sig.target);

  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
    return { skip: true, reason: 'ข้อมูลสัญญาณไม่ครบ (entry/stop/target)' };
  }
  const risk = entry - stop;
  if (risk <= 0) return { skip: true, reason: 'ความเสี่ยงต่อหุ้นไม่ถูกต้อง (risk ≤ 0)' };

  let barsRes;
  try {
    barsRes = await getBars(sig.symbol, sig.tf || '5m', 30, { stitch: false });
  } catch (err) {
    return { skip: true, reason: `ดึงแท่งเทียนไม่ได้: ${err.message}` };
  }

  const sigTime = Date.parse(sig.ts);
  if (!Number.isFinite(sigTime)) return { skip: true, reason: 'เวลาของสัญญาณไม่ถูกต้อง' };

  const windowEnd = sigTime + windowMin * 60_000;
  const win = barsRes.bars.filter((b) => {
    const t = new Date(b.date).getTime();
    return t > sigTime && t <= windowEnd;
  });

  if (win.length === 0) {
    return { skip: true, reason: `ยังไม่มีแท่งเทียนหลังเวลาให้สัญญาณ (รอครบ ${windowMin} นาทีก่อน)` };
  }

  let outcome = 'UNDECIDED';
  let r = null;
  let mfe = -Infinity; // กำไรสูงสุดที่เคยเห็น (Maximum Favourable Excursion)
  let mae = Infinity;  // ขาดทุนมากสุดที่เคยเห็น (Maximum Adverse Excursion)
  let barsToResolve = 0;

  for (const b of win) {
    barsToResolve += 1;
    mfe = Math.max(mfe, (b.high - entry) / risk);
    mae = Math.min(mae, (b.low - entry) / risk);

    const hitStop = b.low <= stop;
    const hitTarget = b.high >= target;

    // ⚠️ สมมติแบบระมัดระวัง: แท่งเดียวแตะทั้งสองอย่าง = นับว่าแพ้
    // เพราะข้อมูลระดับแท่งไม่บอกว่าอะไรเกิดก่อน
    if (hitStop) { outcome = 'LOSS'; r = -1; break; }
    if (hitTarget) { outcome = 'WIN'; r = (target - entry) / risk; break; }
  }

  // ยังไม่ตัดสิน → ใช้ราคาปิดของแท่งสุดท้ายในหน้าต่างเวลา (mark to market)
  if (outcome === 'UNDECIDED') {
    const lastClose = win[win.length - 1].close;
    r = (lastClose - entry) / risk;
  }

  return {
    skip: false,
    symbol: sig.symbol,
    tf: sig.tf,
    ts: sig.ts,
    score: sig.score,
    outcome,
    r,
    mfe: mfe === -Infinity ? 0 : mfe,
    mae: mae === Infinity ? 0 : mae,
    barsToResolve,
    entry, stop, target,
    factors: sig.factors || {},
    reasons: sig.reasons || [],
    resistanceMethod: sig.resistanceMethod || null,
  };
}

// ---------- max drawdown จาก equity curve ----------
// ไล่ผลลัพธ์ตามลำดับเวลา สะสมเป็น R แล้วหาช่วงที่ลดจากยอดสูงสุดมากที่สุด
function computeMaxDrawdown(rSeries) {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  let curve = [];
  let peakAt = 0;
  let troughAt = 0;
  let tmpPeakAt = 0;

  for (let i = 0; i < rSeries.length; i++) {
    equity += rSeries[i];
    curve.push(Number(equity.toFixed(3)));
    if (equity > peak) {
      peak = equity;
      tmpPeakAt = i;
    }
    const dd = peak - equity;
    if (dd > maxDD) {
      maxDD = dd;
      peakAt = tmpPeakAt;
      troughAt = i;
    }
  }

  return {
    maxDrawdownR: Number(maxDD.toFixed(3)),
    finalEquityR: Number(equity.toFixed(3)),
    peakEquityR: Number(peak.toFixed(3)),
    drawdownFromIndex: peakAt,
    drawdownToIndex: troughAt,
    curve,
  };
}

function stats(list) {
  const n = list.length;
  if (n === 0) {
    return { n: 0, winRate: 0, avgGain: 0, avgLoss: 0, expectancy: 0, avgMfe: 0, avgMae: 0, profitFactor: null };
  }
  const wins = list.filter((x) => x.outcome === 'WIN');
  const losses = list.filter((x) => x.outcome === 'LOSS');
  const decided = wins.length + losses.length;

  const sumWin = wins.reduce((a, x) => a + x.r, 0);
  const sumLoss = losses.reduce((a, x) => a + Math.abs(x.r), 0);

  return {
    n,
    decided,
    undecided: n - decided,
    wins: wins.length,
    losses: losses.length,
    // win rate คิดจากไม้ที่ตัดสินผลได้แล้วเท่านั้น (ไม่รวม UNDECIDED)
    winRate: decided > 0 ? (wins.length / decided) * 100 : 0,
    avgGain: wins.length > 0 ? sumWin / wins.length : 0,
    avgLoss: losses.length > 0 ? -(sumLoss / losses.length) : 0,
    expectancy: list.reduce((a, x) => a + x.r, 0) / n,
    avgMfe: list.reduce((a, x) => a + x.mfe, 0) / n,
    avgMae: list.reduce((a, x) => a + x.mae, 0) / n,
    profitFactor: sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : null),
  };
}

// ═══════════════ ตัวหลัก ═══════════════
export async function runBacktest({ windowMin = 60, minScore = null } = {}) {
  const raw = (await readJson(SIGNALS_FILE, [])) || [];
  const all = Array.isArray(raw) ? raw : [];

  const signals = minScore != null ? all.filter((s) => Number(s.score) >= minScore) : all;

  if (signals.length === 0) {
    return {
      windowMin,
      totalSignals: all.length,
      evaluated: 0,
      skipped: 0,
      skipReasons: [],
      overall: stats([]),
      drawdown: computeMaxDrawdown([]),
      byScoreBucket: [],
      byFactor: [],
      byResistanceMethod: [],
      results: [],
      recommendation: all.length === 0
        ? 'ยังไม่มีประวัติสัญญาณเลย — กด Start Scanner ทิ้งไว้ให้ระบบเก็บข้อมูลก่อน แล้วกลับมาดูหน้านี้'
        : `ไม่มีสัญญาณที่คะแนน ≥ ${minScore}`,
      limitations: LIMITATIONS,
    };
  }

  // เรียงตามเวลา (จำเป็นสำหรับ equity curve / drawdown)
  const sorted = [...signals].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const results = [];
  const skipReasons = new Map();

  for (const sig of sorted) {
    try {
      const r = await evaluateSignal(sig, windowMin);
      if (r.skip) {
        skipReasons.set(r.reason, (skipReasons.get(r.reason) || 0) + 1);
      } else {
        results.push(r);
      }
    } catch (err) {
      const reason = `ประเมินผิดพลาด: ${err.message}`;
      skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
      log.warn(`backtest ${sig.symbol}: ${err.message}`);
    }
  }

  const overall = stats(results);
  const drawdown = computeMaxDrawdown(results.map((r) => r.r));

  // ---------- แยกตามช่วงคะแนน ----------
  const buckets = [[0, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
  const byScoreBucket = buckets.map(([lo, hi]) => {
    const inB = results.filter((r) => r.score >= lo && r.score < hi);
    return { label: `${lo}-${hi === 101 ? 100 : hi - 1}`, lo, hi, ...stats(inB) };
  }).filter((b) => b.n > 0);

  // ---------- แยกตามปัจจัย: เทียบไม้ที่ปัจจัยนั้นได้คะแนนสูง vs ต่ำ ----------
  const factorKeys = ['rvol', 'volatility', 'resistance', 'momentum', 'sentiment', 'liquidity'];
  const factorLabels = {
    rvol: 'RVOL', volatility: 'ความผันผวน', resistance: 'ระยะห่างแนวต้าน',
    momentum: 'Momentum', sentiment: 'News Sentiment', liquidity: 'Spread/สภาพคล่อง',
  };
  const byFactor = factorKeys.map((k) => {
    const withVal = results.filter((r) => Number.isFinite(r.factors?.[k]));
    if (withVal.length < 4) {
      return { key: k, label: factorLabels[k], insufficient: true, n: withVal.length };
    }
    const high = withVal.filter((r) => r.factors[k] >= 70);
    const low = withVal.filter((r) => r.factors[k] < 70);
    const hs = stats(high);
    const ls = stats(low);
    return {
      key: k,
      label: factorLabels[k],
      insufficient: false,
      highN: hs.n, highExpectancy: hs.expectancy, highWinRate: hs.winRate,
      lowN: ls.n, lowExpectancy: ls.expectancy, lowWinRate: ls.winRate,
      // ผลต่าง > 0 = ปัจจัยนี้ช่วยแยกไม้ดีออกจากไม้แย่ได้จริง
      edge: hs.n > 0 && ls.n > 0 ? hs.expectancy - ls.expectancy : null,
    };
  });

  // ---------- แยกตามวิธีหาแนวต้าน ----------
  const methods = [...new Set(results.map((r) => r.resistanceMethod).filter(Boolean))];
  const byResistanceMethod = methods.map((m) => ({
    method: m,
    label: { 'pivot-cluster': 'แนวต้านยืนยันแล้ว', 'lookback-high': 'จุดสูงสุดย้อนหลัง', projected: 'ค่าประมาณ ATR' }[m] || m,
    ...stats(results.filter((r) => r.resistanceMethod === m)),
  }));

  // ---------- คำแนะนำอัตโนมัติ ----------
  const recommendation = buildRecommendation(overall, byScoreBucket, results.length);

  return {
    windowMin,
    totalSignals: all.length,
    filteredByMinScore: minScore != null ? all.length - signals.length : 0,
    evaluated: results.length,
    skipped: [...skipReasons.values()].reduce((a, b) => a + b, 0),
    skipReasons: [...skipReasons.entries()].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    overall,
    drawdown,
    byScoreBucket,
    byFactor,
    byResistanceMethod,
    // ส่งแค่ 200 ไม้ล่าสุดไปแสดงในตาราง (กัน payload ใหญ่เกิน)
    results: results.slice(-200).reverse(),
    recommendation,
    limitations: LIMITATIONS,
  };
}

function buildRecommendation(overall, byScoreBucket, n) {
  if (n < 20) {
    return `ข้อมูลยังน้อย (${n} ไม้) — ตัวเลขที่เห็นยังไม่มีนัยสำคัญทางสถิติ ` +
           'ควรเก็บข้อมูลให้ได้อย่างน้อย 30-50 ไม้ก่อนสรุปว่าเกณฑ์ที่ตั้งไว้ใช้ได้จริงหรือไม่';
  }

  const good = byScoreBucket.filter((b) => b.n >= 5 && b.expectancy > 0.1).sort((a, b) => a.lo - b.lo);
  const parts = [];

  if (good.length > 0) {
    parts.push(`ช่วงคะแนน ${good[0].lo} ขึ้นไปเริ่มมีค่าคาดหวังเป็นบวก (${good[0].expectancy.toFixed(2)}R ต่อไม้ จาก ${good[0].n} ไม้) — พิจารณาตั้งเกณฑ์สัญญาณที่ ${good[0].lo}`);
  } else {
    parts.push('ยังไม่มีช่วงคะแนนไหนที่มีข้อมูลพอ (n≥5) และค่าคาดหวังเป็นบวกชัดเจน');
  }

  if (overall.expectancy < 0) {
    parts.push(`⚠️ ค่าคาดหวังรวมติดลบ (${overall.expectancy.toFixed(2)}R ต่อไม้) — เกณฑ์ปัจจุบันยังไม่ควรใช้กับเงินจริง`);
  }
  if (overall.winRate > 0 && overall.winRate < 35 && overall.avgGain < Math.abs(overall.avgLoss) * 2) {
    parts.push(`อัตราชนะต่ำ (${overall.winRate.toFixed(0)}%) และกำไรเฉลี่ยยังไม่ใหญ่พอชดเชย — ควรขยายเป้าหรือกระชับ stop`);
  }

  return parts.join(' · ');
}

const LIMITATIONS = [
  'ใช้ข้อมูลระดับแท่งเทียน ไม่ใช่ tick — ถ้าแท่งเดียวแตะทั้ง stop และเป้า จะนับเป็นแพ้ (สมมติแบบระมัดระวัง)',
  'ไม่คิดค่าคอมมิชชั่น ค่าธรรมเนียม และ slippage — ผลจริงจะแย่กว่าตัวเลขนี้',
  'ไม่คิดกรณีไม่ได้ราคาที่ต้องการ (partial fill) หรือสภาพคล่องไม่พอ',
  'ไม้ที่ยังไม่แตะ stop หรือเป้าภายในกรอบเวลา จะคิดผลจากราคาปิดของแท่งสุดท้าย (mark to market)',
  'เป็นการทดสอบย้อนหลังบนข้อมูลที่ระบบเคยเก็บไว้ ไม่ใช่การรับประกันผลในอนาคต',
];

// ---------- รันจาก command line: node src/backtest.js [นาที] ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const windowMin = Number(process.argv[2]) || 60;
  console.log(`📊 วิเคราะห์ผลย้อนหลัง (ดูผล ${windowMin} นาทีหลังให้สัญญาณ)...\n`);

  const r = await runBacktest({ windowMin });

  if (r.evaluated === 0) {
    console.log(r.recommendation);
    if (r.skipReasons.length > 0) {
      console.log('\nเหตุผลที่ประเมินไม่ได้:');
      for (const s of r.skipReasons) console.log(`  • ${s.reason} (${s.count} ครั้ง)`);
    }
    process.exit(0);
  }

  const o = r.overall;
  console.log(`สัญญาณทั้งหมด ${r.totalSignals} | ประเมินได้ ${r.evaluated} | ประเมินไม่ได้ ${r.skipped}`);
  console.log('');
  console.log('═══ ผลรวม ═══');
  console.log(`  อัตราชนะ (win rate) : ${o.winRate.toFixed(1)}%  (ชนะ ${o.wins} / แพ้ ${o.losses} / ยังไม่ตัดสิน ${o.undecided})`);
  console.log(`  กำไรเฉลี่ยเมื่อชนะ  : ${o.avgGain.toFixed(2)}R`);
  console.log(`  ขาดทุนเฉลี่ยเมื่อแพ้: ${o.avgLoss.toFixed(2)}R`);
  console.log(`  ค่าคาดหวังต่อไม้     : ${o.expectancy.toFixed(3)}R`);
  console.log(`  Profit factor        : ${o.profitFactor == null ? '—' : o.profitFactor === Infinity ? '∞' : o.profitFactor.toFixed(2)}`);
  console.log(`  Max drawdown         : ${r.drawdown.maxDrawdownR.toFixed(2)}R`);
  console.log(`  ทุนสะสมสุดท้าย       : ${r.drawdown.finalEquityR.toFixed(2)}R`);
  console.log('');
  console.log('═══ แยกตามช่วงคะแนน ═══');
  console.log('  ช่วง     |    n | ชนะ%  | ค่าคาดหวัง(R)');
  for (const b of r.byScoreBucket) {
    console.log(`  ${b.label.padEnd(8)} | ${String(b.n).padStart(4)} | ${b.winRate.toFixed(1).padStart(5)} | ${b.expectancy.toFixed(3).padStart(13)}`);
  }
  console.log('');
  console.log('═══ ปัจจัยไหนช่วยแยกไม้ดีออกจากไม้แย่ ═══');
  for (const f of r.byFactor) {
    if (f.insufficient) { console.log(`  ${f.label.padEnd(20)} ข้อมูลไม่พอ (${f.n} ไม้)`); continue; }
    const edge = f.edge == null ? '—' : `${f.edge >= 0 ? '+' : ''}${f.edge.toFixed(3)}R`;
    console.log(`  ${f.label.padEnd(20)} คะแนนสูง ${f.highExpectancy.toFixed(3)}R (n=${f.highN}) vs คะแนนต่ำ ${f.lowExpectancy.toFixed(3)}R (n=${f.lowN}) → ผลต่าง ${edge}`);
  }
  console.log('');
  console.log('═══ คำแนะนำ ═══');
  console.log(`  ${r.recommendation}`);
  console.log('');
  console.log('═══ ข้อจำกัดของการทดสอบนี้ ═══');
  for (const l of r.limitations) console.log(`  • ${l}`);
  console.log('');
}
