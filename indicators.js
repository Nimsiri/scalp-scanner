// indicators.js — คำนวณอินดิเคเตอร์ทางเทคนิคทั้งหมดเอง ไม่พึ่ง library ภายนอก
// รูปแบบแท่งเทียน (bar) ที่ใช้ทั้งไฟล์: { date: Date, open, high, low, close, volume }

// แปลงเวลา Date เป็นส่วนประกอบตามเขตเวลาของตลาด (ค่าเริ่มต้น America/New_York)
// ใช้แยกวัน (dateKey) และช่วงเวลานาที (hour:minute) ของแท่งเทียนแต่ละแท่ง
// ★ หุ้นไทยส่ง 'Asia/Bangkok' — ไม่งั้น VWAP จะ reset ตอนเที่ยงคืนนิวยอร์ก (11:00-12:00 น. เวลาไทย กลางช่วงเช้า)
const DEFAULT_TZ = 'America/New_York';
const partsFmtCache = new Map(); // สร้าง formatter ครั้งเดียวต่อเขตเวลา (เดิมสร้างใหม่ทุกแท่ง)
function etParts(date, tz = DEFAULT_TZ) {
  let fmt = partsFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    partsFmtCache.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // บาง locale คืน 24:xx แทน 00:xx
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute: Number(map.minute),
  };
}

// ค่าเฉลี่ยเคลื่อนที่แบบธรรมดา (Simple Moving Average) ของ n ค่าล่าสุด — คืนค่าเดียว
export function sma(arr, n) {
  if (!Array.isArray(arr) || arr.length < n || n <= 0) return null;
  const slice = arr.slice(arr.length - n);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / n;
}

// ค่าเฉลี่ยเคลื่อนที่แบบ Exponential Moving Average — คืน array ความยาวเท่า arr
// seed ค่าแรกด้วย SMA ของ n ค่าแรก ตามสเปก
export function ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  if (!Array.isArray(arr) || arr.length < n || n <= 0) return out;

  const k = 2 / (n + 1);
  const seed = sma(arr.slice(0, n), n);
  out[n - 1] = seed;
  let prev = seed;
  for (let i = n; i < arr.length; i++) {
    const val = arr[i] * k + prev * (1 - k);
    out[i] = val;
    prev = val;
  }
  return out;
}

// RSI (Relative Strength Index) ด้วยวิธี Wilder smoothing — คืน array ความยาวเท่า closes
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (!Array.isArray(closes) || closes.length < period + 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ATR (Average True Range) ด้วยวิธี Wilder smoothing — คืน array ความยาวเท่า bars
export function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (!Array.isArray(bars) || bars.length < period + 1) return out;

  const trs = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    trs[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  let prevAtr = sum / period;
  out[period] = prevAtr;

  for (let i = period + 1; i < bars.length; i++) {
    prevAtr = (prevAtr * (period - 1) + trs[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

// VWAP รายวัน — reset ทุกวันตามเขตเวลาของตลาด (ค่าเริ่มต้น America/New_York) คืน array ความยาวเท่า bars
export function sessionVwap(bars, tz = DEFAULT_TZ) {
  const out = new Array(bars.length).fill(null);
  let cumPV = 0;
  let cumVol = 0;
  let curDay = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const { dateKey } = etParts(bar.date, tz);
    if (dateKey !== curDay) {
      curDay = dateKey;
      cumPV = 0;
      cumVol = 0;
    }
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumPV += typicalPrice * bar.volume;
    cumVol += bar.volume;
    out[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return out;
}

// ★ ราคาเฉลี่ยของวันแบบให้น้ำหนักเท่ากันทุกแท่ง (TWAP) — ใช้แทน VWAP เมื่อไม่มีวอลุ่ม
// (ดัชนี SET / SET50 บน Yahoo ส่งวอลุ่มเป็น 0 ทุกแท่ง ทำให้ VWAP คำนวณไม่ได้)
export function sessionTwap(bars, tz = DEFAULT_TZ) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  let count = 0;
  let curDay = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const { dateKey } = etParts(bar.date, tz);
    if (dateKey !== curDay) { curDay = dateKey; sum = 0; count = 0; }
    sum += (bar.high + bar.low + bar.close) / 3;
    count += 1;
    out[i] = sum / count;
  }
  return out;
}

// Relative Volume เทียบตามช่วงเวลาเดียวกันของวันก่อนหน้า (time-of-day RVOL)
// เทียบ volume ของแท่งล่าสุด กับ volume ของแท่งเวลาเดียวกัน (HH:MM ตาม ET) ย้อนหลังไม่เกิน `days` วัน
// ต้องมีตัวอย่างเทียบอย่างน้อย 3 วัน ไม่งั้นคืน {rvol: null}
export function rvolByTimeOfDay(bars, days = 10, tz = DEFAULT_TZ) {
  if (!Array.isArray(bars) || bars.length < 2) return { rvol: null };

  const last = bars[bars.length - 1];
  const lastParts = etParts(last.date, tz);

  const samples = [];
  const seenDays = new Set();
  for (let i = bars.length - 2; i >= 0 && seenDays.size < days; i--) {
    const bar = bars[i];
    const p = etParts(bar.date, tz);
    if (p.dateKey === lastParts.dateKey) continue; // ข้ามแท่งของวันเดียวกับแท่งล่าสุด
    if (p.hour === lastParts.hour && p.minute === lastParts.minute) {
      if (!seenDays.has(p.dateKey)) {
        seenDays.add(p.dateKey);
        samples.push(bar.volume);
      }
    }
  }

  if (samples.length < 3) return { rvol: null };
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  if (avg <= 0) return { rvol: null };
  return { rvol: last.volume / avg, samples: samples.length };
}

// แถบเบี่ยงเบนมาตรฐานรอบ VWAP (volume-weighted SD) เฉพาะแท่งของวันปัจจุบัน (วันของแท่งล่าสุด)
export function vwapBands(bars, vwapSeries, tz = DEFAULT_TZ) {
  if (!Array.isArray(bars) || bars.length === 0) return { sd: null, upper: null, lower: null };

  const lastIdx = bars.length - 1;
  const lastVwap = vwapSeries[lastIdx];
  if (lastVwap == null) return { sd: null, upper: null, lower: null };

  const { dateKey: today } = etParts(bars[lastIdx].date, tz);

  let sumWeightedSqDiff = 0;
  let sumVol = 0;
  for (let i = 0; i <= lastIdx; i++) {
    const bar = bars[i];
    if (etParts(bar.date, tz).dateKey !== today) continue;
    const vwap = vwapSeries[i];
    if (vwap == null) continue;
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    const diff = typicalPrice - vwap;
    sumWeightedSqDiff += bar.volume * diff * diff;
    sumVol += bar.volume;
  }

  if (sumVol <= 0) return { sd: null, upper: null, lower: null };
  const sd = Math.sqrt(sumWeightedSqDiff / sumVol);
  return { sd, upper: lastVwap + sd, lower: lastVwap - sd };
}
