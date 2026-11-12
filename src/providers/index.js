// src/providers/index.js — ศูนย์กลางจัดการแหล่งข้อมูลทั้งหมด (adapter registry)
//
// หัวใจของไฟล์นี้: fallback แยกตาม "ชนิดข้อมูล" ไม่ใช่ตาม "provider"
// เพราะ Finnhub ฟรีให้ราคา realtime ได้ดี แต่ไม่ให้แท่งเทียนเลย (403)
// ถ้าเรียงลำดับแบบ provider เดียวรวบทุกอย่าง จะพังทันทีที่ขอแท่งเทียน
//
// ชนิดข้อมูล    ลำดับที่ใช้
// quote        Finnhub → Twelve Data → Yahoo
// bars         Yahoo → Twelve Data           (Finnhub ใช้ไม่ได้)
// earnings     Finnhub → Yahoo
// news         ตาม settings.newsProviderOrder (default: Alpha Vantage → Marketaux → Finnhub)
// fundamentals FMP
// screener     Yahoo

import yahoo from './yahoo.js';
import finnhub from './finnhub.js';
import twelvedata from './twelvedata.js';
import alphavantage from './alphavantage.js';
import marketaux from './marketaux.js';
import fmp from './fmp.js';
import mock, { mockEnabled } from './mock.js';
import { withBackoff, isAccessDeniedError } from './_shared.js';
import { settings } from '../settings.js';
import { log } from '../logbus.js';
import { marketOf } from '../markets.js'; // ★ หุ้นไทย

export const PROVIDERS = { yahoo, finnhub, twelvedata, alphavantage, marketaux, fmp, mock };
export const PROVIDER_LIST = [finnhub, twelvedata, alphavantage, marketaux, fmp, yahoo, mock];

// ลำดับ fallback ต่อชนิดข้อมูล
const BASE_CHAINS = {
  quote: ['finnhub', 'twelvedata', 'yahoo'],
  bars: ['yahoo', 'twelvedata'],
  earnings: ['finnhub', 'yahoo'],
  news: ['alphavantage', 'marketaux', 'finnhub'], // ถูกทับด้วย settings.newsProviderOrder
  fundamentals: ['fmp'],
  screener: ['yahoo'],
  fx: ['yahoo', 'twelvedata'], // ★ v2.1 — Yahoo ไม่ต้องใช้ key จึงอยู่หน้า
};

// เมื่อเปิดโหมดข้อมูลจำลอง (MOCK_DATA=true) ให้ mock อยู่หน้าสุดของทุก chain
// mock.isConfigured() คืน false เมื่อปิดโหมด → callChain ข้ามให้เองแม้ชื่อจะอยู่ใน chain
const CHAINS = Object.fromEntries(
  Object.entries(BASE_CHAINS).map(([k, v]) => [k, mockEnabled() ? ['mock', ...v] : v])
);

// ★ หุ้นไทย (.BK): ใช้ Yahoo เจ้าเดียว
// Finnhub / Twelve Data ฟรีไม่รองรับหุ้นไทย — ถ้าปล่อยตาม chain เดิม ทุกครั้งที่ขอราคาหุ้นไทย
// จะเผาโควตาของสองเจ้านี้ไปเปล่าๆ (Twelve Data มีแค่ 800 ครั้ง/วัน) จนหุ้นอเมริกาไม่มีตัวสำรองเหลือ
// ข่าว/sentiment และ float/short interest ของหุ้นไทยไม่มีแหล่งฟรี → ข้ามไปเลย (ได้คะแนนกลางๆ 50)
const TH_CHAINS = { quote: ['yahoo'], bars: ['yahoo'], earnings: ['yahoo'] };

function chainFor(capability, symbol) {
  if (marketOf(symbol) !== 'TH' || !TH_CHAINS[capability]) return null;
  return mockEnabled() ? ['mock', ...TH_CHAINS[capability]] : TH_CHAINS[capability];
}

// ★ หุ้นไทย: ข้อมูลฟรีช้ากว่าจริงราว 15-30 นาทีอยู่แล้ว ยิงถี่ไม่ได้ข้อมูลใหม่กว่า
// จึงเก็บ cache นานขึ้น ลดจำนวนคำขอต่อรอบ (หุ้นไทย 100 ตัว × 2 timeframe)
const TH_TTL = { quote: 60_000, bars: 120_000 };

// ★ หุ้นไทย: เก็บเฉพาะแท่งในช่วงซื้อขายต่อเนื่อง 10:00-12:30 และ 14:30-16:40 (รวมช่วงปิดตลาด)
// Yahoo ส่งแท่งช่วงพักเที่ยงมาด้วยโดยวอลุ่มเป็น 0 — ถ้าเก็บไว้ ATR จะหดเหลือเศษเสี้ยว
// RVOL สำรองเฟ้อ และระบบจะคิดว่าหุ้นถูกพักการซื้อขาย (3 แท่งล่าสุดไม่มีวอลุ่ม)
// แท่งสุดท้ายที่ยังไม่ปิด (วอลุ่ม 0) ก็ถูกตัดด้วย ไม่งั้น RVOL ของแท่งล่าสุดจะเป็น 0 ทุกตัว
// ดัชนี (^SET.BK) ไม่มีวอลุ่มเลยทุกแท่ง จึงกรองแค่ช่วงเวลา ไม่กรองวอลุ่ม
// ไทยไม่มีเวลาฤดูร้อน ใช้ UTC+7 ตรงๆ ได้ (เร็วกว่า Intl หลายสิบเท่า — แท่งนับพันต่อหุ้น)
function filterThaiSessionBars(bars, symbol) {
  const isIndex = String(symbol).startsWith('^');
  return bars.filter((b) => {
    if (!isIndex && !(b.volume > 0)) return false;
    const t = new Date(b.date).getTime();
    const m = Math.floor(((t / 60_000) + 7 * 60) % 1440);
    return (m >= 600 && m < 750) || (m >= 870 && m < 1000);
  });
}

// ---------- ส่ง API key จาก settings เข้า provider ----------
export function applyKeys() {
  const keys = settings.get('apiKeys') || {};
  finnhub.setKey(keys.finnhub);
  alphavantage.setKey(keys.alphavantage);
  twelvedata.setKey(keys.twelvedata);
  marketaux.setKey(keys.marketaux);
  fmp.setKey(keys.fmp);
}
applyKeys();
settings.on('change', applyKeys); // user แก้ key ในหน้า Settings → มีผลทันที ไม่ต้องรีสตาร์ท

// ---------- cache ----------
// TTL ต่างกันตามชนิดข้อมูล: ราคาต้องสด แต่วันประกาศงบเปลี่ยนปีละ 4 ครั้ง
const TTL = {
  quote: 20_000,          // 20 วินาที
  bars: 45_000,           // 45 วินาที
  dailyBars: 12 * 3_600_000, // 12 ชั่วโมง (ใช้คำนวณ Expected Move)
  earnings: 6 * 3_600_000,   // 6 ชั่วโมง
  news: 6 * 3_600_000,       // 6 ชั่วโมง (ประหยัดโควตา Alpha Vantage 25/วัน)
  fundamentals: 12 * 3_600_000,
  screener: 120_000,      // 2 นาที
  fx: 15 * 60_000,        // ★ v2.1 — 15 นาที (ค่าเงินขยับช้ากว่าหุ้นมาก)
};

const cache = new Map(); // key -> { value, ts }
const inflight = new Map(); // key -> Promise (กันการยิงซ้ำพร้อมกันสำหรับ key เดียวกัน)

function cacheGet(key, ttl) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.ts > ttl) { cache.delete(key); return undefined; }
  return e.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
  // กัน memory โตไม่จำกัดถ้ารันทิ้งไว้เป็นวัน
  if (cache.size > 4000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 1000);
    for (const [k] of oldest) cache.delete(k);
  }
}
export function clearCache() { cache.clear(); }

// ---------- สถิติความล้มเหลว (ใช้ตัดสินว่าจะขึ้นเตือน "ข้อมูลไม่อัปเดต") ----------
const lastFailure = new Map(); // "capability:symbol" -> { at, message, triedProviders }
export function getLastFailure(capability, symbol) {
  return lastFailure.get(`${capability}:${symbol}`);
}

// ---------- ตัวกลางเรียก provider ตามลำดับ fallback ----------
// พยายามทีละ provider: ถ้าตัวแรกล้ม (หลัง retry แล้ว) ก็ไปตัวถัดไป
// ถ้าล้มหมด throw error รวมที่บอกว่าลองอะไรไปแล้วบ้าง
async function callChain(capability, method, args, { cacheKey, ttl, preferredOrder = null } = {}) {
  if (cacheKey) {
    const hit = cacheGet(cacheKey, ttl);
    if (hit !== undefined) return hit;
    // มีคำขอเดียวกันกำลังวิ่งอยู่ → รอผลของมัน ไม่ยิงใหม่
    const running = inflight.get(cacheKey);
    if (running) return running;
  }

  const exec = async () => {
    const order = preferredOrder || CHAINS[capability] || [];
    const attempts = [];
    const skipped = [];

    for (const id of order) {
      const p = PROVIDERS[id];
      if (!p) continue;
      if (!p.capabilities.includes(capability)) continue;
      if (!p.isConfigured()) { skipped.push(`${p.name}(ไม่มี key)`); continue; }
      if (typeof p[method] !== 'function') { skipped.push(`${p.name}(ไม่มีเมธอด)`); continue; }
      if (p._quota?.isDailyExhausted()) { skipped.push(`${p.name}(โควตาหมด)`); continue; }

      try {
        const value = await withBackoff(() => p[method](...args), {
          label: `${p.name}.${method}(${args[0] ?? ''})`,
        });
        if (cacheKey) cacheSet(cacheKey, value);
        lastFailure.delete(`${capability}:${args[0]}`);
        return value;
      } catch (err) {
        attempts.push(`${p.name}: ${err.message}`);
        // endpoint ไม่อยู่ใน free tier = ปัญหาถาวร ไปตัวถัดไปทันที (ไม่ต้อง retry)
        if (!isAccessDeniedError(err)) {
          log.warn(`${p.name} ให้ ${capability} ของ ${args[0] ?? ''} ไม่ได้: ${err.message}`);
        }
      }
    }

    const detail = [...attempts, ...(skipped.length ? [`ข้าม: ${skipped.join(', ')}`] : [])].join(' | ');
    const err = new Error(`ไม่มีแหล่งข้อมูลไหนให้ ${capability} ของ ${args[0] ?? ''} ได้ — ${detail || 'ไม่มี provider ที่ตั้งค่าไว้'}`);
    err.capability = capability;
    err.attempts = attempts;
    err.skipped = skipped;
    lastFailure.set(`${capability}:${args[0]}`, {
      at: Date.now(),
      message: err.message,
      triedProviders: order,
    });
    throw err;
  };

  if (!cacheKey) return exec();

  const promise = exec().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, promise);
  return promise;
}

// ================= API ที่ scanner เรียกใช้ =================

// ---------- ราคาปัจจุบัน ----------
// เพิ่มฟิลด์คำนวณ: ageSec (ข้อมูลเก่ากี่วินาที), stale (เก่าเกินเกณฑ์), spreadPct
export async function getQuote(symbol) {
  const isTh = marketOf(symbol) === 'TH';
  const raw = await callChain('quote', 'quote', [symbol], {
    cacheKey: `quote:${symbol}`,
    ttl: isTh ? TH_TTL.quote : TTL.quote,
    preferredOrder: chainFor('quote', symbol),
  });

  // ★ หุ้นไทย: ข้อมูลช้ากว่าจริงเป็นปกติ ใช้เกณฑ์ความสดแยก (ไม่งั้นหุ้นไทยทุกตัวจะเป็น "ข้อมูลไม่อัปเดต")
  const maxStale = isTh ? (settings.get('thMaxQuoteStaleSec') ?? 2700) : settings.get('maxQuoteStaleSec');
  const ageSec = (Date.now() - raw.ts) / 1000;

  let spreadPct = null;
  if (typeof raw.bid === 'number' && typeof raw.ask === 'number' && raw.bid > 0 && raw.ask > 0) {
    const mid = (raw.bid + raw.ask) / 2;
    spreadPct = mid > 0 ? ((raw.ask - raw.bid) / mid) * 100 : null;
  }

  return { ...raw, ageSec, stale: ageSec > maxStale, spreadPct };
}

// ---------- แท่งเทียน intraday ----------
// stitch = เอาราคา realtime ล่าสุดมา "เย็บ" แท่งสุดท้าย (แท่งที่ยังไม่ปิด)
// เพราะ Yahoo อัปเดตแท่งช้ากว่าราคา quote — ถ้าไม่เย็บ ราคาที่ใช้คำนวณจะช้าไป 1-5 นาที
export async function getBars(symbol, tf, days = 30, { stitch = true } = {}) {
  const isTh = marketOf(symbol) === 'TH';
  const res = await callChain('bars', 'bars', [symbol, tf, days], {
    cacheKey: `bars:${symbol}:${tf}:${days}`,
    ttl: isTh ? TH_TTL.bars : TTL.bars,
    preferredOrder: chainFor('bars', symbol),
  });

  // clone เพื่อไม่ให้การเย็บไปแก้ค่าใน cache
  let bars = res.bars.map((b) => ({ ...b }));
  if (isTh && tf !== '1d') bars = filterThaiSessionBars(bars, symbol); // ★ ตัดแท่งพักเที่ยง/แท่งเปล่า
  const out = { ...res, bars, stitched: false, quote: null };

  if (stitch && bars.length > 0) {
    try {
      const q = await getQuote(symbol);
      out.quote = q;
      if (q && !q.stale) {
        const last = bars[bars.length - 1];
        last.close = q.price;
        last.high = Math.max(last.high, q.price);
        last.low = Math.min(last.low, q.price);
        out.stitched = true;
      }
    } catch {
      // เย็บไม่สำเร็จไม่ใช่ความล้มเหลว — ใช้แท่งดิบต่อได้ แค่ข้อมูลช้าลงหน่อย
    }
  }

  return out;
}

// ---------- แท่งเทียนรายวัน (สำหรับ Expected Move จาก ATR 14 วัน) ----------
export async function getDailyBars(symbol, days = 60) {
  return callChain('bars', 'bars', [symbol, '1d', days], {
    cacheKey: `dailybars:${symbol}:${days}`, // ต้องมี days ใน key ไม่งั้นผู้เรียกที่ขอจำนวนวันต่างกันจะได้ผลของกันและกัน
    ttl: TTL.dailyBars,
    preferredOrder: chainFor('bars', symbol),
  });
}

// ---------- ★ v2.1: อัตราแลกเปลี่ยน ----------
// คืน { pair, rate, ts, history[{date,rate}], source }
// cache 15 นาที — ค่าเงินขยับช้ากว่าหุ้นมาก ยิงถี่กว่านี้คือเผาโควตาเปล่า
export async function getFxRate(pair = 'USD/THB', days = 400) {
  return callChain('fx', 'fx', [pair, days], {
    cacheKey: `fx:${pair}:${days}`,
    ttl: TTL.fx,
  });
}

// ---------- วันประกาศงบ ----------
// ไม่ throw — ถ้าเช็คไม่ได้ให้ถือว่า "ไม่รู้" ไม่ใช่ "ไม่มีงบ"
export async function getEarnings(symbol) {
  try {
    return await callChain('earnings', 'earnings', [symbol], {
      cacheKey: `earnings:${symbol}`,
      ttl: TTL.earnings,
      preferredOrder: chainFor('earnings', symbol),
    });
  } catch {
    return { symbol, earningsDate: null, daysUntil: null, unknown: true, source: null };
  }
}

// ---------- ข่าว + sentiment ----------
// ลำดับ provider อ่านจาก settings (user เปลี่ยนได้ในหน้า Settings)
// ไม่ throw — ไม่มีข่าว ≠ ข่าวร้าย จึงคืน sentiment: null ให้ scoring ตีเป็นกลาง
export async function getNews(symbol) {
  if (marketOf(symbol) === 'TH') { // ★ ไม่มีแหล่งข่าวหุ้นไทยฟรี — ไม่เผาโควตา Alpha Vantage 25 ครั้ง/วัน
    return { symbol, sentiment: null, articleCount: 0, headlines: [], unavailable: true, source: null };
  }
  const configured = settings.get('newsProviderOrder') || BASE_CHAINS.news;
  const order = mockEnabled() ? ['mock', ...configured] : configured;
  try {
    return await callChain('news', 'news', [symbol], {
      cacheKey: `news:${symbol}`,
      ttl: TTL.news,
      preferredOrder: order,
    });
  } catch {
    return { symbol, sentiment: null, articleCount: 0, headlines: [], unavailable: true, source: null };
  }
}

// ---------- float / short interest ----------
export async function getFundamentals(symbol) {
  // ★ หุ้นไทย: FMP ฟรีไม่มีข้อมูล และถ้าเจอคำตอบแบบ "ต้องจ่ายเงิน" จะปิด endpoint นั้นทั้ง session
  //    (หุ้นอเมริกาโดนปิดไปด้วย) — จึงไม่ยิงเลย
  if (marketOf(symbol) === 'TH') return { symbol, floatShares: null, shortPct: null, unavailable: true, source: null };
  try {
    return await callChain('fundamentals', 'fundamentals', [symbol], {
      cacheKey: `fundamentals:${symbol}`,
      ttl: TTL.fundamentals,
    });
  } catch {
    return { symbol, floatShares: null, shortPct: null, unavailable: true, source: null };
  }
}

// ---------- screener ----------
export async function getScreener(scrId, count = 30) {
  try {
    return await callChain('screener', 'screener', [scrId, count], {
      cacheKey: `screener:${scrId}:${count}`,
      ttl: TTL.screener,
    });
  } catch (err) {
    log.warn(`ดึง screener "${scrId}" ไม่สำเร็จ: ${err.message}`);
    return [];
  }
}

// ---------- ตรวจว่า ticker มีจริงหรือไม่ (ใช้ตอน user เพิ่มใน watchlist — สเปกข้อ 3) ----------
export async function validateTicker(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();

  // ตรวจรูปแบบก่อน ประหยัด API call
  if (!sym) return { ok: false, symbol: sym, reason: 'ไม่ได้กรอกสัญลักษณ์' };
  // ★ หุ้นไทยมีสัญลักษณ์อย่าง S&J.BK, L&E.BK และชื่อยาวกว่า 10 ตัวอักษรได้ (CPNREIT.BK)
  if (!/^[A-Z][A-Z0-9.\-&]{0,14}$/.test(sym)) {
    return { ok: false, symbol: sym, reason: 'รูปแบบสัญลักษณ์ไม่ถูกต้อง (ใช้ A-Z, 0-9, . - และ & ไม่เกิน 15 ตัว · หุ้นไทยให้ต่อท้ายด้วย .BK เช่น PTT.BK)' };
  }

  try {
    const q = await getQuote(sym);
    if (!q || typeof q.price !== 'number' || q.price <= 0) {
      return { ok: false, symbol: sym, reason: 'ไม่พบราคาของสัญลักษณ์นี้' };
    }
    return { ok: true, symbol: sym, price: q.price, source: q.source };
  } catch (err) {
    return { ok: false, symbol: sym, reason: `ตรวจสอบไม่สำเร็จ: ${err.message}` };
  }
}

// ---------- สถานะ provider ทั้งหมด (ส่งไปแสดงในหน้าเว็บ — สเปกข้อ 5.5) ----------
export function getProviderStatus() {
  return PROVIDER_LIST.map((p) => {
    const q = p.getQuota();
    const configured = p.isConfigured();
    let status = 'ok';
    let statusText = 'พร้อมใช้งาน';

    if (!configured) {
      status = 'disabled';
      statusText = p.requiresKey ? 'ยังไม่ใส่ API key — ข้าม provider นี้' : 'ปิดใช้งาน';
    } else if (q.perDay != null && q.remainingDay === 0) {
      status = 'exhausted';
      statusText = 'โควตารายวันหมดแล้ว';
    } else if (q.currentlyFailing && q.lastError) {
      // ขึ้น degraded เฉพาะเมื่อ error ล่าสุดเกิดหลังความสำเร็จล่าสุด (ยังมีปัญหาอยู่จริง)
      status = 'degraded';
      statusText = `กำลังมีปัญหา: ${q.lastError}`;
    } else if (q.errors > 0) {
      statusText = `พร้อมใช้งาน (เคยมีข้อผิดพลาด ${q.errors} ครั้งวันนี้ แต่ล่าสุดเรียกสำเร็จ)`;
    }

    return {
      id: p.id,
      name: p.name,
      capabilities: p.capabilities,
      requiresKey: p.requiresKey,
      signupUrl: p.signupUrl || null,
      notes: p.notes || null,
      configured,
      status,
      statusText,
      quota: q,
    };
  });
}

// ---------- ลำดับ fallback (แสดงในหน้า Settings ให้ user เข้าใจว่าอะไรใช้อะไร) ----------
export function getChains() {
  const configured = settings.get('newsProviderOrder') || BASE_CHAINS.news;
  const news = mockEnabled() ? ['mock', ...configured] : configured;
  return { ...CHAINS, news };
}

// โหมดข้อมูลจำลองเปิดอยู่หรือไม่ (server ส่งไปให้ UI ขึ้นแบนเนอร์เตือน)
export function isMockMode() { return mockEnabled(); }

// สำหรับชุดทดสอบเท่านั้น
export { filterThaiSessionBars as _filterThaiSessionBars };
