// monitor.js — จุดเริ่มโปรแกรม: สแกนหาสัญญาณเข้า (scanLoop) และเช็คสัญญาณออก (exitLoop) พร้อมกัน
import { CFG, sleep, nyNow, marketOpen, validateConfig } from './config.js';
import { getQuote, getBars, getEventRisk, looksHalted, screener, getLastError, isRateLimitError } from './datafeed.js';
import { sma, ema, rsi, atr, sessionVwap, rvolByTimeOfDay } from './indicators.js';
import { getRegime } from './market.js';
import { guard, track, checkExits, dayStats } from './positions.js';
import { logEvent } from './journal.js';
import { pushLine, buildFlex, buildExitFlex } from './line.js';

validateConfig();

// ---------- สร้าง universe (รายชื่อหุ้นที่จะสแกน) ----------
export async function buildUniverse() {
  const bySymbol = new Map(); // symbol -> quote-ish object จาก screener
  const mostActive = new Set();

  for (const scrId of CFG.screeners) {
    const quotes = await screener(scrId, CFG.universeSize);
    for (const q of quotes) {
      if (!q?.symbol) continue;
      bySymbol.set(q.symbol, q);
      if (scrId === 'most_actives') mostActive.add(q.symbol);
    }
  }

  const symbols = [];
  for (const [symbol, q] of bySymbol) {
    const price = q.regularMarketPrice;
    const avgVol = q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? 0;
    if (typeof price !== 'number') continue;
    if (price < CFG.minPrice || price > CFG.maxPrice) continue;
    if (avgVol < CFG.minAvgVolume) continue;
    symbols.push(symbol);
  }

  // เพิ่มหุ้นที่ผู้ใช้ระบุเองเสมอ (ไว้ใจการเลือกของผู้ใช้ ไม่กรองซ้ำ)
  for (const t of CFG.extraTickers) {
    if (!symbols.includes(t)) symbols.push(t);
  }

  return { symbols: symbols.slice(0, CFG.universeSize), mostActive };
}

// ---------- วิเคราะห์หุ้น 1 ตัว 1 timeframe ----------
async function analyse(symbol, tf, isMostActive, regime, rejects) {
  const reject = (why) => {
    rejects.set(why, (rejects.get(why) || 0) + 1);
    return null;
  };

  // 1) ดึงแท่งเทียน + เช็คว่าข้อมูลพอไหม + เช็ค halt
  const minBars = CFG.lookback + 25;
  const bars = await getBars(symbol, tf, 30);
  if (!bars || bars.length < minBars) return reject('ข้อมูลแท่งเทียนไม่พอ');
  if (looksHalted(bars)) return reject('สงสัยว่าหยุดพักการซื้อขาย (halt)');

  const quote = bars.quote || (await getQuote(symbol));
  if (!quote) return reject('ดึงราคาปัจจุบันไม่ได้');

  // 2) เช็คคุณภาพราคา
  if (quote.stale) return reject('ราคาเก่าเกินไป (stale quote)');
  if (quote.spreadPct != null && quote.spreadPct > CFG.maxSpreadPct) return reject('ส่วนต่าง bid/ask กว้างเกินไป');

  // 3) เช็คข่าวประกาศงบ
  const eventRisk = await getEventRisk(symbol);
  if (eventRisk.blocked) return reject('ใกล้วันประกาศงบการเงิน');

  const closes = bars.map((b) => b.close);
  const price = quote.price;
  const reasons = [];
  let score = 0;

  // 4) EMA
  const e5 = ema(closes, 5);
  const e15 = ema(closes, 15);
  const n = closes.length;
  const [c1, c0] = [closes[n - 2], closes[n - 1]];
  const [e5p, e5c] = [e5[n - 2], e5[n - 1]];
  const [e15p, e15c] = [e15[n - 2], e15[n - 1]];

  if (e5p == null || e5c == null || e15p == null || e15c == null) {
    return reject('EMA คำนวณไม่ได้ (ข้อมูลไม่พอ)');
  }

  if (e5p <= e15p && e5c > e15c) {
    score += 35;
    reasons.push('Golden Cross EMA5/15');
  } else if (c1 <= e15p && c0 > e15c) {
    score += 28;
    reasons.push('ทะลุ EMA15');
  } else if (c1 <= e5p && c0 > e5c) {
    score += 22;
    reasons.push('ทะลุ EMA5');
  } else if (c0 > e5c && e5c > e15c) {
    score += 14;
    reasons.push('EMA เรียงตัวขาขึ้น (stacked)');
  } else {
    return reject('โครงสร้าง EMA ยังไม่เป็นขาขึ้น');
  }

  // 5) Volume / RVOL
  const barMinutes = tf === '5m' ? 5 : 15;
  const dollarVolume5m = (bars[n - 1].volume / barMinutes) * 5 * price;
  if (dollarVolume5m < CFG.minDollarVolume5m) return reject('มูลค่าซื้อขายต่ำเกินไป');

  let rvolInfo = rvolByTimeOfDay(bars, CFG.rvolDays);
  let rvol = rvolInfo.rvol;
  if (rvol == null) {
    const volumes = bars.map((b) => b.volume);
    const smaVol = sma(volumes.slice(0, -1), 20);
    rvol = smaVol ? volumes[n - 1] / smaVol : null;
  }

  if (rvol == null && !isMostActive) return reject('คำนวณ RVOL ไม่ได้');
  if (rvol != null && rvol < CFG.minRvolTod && !isMostActive) return reject('RVOL ต่ำกว่าเกณฑ์');

  if (rvol != null && rvol >= CFG.volSpike) {
    score += 25;
    reasons.push(`RVOL พุ่ง ${rvol.toFixed(2)}x`);
  } else if (rvol != null && rvol >= 1.5) {
    score += 12;
    reasons.push(`RVOL ${rvol.toFixed(2)}x`);
  }
  if (isMostActive) {
    score += 8;
    reasons.push('ติดโผหุ้นซื้อขายคึกคัก');
  }

  // 6) RSI
  const rsiSeries = rsi(closes, 14);
  const rNow = rsiSeries[n - 1];
  const rPrev = rsiSeries[n - 2];
  if (rNow == null) return reject('RSI คำนวณไม่ได้');

  if (rNow >= CFG.rsiLow && rNow <= CFG.rsiHigh) {
    score += 20;
    reasons.push(`RSI อยู่ในโซนดี (${rNow.toFixed(0)})`);
  } else if (rPrev != null && rPrev < CFG.rsiOversold && rNow >= CFG.rsiOversold) {
    score += 18;
    reasons.push(`RSI เด้งจากโซน oversold (${rNow.toFixed(0)})`);
  } else if (rNow >= CFG.rsiHigh) {
    score -= 10;
    reasons.push(`RSI สูงเกินไป (${rNow.toFixed(0)})`);
  } else {
    return reject('RSI อยู่ในโซนไม่ดี');
  }

  // 7) Breakout แนวต้าน
  const window = bars.slice(n - 1 - CFG.lookback, n - 1);
  const resistance = Math.max(...window.map((b) => b.high));
  const lastBar = bars[n - 1];
  const range = lastBar.high - lastBar.low;
  const bodyPct = range > 0 ? (Math.abs(lastBar.close - lastBar.open) / range) * 100 : 0;
  const bullishBody = lastBar.close > lastBar.open && bodyPct > 55;

  const atrSeries = atr(bars, 14);
  const atrValue = atrSeries[n - 1];
  if (atrValue == null) return reject('ATR คำนวณไม่ได้');

  if (lastBar.close > resistance && bullishBody) {
    score += 22;
    reasons.push('ทะลุแนวต้านด้วยแท่งบวกแรง');
  } else if (lastBar.close > resistance) {
    score += 14;
    reasons.push('ทะลุแนวต้าน');
  } else if (lastBar.close >= resistance - 0.25 * atrValue) {
    score += 6;
    reasons.push('ใกล้แนวต้าน');
  }

  // 8) VWAP
  const vwapSeries = sessionVwap(bars);
  const vwapNow = vwapSeries[n - 1];
  const vwapPrev = vwapSeries[n - 2];
  const aboveVwap = vwapNow != null && lastBar.close > vwapNow;

  if (vwapNow == null) return reject('VWAP คำนวณไม่ได้');

  if (vwapPrev != null && c1 < vwapPrev && c0 >= vwapNow) {
    score += 18;
    reasons.push('กลับขึ้นเหนือ VWAP (reclaim)');
  } else if (aboveVwap) {
    score += 10;
    reasons.push('อยู่เหนือ VWAP');
  } else if (CFG.requireVwap) {
    return reject('ราคาต่ำกว่า VWAP');
  }

  // 9) ATR / ระยะห่างจากราคา + คำนวณจุดเข้า-ออก
  const extension = (price - vwapNow) / atrValue;
  if (extension > CFG.maxExtension) return reject('ราคายืดตัวห่างจาก VWAP มากเกินไป');
  if (extension < 1.0) {
    score += 6;
    reasons.push('ยังไม่ยืดตัวมาก (ใกล้ VWAP)');
  }

  const swingLow6 = Math.min(...bars.slice(-6).map((b) => b.low));
  const stop = Math.min(price - CFG.atrStopMult * atrValue, swingLow6 - 0.15 * atrValue);
  const riskPerShare = price - stop;
  if (riskPerShare <= 0) return reject('คำนวณจุดตัดขาดทุนไม่ได้ (riskPerShare <= 0)');

  const tp1 = price + CFG.atrTp1 * riskPerShare;
  const tp2 = price + CFG.atrTp2 * riskPerShare;

  const dollarRisk = CFG.accountSize * (CFG.riskPct / 100);
  const shares = Math.floor((dollarRisk / riskPerShare) * regime.sizeMult);
  if (shares <= 0) return reject('จำนวนหุ้นคำนวณได้เป็น 0 (เสี่ยงต่อหุ้นสูงเกินไป)');

  // 10) เทียบคะแนนกับเกณฑ์ (ปรับตามภาวะตลาด)
  score = Math.max(0, Math.min(100, score));
  const threshold = CFG.minScore + regime.scoreAdj;
  if (score < threshold) return reject(`คะแนนต่ำกว่าเกณฑ์ (${score.toFixed(0)} < ${threshold.toFixed(0)})`);

  const prevClose = bars.meta?.previousClose ?? bars.meta?.chartPreviousClose ?? closes[0];
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  return {
    symbol,
    tf,
    score,
    price,
    entry: price,
    stop,
    tp1,
    tp2,
    shares,
    riskAmount: shares * riskPerShare,
    reasons,
    rsi: rNow,
    rvol,
    atr: atrValue,
    atrPct: (atrValue / price) * 100,
    aboveVwap,
    regime: regime.regime,
    source: quote.source,
    changePct,
    ts: new Date(),
  };
}

// ---------- ลูปสแกนหาสัญญาณเข้า ----------
const cooldown = new Map(); // "SYMBOL:TF" -> เวลาล่าสุดที่ส่งสัญญาณ (ms)
// ถ้า symbol ไหนโดน Yahoo rate limit ให้พักนานกว่าปกติก่อนสแกนซ้ำ (อย่างน้อย 2 เท่าของ cooldown ปกติ หรือ 10 นาที)
const RATE_LIMIT_COOLDOWN_MS = Math.max(CFG.cooldownMs * 2, 10 * 60 * 1000);

function printTopRejects(rejects) {
  const sorted = [...rejects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (sorted.length === 0) return '';
  return sorted.map(([why, count]) => `${why}(${count})`).join(', ');
}

export async function scanLoop() {
  for (;;) {
    try {
      if (!marketOpen()) {
        console.log(`⏸  ตลาดปิดอยู่ (โหมด session=${CFG.session}) — รอรอบถัดไป`);
        await sleep(CFG.pollMs);
        continue;
      }

      const g = guard();
      if (!g.ok) {
        console.log(`⛔ งดสแกนรอบนี้: ${g.why}`);
        await sleep(CFG.pollMs);
        continue;
      }

      const regime = await getRegime();
      const universe = await buildUniverse();
      const rejects = new Map();
      const candidates = [];

      for (const symbol of universe.symbols) {
        for (const tf of CFG.timeframes) {
          const key = `${symbol}:${tf}`;
          const lastSent = cooldown.get(key);
          if (lastSent && Date.now() - lastSent < CFG.cooldownMs) continue;

          try {
            const signal = await analyse(symbol, tf, universe.mostActive.has(symbol), regime, rejects);
            if (signal) {
              candidates.push(signal);
            } else if (isRateLimitError(getLastError(symbol))) {
              // symbol นี้โดน Yahoo จำกัดการเรียก (rate limit) — พักให้นานขึ้นกว่าปกติก่อนสแกนซ้ำ
              cooldown.set(key, Date.now() - CFG.cooldownMs + RATE_LIMIT_COOLDOWN_MS);
              console.log(`⏳ ${key} โดน rate limit — งดสแกนซ้ำ ${RATE_LIMIT_COOLDOWN_MS / 60_000} นาที`);
            }
          } catch (err) {
            console.error(`⚠️  วิเคราะห์ ${key} ผิดพลาด: ${err.message}`);
          }
          await sleep(500);
        }
      }

      candidates.sort((a, b) => b.score - a.score);

      const stats = dayStats();
      const openSlots = Math.max(0, CFG.maxOpenPositions - stats.open);
      const slots = Math.min(5, openSlots);
      const top = candidates.slice(0, slots);

      const messages = [];
      for (const signal of top) {
        track(signal);
        logEvent('signal', signal);
        cooldown.set(`${signal.symbol}:${signal.tf}`, Date.now());
        messages.push(buildFlex(signal));
      }
      if (messages.length > 0) await pushLine(messages);

      console.log(
        `🔎 สแกนแล้ว ${universe.symbols.length} ตัว พบผู้เข้ารอบ ${candidates.length} ส่งสัญญาณ ${top.length} | ภาวะตลาด: ${regime.regime} | ตกรอบเยอะสุด: ${printTopRejects(rejects) || '-'}`
      );
    } catch (err) {
      console.error(`❌ scanLoop ผิดพลาด (ทำงานต่อรอบถัดไป): ${err.message}`);
    }
    await sleep(CFG.pollMs);
  }
}

// ---------- ลูปเช็คสัญญาณออก ----------
export async function exitLoop() {
  for (;;) {
    try {
      const events = await checkExits();
      if (events.length > 0) {
        await pushLine(events.map(buildExitFlex));
        for (const e of events) {
          console.log(`${e.emoji} ${e.symbol} ${e.type} r=${e.r.toFixed(2)} ราคา=$${e.price.toFixed(2)}`);
        }
      }
    } catch (err) {
      console.error(`❌ exitLoop ผิดพลาด (ทำงานต่อรอบถัดไป): ${err.message}`);
    }
    await sleep(CFG.exitPollSec * 1000);
  }
}

// ---------- เริ่มโปรแกรม ----------
function printBanner() {
  console.log('==============================================');
  console.log(' 🩺 Scalp Scanner — ระบบสแกนหุ้นอเมริกา (scalping/day trade)');
  console.log('==============================================');
  console.log(`ผู้ให้บริการข้อมูล : ${CFG.provider}`);
  console.log(`Timeframe          : ${CFG.timeframes.join(', ')}`);
  console.log(`โหมดทำงาน          : ${CFG.dryRun ? 'ทดสอบ (dry-run) — ไม่ส่ง LINE จริง' : 'ทำงานจริง'}`);
  console.log(`เงินทุนที่ตั้งไว้    : $${CFG.accountSize.toLocaleString()}`);
  console.log(`ความเสี่ยงต่อไม้    : ${CFG.riskPct}% (${(CFG.accountSize * CFG.riskPct / 100).toFixed(2)} ดอลลาร์)`);
  console.log('==============================================\n');
}

function setupShutdown() {
  process.on('SIGINT', () => {
    const stats = dayStats();
    console.log('\n🛑 กำลังปิดโปรแกรม...');
    console.log(`สรุปวันนี้: กำไร/ขาดทุนสุทธิ ${stats.realizedR.toFixed(2)}R | ส่งสัญญาณไปแล้ว ${stats.alerts} ครั้ง | ไม้เปิดอยู่ ${stats.open} ไม้`);
    console.log('ขอบคุณที่ใช้งาน Scalp Scanner 🙏');
    process.exit(0);
  });
}

printBanner();
setupShutdown();
scanLoop();
exitLoop();
