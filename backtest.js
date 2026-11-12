// backtest.js — วิเคราะห์ย้อนหลังว่าสัญญาณที่เคยส่งไป (journal kind='signal') ผลลัพธ์เป็นอย่างไร
// ใช้: npm run backtest [นาทีที่จะดูย้อนหลัง เช่น 60]
import { CFG } from './config.js';
import { readJournal } from './journal.js';
import { getBars } from './datafeed.js';

const windowMin = Number(process.argv[2]) || 60;

async function evaluateSignal(sig) {
  const riskPerShare = sig.entry - sig.stop;
  if (!riskPerShare || riskPerShare <= 0) return null;

  const bars = await getBars(sig.symbol, sig.tf, 10);
  if (!bars || bars.length === 0) return null;

  const sigTime = new Date(sig.ts).getTime();
  const windowEnd = sigTime + windowMin * 60_000;
  const windowBars = bars.filter((b) => {
    const t = new Date(b.date).getTime();
    return t >= sigTime && t <= windowEnd;
  });
  if (windowBars.length === 0) return null;

  let outcome = 'UNDECIDED';
  let mfe = -Infinity;
  let mae = Infinity;

  for (const b of windowBars) {
    const rHigh = (b.high - sig.entry) / riskPerShare;
    const rLow = (b.low - sig.entry) / riskPerShare;
    mfe = Math.max(mfe, rHigh);
    mae = Math.min(mae, rLow);

    if (b.low <= sig.stop) {
      outcome = 'LOSS';
      break;
    }
    if (b.high >= sig.tp1) {
      outcome = 'WIN';
      break;
    }
  }

  return {
    symbol: sig.symbol,
    score: sig.score,
    reasons: sig.reasons || [],
    outcome,
    mfe: mfe === -Infinity ? 0 : mfe,
    mae: mae === Infinity ? 0 : mae,
    r: outcome === 'WIN' ? CFG.atrTp1 : outcome === 'LOSS' ? -1 : null,
  };
}

function fmt(n, d = 2) {
  return Number.isFinite(n) ? n.toFixed(d) : '-';
}

async function main() {
  console.log(`📊 กำลังวิเคราะห์ผลย้อนหลังของสัญญาณ (ดูผล ${windowMin} นาทีหลังส่งสัญญาณ)...\n`);

  const signals = await readJournal('signal');
  if (signals.length === 0) {
    console.log('ยังไม่มีข้อมูลสัญญาณใน logs/journal.jsonl เลย');
    console.log('ต้องรันโปรแกรมสแกน (npm start หรือ npm run dry) ทิ้งไว้สักพักก่อน ถึงจะมีข้อมูลให้ backtest');
    return;
  }

  const results = [];
  for (const sig of signals) {
    try {
      const r = await evaluateSignal(sig);
      if (r) results.push(r);
    } catch (err) {
      console.error(`⚠️  วิเคราะห์สัญญาณ ${sig.symbol} ผิดพลาด: ${err.message}`);
    }
  }

  const decided = results.filter((r) => r.outcome !== 'UNDECIDED');
  console.log(`รวมสัญญาณทั้งหมด ${signals.length} รายการ | ตัดสินผลได้ ${decided.length} รายการ (ที่เหลือยังไม่ถึงสต็อป/เป้าภายใน ${windowMin} นาที)\n`);

  // ---------- ตารางที่ 1: แยกตามช่วงคะแนน ----------
  console.log('=== ตารางที่ 1: ผลลัพธ์แยกตามช่วงคะแนน ===');
  console.log('ช่วงคะแนน   | จำนวน | ชนะ%   | MFE เฉลี่ย(R) | MAE เฉลี่ย(R) | Expectancy(R)');
  const buckets = [
    [0, 70],
    [70, 80],
    [80, 90],
    [90, 100],
  ];
  const bucketExpectancy = [];
  for (const [lo, hi] of buckets) {
    const inBucket = decided.filter((r) => r.score >= lo && (hi === 100 ? r.score <= hi : r.score < hi));
    const n = inBucket.length;
    const wins = inBucket.filter((r) => r.outcome === 'WIN').length;
    const winPct = n ? (wins / n) * 100 : 0;
    const avgMfe = n ? inBucket.reduce((a, r) => a + r.mfe, 0) / n : 0;
    const avgMae = n ? inBucket.reduce((a, r) => a + r.mae, 0) / n : 0;
    const expectancy = n ? inBucket.reduce((a, r) => a + r.r, 0) / n : 0;
    bucketExpectancy.push({ lo, hi, n, expectancy });
    console.log(
      `${String(lo).padStart(3)}-${String(hi).padEnd(3)} | ${String(n).padStart(5)} | ${fmt(winPct, 1).padStart(6)} | ${fmt(avgMfe).padStart(12)} | ${fmt(avgMae).padStart(12)} | ${fmt(expectancy).padStart(12)}`
    );
  }

  // ---------- ตารางที่ 2: แยกตาม reason tag ----------
  console.log('\n=== ตารางที่ 2: ผลลัพธ์แยกตามเหตุผลของสัญญาณ (แสดงเฉพาะที่มีข้อมูลตัดสินผล >= 3 ครั้ง) ===');
  console.log('เหตุผล                                    | จำนวน | Expectancy(R)');
  const byReason = new Map();
  for (const r of decided) {
    for (const reason of r.reasons) {
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push(r.r);
    }
  }
  const reasonRows = [...byReason.entries()]
    .filter(([, rs]) => rs.length >= 3)
    .map(([reason, rs]) => ({ reason, n: rs.length, expectancy: rs.reduce((a, b) => a + b, 0) / rs.length }))
    .sort((a, b) => b.expectancy - a.expectancy);

  if (reasonRows.length === 0) {
    console.log('(ยังไม่มีเหตุผลไหนที่มีข้อมูลตัดสินผลครบ 3 ครั้งขึ้นไป)');
  } else {
    for (const row of reasonRows) {
      console.log(`${row.reason.padEnd(42)} | ${String(row.n).padStart(5)} | ${fmt(row.expectancy).padStart(12)}`);
    }
  }

  // ---------- คำแนะนำอัตโนมัติ ----------
  console.log('\n=== คำแนะนำ ===');
  const good = bucketExpectancy.filter((b) => b.n >= 5 && b.expectancy > 0.1).sort((a, b) => a.lo - b.lo);
  if (good.length > 0) {
    console.log(`แนะนำให้ตั้ง MIN_SCORE ≈ ${good[0].lo} (ช่วงคะแนนนี้ขึ้นไปเริ่มมี Expectancy เป็นบวกอย่างมีนัยสำคัญ)`);
  } else {
    console.log(`ยังไม่มีช่วงคะแนนไหนที่มีข้อมูลมากพอ (n>=5) และ Expectancy เป็นบวกชัดเจน — แนะนำให้เก็บข้อมูลเพิ่มก่อนปรับ MIN_SCORE (ค่าปัจจุบัน: ${CFG.minScore})`);
  }
  console.log('\nหมายเหตุ: ผลลัพธ์นี้เป็นการประมาณจากข้อมูลที่มี ไม่ใช่คำแนะนำการลงทุน โปรดใช้วิจารณญาณประกอบ\n');
}

main().catch((err) => {
  console.error(`❌ backtest ทำงานผิดพลาด: ${err.message}`);
  process.exit(1);
});
