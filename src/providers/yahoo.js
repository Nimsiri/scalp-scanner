// src/providers/yahoo.js — Yahoo Finance ผ่าน yahoo-finance2 v3
// บทบาท: แหล่ง "แท่งเทียน" หลัก (เพราะเป็นแหล่งฟรีเจ้าเดียวที่ให้ intraday bars แบบไม่จำกัดจำนวนหุ้น)
//         + screener + earnings สำรอง
// ไม่ต้องมี API key แต่ไม่มีการรับประกัน — โดน rate limit บ่อย จึงต้องพึ่ง backoff + cache
//
// ⚠️ Breaking change v2 → v3 ที่แก้ในไฟล์นี้:
//   v2: import yahooFinance from 'yahoo-finance2'; yahooFinance.suppressNotices([...])
//   v3: default export เป็น class ต้อง new + suppressNotices ย้ายไปเป็น constructor option

import YahooFinance from 'yahoo-finance2';
import { QuotaTracker, TF_MINUTES } from './_shared.js';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  // ปิด validation ของ schema — Yahoo เปลี่ยน field บ่อย ถ้า validate เข้มจะ throw
  // ทั้งที่ข้อมูลที่เราต้องการ (ราคา/แท่งเทียน) มาครบแล้ว
  validation: { logErrors: false, logOptionsErrors: false },
});

const quota = new QuotaTracker({ perMinute: null, perDay: null }); // Yahoo ไม่ประกาศโควตา

const TF_TO_INTERVAL = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d' };

// ---------- ★ ค่าเงิน: ดึงประวัติรายวัน + เรตล่าสุดของสัญลักษณ์เดียว ----------
async function fetchFxSeries(symbol, days) {
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const chart = await yf.chart(symbol, { period1, interval: '1d' });
  const history = (Array.isArray(chart?.quotes) ? chart.quotes : [])
    .filter((q) => q && Number.isFinite(q.close))
    .map((q) => ({ date: q.date instanceof Date ? q.date : new Date(q.date), rate: q.close }));

  // เรตล่าสุด: ลอง quote ก่อน (สดกว่า) ถ้าไม่ได้ใช้แท่งรายวันแท่งสุดท้าย
  let rate = null;
  let ts = null;
  try {
    const q = await yf.quote(symbol);
    if (Number.isFinite(q?.regularMarketPrice)) {
      rate = q.regularMarketPrice;
      ts = q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : Date.now();
    }
  } catch { /* ใช้แท่งรายวันแทน */ }
  if (!Number.isFinite(rate) && history.length > 0) {
    rate = history[history.length - 1].rate;
    ts = history[history.length - 1].date.getTime();
  }
  return { symbol, rate, ts, history };
}

// base/quote = (USD/quote) ÷ (USD/base) — จับคู่ตามวันที่ ข้ามวันที่ขาดข้อมูลฝั่งใดฝั่งหนึ่ง
async function crossViaUsd(base, quoteCur, days) {
  const [q, b] = await Promise.all([fetchFxSeries(`${quoteCur}=X`, days), fetchFxSeries(`${base}=X`, days)]);
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const baseByDay = new Map(b.history.filter((h) => h.rate > 0).map((h) => [dayKey(h.date), h.rate]));
  const history = q.history
    .filter((h) => h.rate > 0 && baseByDay.has(dayKey(h.date)))
    .map((h) => ({ date: h.date, rate: h.rate / baseByDay.get(dayKey(h.date)) }));

  const rate = q.rate > 0 && b.rate > 0 ? q.rate / b.rate : null;
  return {
    symbol: `${quoteCur}=X÷${base}=X`,
    rate,
    ts: Math.min(q.ts ?? Date.now(), b.ts ?? Date.now()),
    history,
    crossVia: 'USD',
  };
}

export default {
  id: 'yahoo',
  name: 'Yahoo Finance',
  // Yahoo ให้ quote ได้ แต่จัดไว้ท้ายลำดับใน registry เพราะไม่เสถียร
  capabilities: ['quote', 'bars', 'earnings', 'screener', 'fx'], // ★ v2.1: fx
  requiresKey: null, // ไม่ต้องมี key
  limits: { perMinute: null, perDay: null },
  notes: 'ไม่ต้องใช้ API key แต่ไม่มีการรับประกัน โดนจำกัดการเรียกได้ทุกเมื่อ',

  isConfigured() { return true; }, // ใช้ได้เสมอ ไม่ต้องตั้งค่า
  setKey() { /* ไม่ต้องใช้ key */ },
  getQuota() { return quota.snapshot(); },
  _quota: quota,

  // ---------- ราคาปัจจุบัน ----------
  async quote(symbol) {
    quota.countCall();
    try {
      const q = await yf.quote(symbol);
      if (!q || typeof q.regularMarketPrice !== 'number') throw new Error('Yahoo ไม่มีราคาสำหรับ ' + symbol);
      quota.countSuccess();
      return {
        symbol,
        price: q.regularMarketPrice,
        bid: typeof q.bid === 'number' && q.bid > 0 ? q.bid : null,
        ask: typeof q.ask === 'number' && q.ask > 0 ? q.ask : null,
        prevClose: q.regularMarketPreviousClose ?? null,
        changePct: typeof q.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent : null,
        volume: q.regularMarketVolume ?? null,
        avgVolume: q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? null,
        ts: q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : Date.now(),
        source: 'yahoo',
      };
    } catch (err) {
      quota.countError(err);
      throw err;
    }
  },

  // ---------- แท่งเทียนย้อนหลัง ----------
  // days = จำนวนวันย้อนหลัง (Yahoo จำกัด 1m ที่ ~7 วัน, 5m/15m ที่ ~60 วัน)
  async bars(symbol, tf, days = 30) {
    const interval = TF_TO_INTERVAL[tf] || tf;
    quota.countCall();
    try {
      const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const chart = await yf.chart(symbol, { period1, interval });
      const rawQuotes = Array.isArray(chart?.quotes) ? chart.quotes : [];

      // กรองแท่งที่ข้อมูลไม่ครบทิ้ง (Yahoo ส่ง null มาสำหรับแท่งที่ไม่มีการซื้อขาย)
      const bars = rawQuotes
        .filter((q) => q && q.close != null && q.volume != null && q.high != null && q.low != null)
        .map((q) => ({
          date: q.date instanceof Date ? q.date : new Date(q.date),
          open: q.open ?? q.close,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
        }));

      if (bars.length === 0) throw new Error(`Yahoo ไม่มีแท่งเทียน ${symbol} (${tf})`);

      quota.countSuccess();
      return {
        symbol,
        tf,
        bars,
        meta: {
          previousClose: chart?.meta?.previousClose ?? chart?.meta?.chartPreviousClose ?? null,
          tfMinutes: TF_MINUTES[tf] || null,
        },
        source: 'yahoo',
      };
    } catch (err) {
      quota.countError(err);
      throw err;
    }
  },

  // ---------- ★ v2.1: อัตราแลกเปลี่ยน ----------
  // Yahoo ใช้สัญลักษณ์คู่เงินแบบ "THB=X" สำหรับ USD/THB (ฐานเป็น USD เสมอเมื่อขึ้นต้นด้วยสกุลปลายทาง)
  // คู่ที่ไม่มี USD เป็นฐานใช้รูป "EURTHB=X"
  // คืนทั้งเรตปัจจุบันและประวัติรายวัน เพราะคะแนนความคุ้มต้องใช้ทั้งคู่
  //
  // ★ บางคู่ Yahoo มีแค่เรตวันล่าสุด ไม่มีประวัติ (เช่น CNYTHB=X, VNDTHB=X, PHPTHB=X)
  // หรือไม่มีเลย (AEDTHB=X) → คำนวณผ่านดอลลาร์แทน: CNY/THB = (USD/THB) ÷ (USD/CNY)
  // ซึ่งเป็นวิธีเดียวกับที่ตลาดใช้คิด cross rate อยู่แล้ว
  async fx(pair, days = 400) {
    const [base, quoteCur] = String(pair).toUpperCase().split('/');
    const symbol = base === 'USD' ? `${quoteCur}=X` : `${base}${quoteCur}=X`;
    quota.countCall();
    try {
      let series = null;
      let directErr = null;
      try {
        series = await fetchFxSeries(symbol, days);
      } catch (err) {
        directErr = err;
      }

      if ((!series || series.history.length < 30) && base !== 'USD' && quoteCur !== 'USD') {
        series = await crossViaUsd(base, quoteCur, days);
      }
      if (!series || series.history.length < 30) {
        throw directErr || new Error(`Yahoo ให้ประวัติ ${symbol} ไม่พอ (${series?.history.length ?? 0} วัน)`);
      }

      quota.countSuccess();
      return {
        pair: `${base}/${quoteCur}`,
        symbol: series.symbol,
        rate: series.rate,
        ts: series.ts,
        history: series.history,
        source: 'yahoo',
        crossVia: series.crossVia || null,
      };
    } catch (err) {
      quota.countError(err);
      throw err;
    }
  },

  // ---------- วันประกาศงบ ----------
  async earnings(symbol) {
    quota.countCall();
    try {
      const summary = await yf.quoteSummary(symbol, { modules: ['calendarEvents'] });
      const dates = summary?.calendarEvents?.earnings?.earningsDate;
      quota.countSuccess();

      if (!Array.isArray(dates) || dates.length === 0) {
        return { symbol, earningsDate: null, daysUntil: null, source: 'yahoo' };
      }
      const next = dates.map((d) => (d instanceof Date ? d : new Date(d))).sort((a, b) => a - b)[0];
      return {
        symbol,
        earningsDate: next.toISOString(),
        daysUntil: (next.getTime() - Date.now()) / 86_400_000,
        source: 'yahoo',
      };
    } catch (err) {
      quota.countError(err);
      throw err;
    }
  },

  // ---------- screener (day_gainers / most_actives) ----------
  async screener(scrIds, count = 30) {
    quota.countCall();
    try {
      const res = await yf.screener({ scrIds, count });
      quota.countSuccess();
      const quotes = Array.isArray(res?.quotes) ? res.quotes : [];
      return quotes
        .filter((q) => q?.symbol)
        .map((q) => ({
          symbol: q.symbol,
          price: q.regularMarketPrice ?? null,
          changePct: q.regularMarketChangePercent ?? null,
          volume: q.regularMarketVolume ?? null,
          avgVolume: q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? 0,
          scrId: scrIds,
        }));
    } catch (err) {
      quota.countError(err);
      throw err;
    }
  },
};
