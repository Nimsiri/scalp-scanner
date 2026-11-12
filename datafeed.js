// datafeed.js — ดึงราคา/แท่งเทียน/ข้อมูลประกอบจากผู้ให้บริการข้อมูล (default: Yahoo Finance)
// ทุกฟังก์ชันครอบด้วย try/catch เพื่อไม่ให้โปรแกรมล่มเงียบ ๆ เวลาอินเทอร์เน็ตมีปัญหา
import YahooFinance from 'yahoo-finance2';
import { CFG } from './config.js';

// ⚠️ อัปเกรด yahoo-finance2 v2 → v3 (v2 หมดอายุการสนับสนุนแล้ว)
// breaking change: default export เปลี่ยนจาก instance เป็น class ต้อง new เอง
//   v2: import yahooFinance from 'yahoo-finance2'; yahooFinance.suppressNotices([...]);
//   v3: import YahooFinance from 'yahoo-finance2'; new YahooFinance({ suppressNotices: [...] });
// และ suppressNotices ย้ายจากเมธอด ไปเป็น option ของ constructor
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  // Yahoo เปลี่ยนโครงสร้าง field บ่อย ถ้า validate เข้มจะ throw ทั้งที่ข้อมูลที่ใช้มาครบ
  validation: { logErrors: false, logOptionsErrors: false },
});

// ---------- cache แบบง่าย (Map + TTL) ----------
const cache = new Map();
const QUOTE_TTL_MS = 45_000; // แคชราคา/แท่งเทียน 45 วินาที (ยืดขึ้นจาก 20s เพื่อลดจำนวน request และลดโอกาสโดน rate limit)
const EARNINGS_TTL_MS = 6 * 60 * 60 * 1000; // แคชวันประกาศงบ 6 ชั่วโมง

function cacheGet(key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ---------- ป้องกัน HTTP 429 (Too Many Requests) ด้วย Exponential Backoff ----------
const BACKOFF_DELAYS_MS = [5_000, 15_000, 45_000]; // ลำดับเวลาที่จะรอก่อน retry

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// เดาว่า error ที่ได้มาเป็นสัญญาณของการโดน Yahoo จำกัดอัตราการเรียก (rate limit) หรือไม่
// (Yahoo มักตอบกลับเป็นหน้าข้อความธรรมดา ไม่ใช่ JSON เวลาโดน rate limit ทำให้ error มีได้หลายรูปแบบ)
export function isRateLimitError(err) {
  if (!err) return false;
  if (err.code === 429) return true;
  const msg = String(err.message || '');
  return /429|too many requests|invalid json response body|unexpected token/i.test(msg);
}

// เก็บ error ล่าสุดของแต่ละ symbol ไว้ (ใช้เช็คว่าครั้งล่าสุดที่ล้มเหลวเป็นเพราะโดน rate limit หรือไม่)
const lastErrors = new Map();
export function getLastError(symbol) {
  return lastErrors.get(symbol);
}

// เรียก fn() พร้อม retry แบบ exponential backoff ถ้าเจอสัญญาณ rate limit (429)
async function withBackoff(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === BACKOFF_DELAYS_MS.length) {
        throw err;
      }
      const waitMs = BACKOFF_DELAYS_MS[attempt];
      console.error(
        `⏳ ${label} โดน Yahoo จำกัดการเรียกข้อมูล (rate limit) — รอ ${waitMs / 1000} วินาที แล้วลองใหม่ (ครั้งที่ ${attempt + 1}/${BACKOFF_DELAYS_MS.length})...`
      );
      await sleepMs(waitMs);
    }
  }
  throw lastErr;
}

const TF_TO_INTERVAL = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '1d': '1d',
};

// ---------- ผู้ให้บริการสำรอง (fallback providers) ----------
// พยายามดึงราคาจาก Finnhub ถ้าตั้งค่า provider=finnhub และมี API key
async function quoteFromFinnhub(symbol) {
  if (!CFG.finnhubApiKey) throw new Error('ไม่มี FINNHUB_API_KEY');
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${CFG.finnhubApiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const j = await res.json();
  if (!j || typeof j.c !== 'number' || j.c === 0) throw new Error('Finnhub ไม่มีราคา');
  const ts = (j.t ? j.t * 1000 : Date.now());
  return { price: j.c, bid: null, ask: null, ts, source: 'finnhub' };
}

// พยายามดึงราคาจาก Alpaca ถ้าตั้งค่า provider=alpaca และมี API key/secret
async function quoteFromAlpaca(symbol) {
  if (!CFG.alpacaApiKey || !CFG.alpacaApiSecret) throw new Error('ไม่มี ALPACA_API_KEY/ALPACA_API_SECRET');
  const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': CFG.alpacaApiKey,
      'APCA-API-SECRET-KEY': CFG.alpacaApiSecret,
    },
  });
  if (!res.ok) throw new Error(`Alpaca HTTP ${res.status}`);
  const j = await res.json();
  const q = j?.quote;
  if (!q || typeof q.bp !== 'number' || typeof q.ap !== 'number') throw new Error('Alpaca ไม่มีราคา');
  const price = (q.bp + q.ap) / 2;
  const ts = q.t ? new Date(q.t).getTime() : Date.now();
  return { price, bid: q.bp, ask: q.ap, ts, source: 'alpaca' };
}

async function quoteFromYahoo(symbol) {
  const q = await withBackoff(() => yahooFinance.quote(symbol), `getQuote(${symbol})`);
  if (!q || typeof q.regularMarketPrice !== 'number') throw new Error('Yahoo ไม่มีราคา');
  const ts = q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : Date.now();
  return {
    price: q.regularMarketPrice,
    bid: typeof q.bid === 'number' ? q.bid : null,
    ask: typeof q.ask === 'number' ? q.ask : null,
    ts,
    source: 'yahoo',
  };
}

// ดึงราคาปัจจุบันของ symbol ตาม provider ที่ตั้งไว้ ถ้า error ให้ fallback มา Yahoo เสมอ
// คืน {price, bid, ask, ts, ageSec, stale, spreadPct, source}
export async function getQuote(symbol) {
  const cacheKey = `quote:${symbol}`;
  const cached = cacheGet(cacheKey, QUOTE_TTL_MS);
  if (cached) return cached;

  let raw;
  try {
    if (CFG.provider === 'finnhub') {
      raw = await quoteFromFinnhub(symbol);
    } else if (CFG.provider === 'alpaca') {
      raw = await quoteFromAlpaca(symbol);
    } else {
      raw = await quoteFromYahoo(symbol);
    }
  } catch (err) {
    // fallback มาที่ Yahoo เสมอถ้า provider หลักล้มเหลว
    try {
      raw = await quoteFromYahoo(symbol);
    } catch (err2) {
      lastErrors.set(symbol, err2);
      console.error(`⚠️  ดึงราคา ${symbol} ไม่สำเร็จ (ทั้ง ${CFG.provider} และ Yahoo): ${err2.message}`);
      return null;
    }
  }
  lastErrors.delete(symbol);

  const ageSec = (Date.now() - raw.ts) / 1000;
  const stale = ageSec > CFG.maxQuoteStaleSec;

  let spreadPct = null;
  if (typeof raw.bid === 'number' && typeof raw.ask === 'number' && raw.bid > 0 && raw.ask > 0) {
    const mid = (raw.bid + raw.ask) / 2;
    spreadPct = mid > 0 ? ((raw.ask - raw.bid) / mid) * 100 : null;
  }

  const result = {
    price: raw.price,
    bid: raw.bid,
    ask: raw.ask,
    ts: raw.ts,
    ageSec,
    stale,
    spreadPct,
    source: raw.source,
  };
  cacheSet(cacheKey, result);
  return result;
}

// ดึงแท่งเทียนย้อนหลัง `days` วัน timeframe `tf` แล้วกรองแท่งที่ close/volume เป็น null ทิ้ง
// ถ้า stitchLastBar=true และราคาล่าสุดไม่ stale จะ "เย็บ" แท่งสุดท้ายด้วยราคาปัจจุบัน
export async function getBars(symbol, tf, days) {
  const interval = TF_TO_INTERVAL[tf] || tf;
  const cacheKey = `bars:${symbol}:${tf}:${days}`;
  const cached = cacheGet(cacheKey, QUOTE_TTL_MS);
  if (cached) return cached;

  let chart;
  try {
    const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    chart = await withBackoff(() => yahooFinance.chart(symbol, { period1, interval }), `getBars(${symbol})`);
  } catch (err) {
    lastErrors.set(symbol, err);
    console.error(`⚠️  ดึงแท่งเทียน ${symbol} (${tf}) ไม่สำเร็จ: ${err.message}`);
    return null;
  }
  lastErrors.delete(symbol);

  const rawQuotes = Array.isArray(chart?.quotes) ? chart.quotes : [];
  const bars = rawQuotes
    .filter((q) => q && q.close != null && q.volume != null)
    .map((q) => ({
      date: q.date instanceof Date ? q.date : new Date(q.date),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
    }));

  bars.meta = chart?.meta || null;

  if (CFG.stitchLastBar && bars.length > 0) {
    try {
      const quote = await getQuote(symbol);
      if (quote && !quote.stale) {
        const last = bars[bars.length - 1];
        last.close = quote.price;
        last.high = Math.max(last.high, quote.price);
        last.low = Math.min(last.low, quote.price);
        last.stitched = true;
      }
      bars.quote = quote;
    } catch (err) {
      // เย็บแท่งไม่สำเร็จไม่ถือเป็นความล้มเหลว ใช้แท่งดิบต่อไปได้
      console.error(`⚠️  เย็บแท่งล่าสุด ${symbol} ไม่สำเร็จ: ${err.message}`);
    }
  }

  cacheSet(cacheKey, bars);
  return bars;
}

// เช็ควันประกาศงบของ symbol คืน {blocked, daysUntil, earningsDate}
export async function getEventRisk(symbol) {
  const cacheKey = `earnings:${symbol}`;
  const cached = cacheGet(cacheKey, EARNINGS_TTL_MS);
  if (cached) return cached;

  let result = { blocked: false, daysUntil: null, earningsDate: null };
  try {
    const summary = await withBackoff(
      () => yahooFinance.quoteSummary(symbol, { modules: ['calendarEvents'] }),
      `getEventRisk(${symbol})`
    );
    const earningsDates = summary?.calendarEvents?.earnings?.earningsDate;
    if (Array.isArray(earningsDates) && earningsDates.length > 0) {
      const nextDate = earningsDates
        .map((d) => (d instanceof Date ? d : new Date(d)))
        .sort((a, b) => a - b)[0];
      const daysUntil = (nextDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      result = {
        blocked: daysUntil >= 0 && daysUntil <= CFG.skipEarningsDays,
        daysUntil,
        earningsDate: nextDate,
      };
    }
  } catch (err) {
    // ถ้าดึงไม่ได้ ไม่ถือว่า blocked (ปล่อยผ่านแต่บันทึกไว้เพื่อ debug)
    console.error(`⚠️  เช็ควันประกาศงบ ${symbol} ไม่สำเร็จ: ${err.message}`);
  }

  cacheSet(cacheKey, result);
  return result;
}

// เดาว่าหุ้นถูกหยุดพักการซื้อขาย (halt) หรือไม่
// จริงถ้าแท่งล่าสุดเก่าเกิน haltGapSec วินาที หรือ 3 แท่งท้ายมี volume เป็น 0 ทั้งหมด
export function looksHalted(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return true;

  const last = bars[bars.length - 1];
  const ageSec = (Date.now() - new Date(last.date).getTime()) / 1000;
  if (ageSec > CFG.haltGapSec) return true;

  if (bars.length >= 3) {
    const lastThree = bars.slice(-3);
    if (lastThree.every((b) => b.volume === 0)) return true;
  }
  return false;
}

// ดึงรายชื่อหุ้นจาก screener ของ Yahoo (เช่น day_gainers, most_actives)
export async function screener(scrIds, count) {
  try {
    const res = await withBackoff(() => yahooFinance.screener({ scrIds, count }), `screener(${scrIds})`);
    return Array.isArray(res?.quotes) ? res.quotes : [];
  } catch (err) {
    console.error(`⚠️  ดึง screener "${scrIds}" ไม่สำเร็จ: ${err.message}`);
    return [];
  }
}
