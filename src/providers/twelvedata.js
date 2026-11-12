// src/providers/twelvedata.js — Twelve Data (free 8 credits/นาที, 800/วัน)
// บทบาท: fallback ทั้งราคาและแท่งเทียน (สำรองของ Finnhub และ Yahoo)
//
// ⚠️ งบจำกัดมาก: /time_series = 1 credit ต่อ 1 symbol
//    หุ้น 30 ตัว × 2 timeframe = 60 credit ต่อรอบสแกน → ใช้ได้ ~13 รอบ/วัน เท่านั้น
//    จึงต้องเป็น fallback อย่างเดียว ไม่ใช่แหล่งหลัก และ registry จะข้ามให้เองเมื่อโควตาหมด

import { TokenBucket, QuotaTracker, httpJson, TF_MINUTES } from './_shared.js';

const BASE = 'https://api.twelvedata.com';

let apiKey = '';
// 8 credits/นาที → เติม 8 token ต่อ 60 วินาที
const bucket = new TokenBucket({ capacity: 8, refillPerMs: 8 / 60_000 });
const quota = new QuotaTracker({ perMinute: 8, perDay: 800 });

// timeframe ของเรา → interval ของ Twelve Data
const TF_TO_INTERVAL = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '1d': '1day' };

async function call(path, params = {}, label = 'twelvedata') {
  if (!apiKey) throw new Error('Twelve Data: ยังไม่ได้ตั้ง TWELVEDATA_API_KEY');
  if (quota.isDailyExhausted()) throw new Error('Twelve Data: โควตารายวันหมดแล้ว (800 credits)');
  await bucket.acquire();
  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  quota.countCall();
  try {
    const json = await httpJson(`${BASE}${path}?${qs}`, { label });
    quota.countSuccess();
    return json;
  } catch (err) {
    quota.countError(err);
    throw err;
  }
}

export default {
  id: 'twelvedata',
  name: 'Twelve Data',
  capabilities: ['quote', 'bars', 'fx'], // ★ v2.1: fx
  requiresKey: 'TWELVEDATA_API_KEY',
  limits: { perMinute: 8, perDay: 800 },
  signupUrl: 'https://twelvedata.com/pricing',
  notes: 'ฟรี 8 credits/นาที 800/วัน — 1 symbol = 1 credit ใช้เป็น fallback เท่านั้น',

  isConfigured() { return !!apiKey; },
  setKey(k) { apiKey = (k || '').trim(); },
  getQuota() { return quota.snapshot(); },
  _quota: quota,

  // ---------- ราคาปัจจุบัน ----------
  async quote(symbol) {
    const j = await call('/quote', { symbol }, `twelvedata quote(${symbol})`);
    const price = Number(j?.close);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Twelve Data ไม่มีราคาสำหรับ ${symbol}`);
    }
    const prevClose = Number(j?.previous_close);
    return {
      symbol,
      price,
      bid: null,
      ask: null,
      prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
      changePct: Number.isFinite(Number(j?.percent_change)) ? Number(j.percent_change) : null,
      volume: Number.isFinite(Number(j?.volume)) ? Number(j.volume) : null,
      avgVolume: Number.isFinite(Number(j?.average_volume)) ? Number(j.average_volume) : null,
      // timestamp เป็นวินาที
      ts: j?.timestamp ? Number(j.timestamp) * 1000 : Date.now(),
      source: 'twelvedata',
    };
  },

  // ---------- ★ v2.1: อัตราแลกเปลี่ยน ----------
  // Twelve Data ใช้รูป "USD/THB" ตรงๆ · 1 คำขอ = 1 credit (โควตาฟรี 800/วัน)
  // เรียกแค่ time_series ครั้งเดียวแล้วใช้แท่งสุดท้ายเป็นเรตปัจจุบัน — ประหยัด credit
  async fx(pair, days = 400) {
    const symbol = String(pair).toUpperCase();
    const j = await call('/time_series', {
      symbol, interval: '1day', outputsize: Math.min(5000, Math.max(60, days)), order: 'ASC',
    }, `twelvedata fx(${symbol})`);

    const values = Array.isArray(j?.values) ? j.values : [];
    const history = values
      .map((v) => ({ date: new Date(v.datetime), rate: Number(v.close) }))
      .filter((h) => Number.isFinite(h.rate) && !Number.isNaN(h.date.getTime()));

    if (history.length < 30) throw new Error(`Twelve Data ให้ประวัติ ${symbol} ไม่พอ (${history.length} วัน)`);

    const last = history[history.length - 1];
    return { pair: symbol, symbol, rate: last.rate, ts: last.date.getTime(), history, source: 'twelvedata' };
  },

  // ---------- แท่งเทียน ----------
  async bars(symbol, tf, days = 30) {
    const interval = TF_TO_INTERVAL[tf];
    if (!interval) throw new Error(`Twelve Data ไม่รองรับ timeframe ${tf}`);

    // ประมาณจำนวนแท่งที่ต้องขอ: 6.5 ชม./วันทำการ ÷ นาทีต่อแท่ง × จำนวนวัน
    const tfMin = TF_MINUTES[tf] || 5;
    const perDay = Math.ceil((6.5 * 60) / tfMin);
    const outputsize = Math.min(5000, Math.max(60, perDay * Math.min(days, 30)));

    const j = await call('/time_series', { symbol, interval, outputsize, order: 'ASC' }, `twelvedata bars(${symbol})`);
    const values = Array.isArray(j?.values) ? j.values : [];
    if (values.length === 0) throw new Error(`Twelve Data ไม่มีแท่งเทียน ${symbol} (${tf})`);

    const bars = values
      .map((v) => ({
        // datetime ของ Twelve Data เป็นเวลา exchange (ET) แบบไม่มี timezone suffix
        // ต่อ -05:00/-04:00 ไม่ได้เพราะไม่รู้ DST → ใช้ Date.parse ตรงๆ แล้วให้
        // indicators.js แปลงเป็น ET เอง (ทุกแท่งเลื่อนเท่ากัน จึงไม่กระทบการเทียบ)
        date: new Date(v.datetime.includes('T') ? v.datetime : `${v.datetime.replace(' ', 'T')}Z`),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: Number(v.volume) || 0,
      }))
      .filter((b) => Number.isFinite(b.close) && Number.isFinite(b.high) && Number.isFinite(b.low) && !Number.isNaN(b.date.getTime()));

    if (bars.length === 0) throw new Error(`Twelve Data: แท่งเทียน ${symbol} แปลงข้อมูลไม่ได้`);

    return {
      symbol,
      tf,
      bars,
      meta: { previousClose: null, tfMinutes: tfMin },
      source: 'twelvedata',
    };
  },
};
