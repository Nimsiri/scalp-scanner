// src/providers/fmp.js — Financial Modeling Prep (free 250 ครั้ง/วัน, EOD)
// บทบาท: float (จำนวนหุ้นหมุนเวียนจริง) + short interest
//         หุ้น float น้อย + short สูง = โอกาสเคลื่อนไหวแรง (squeeze)
//
// ⚠️ ไม่รับประกันว่า free tier ยังให้ endpoint พวกนี้อยู่ (สเปกข้อ 5.5 เขียนว่า "ถ้า free tier ยังให้")
//    ไฟล์นี้จึงออกแบบให้ล้มเหลวแบบเงียบและสุภาพ:
//    เจอ 401/403 = จำไว้ว่า endpoint นั้นใช้ไม่ได้ แล้วไม่ยิงซ้ำอีกตลอด session
//    (ไม่เผาโควตา 250/วัน ไปกับ endpoint ที่ยิงไปก็ถูกปฏิเสธ)

import { TokenBucket, QuotaTracker, httpJson, isAccessDeniedError } from './_shared.js';
import { log } from '../logbus.js';

const BASE = 'https://financialmodelingprep.com';

let apiKey = '';
const bucket = new TokenBucket({ capacity: 10, refillPerMs: 10 / 60_000 });
const quota = new QuotaTracker({ perMinute: 10, perDay: 250 });

// จำ endpoint ที่ free tier ไม่ให้ใช้ → ไม่ยิงซ้ำ
const blockedEndpoints = new Set();

async function call(path, params = {}, label = 'fmp') {
  if (!apiKey) throw new Error('FMP: ยังไม่ได้ตั้ง FMP_API_KEY');
  if (quota.isDailyExhausted()) throw new Error('FMP: โควตารายวันหมดแล้ว (250 ครั้ง)');
  if (blockedEndpoints.has(path)) throw new Error(`FMP: endpoint ${path} ไม่อยู่ใน free tier (ข้ามไปแล้ว)`);

  await bucket.acquire();
  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  quota.countCall();
  try {
    const json = await httpJson(`${BASE}${path}?${qs}`, { label });
    quota.countSuccess();
    return json;
  } catch (err) {
    quota.countError(err);
    if (isAccessDeniedError(err)) {
      blockedEndpoints.add(path);
      log.warn(`FMP: endpoint ${path} ใช้ไม่ได้ใน free tier — จะไม่เรียกซ้ำอีกใน session นี้`);
    }
    throw err;
  }
}

export default {
  id: 'fmp',
  name: 'Financial Modeling Prep',
  capabilities: ['fundamentals'],
  requiresKey: 'FMP_API_KEY',
  limits: { perMinute: 10, perDay: 250 },
  signupUrl: 'https://site.financialmodelingprep.com/developer/docs',
  notes: 'ฟรี 250 ครั้ง/วัน (EOD) — float/short interest อาจไม่อยู่ใน free tier จะข้ามให้เองถ้าใช้ไม่ได้',

  isConfigured() { return !!apiKey; },
  setKey(k) { apiKey = (k || '').trim(); },
  getQuota() { return quota.snapshot(); },
  _quota: quota,

  // ---------- float + short interest ----------
  // ทั้งสองส่วนแยก try/catch — ถ้าอันหนึ่งใช้ไม่ได้ อีกอันยังใช้ได้
  async fundamentals(symbol) {
    const out = {
      symbol,
      floatShares: null,
      floatPct: null,
      sharesOutstanding: null,
      shortPct: null,
      shortRatio: null,
      partial: false, // true = ได้ข้อมูลไม่ครบ
      source: 'fmp',
    };

    // 1) share float
    try {
      const j = await call('/stable/shares-float', { symbol }, `fmp float(${symbol})`);
      const row = Array.isArray(j) ? j[0] : j;
      if (row) {
        const f = Number(row.floatShares);
        const o = Number(row.outstandingShares);
        if (Number.isFinite(f) && f > 0) out.floatShares = f;
        if (Number.isFinite(o) && o > 0) out.sharesOutstanding = o;
        if (out.floatShares && out.sharesOutstanding) {
          out.floatPct = (out.floatShares / out.sharesOutstanding) * 100;
        }
      }
    } catch {
      out.partial = true; // ไม่ log ซ้ำ — call() log ให้แล้วตอนเจอ 403 ครั้งแรก
    }

    // 2) short interest
    try {
      const j = await call('/stable/short-interest', { symbol }, `fmp short(${symbol})`);
      const row = Array.isArray(j) ? j[0] : j;
      if (row) {
        const pct = Number(row.shortPercentOfFloat ?? row.shortPercent);
        const ratio = Number(row.shortRatio ?? row.daysToCover);
        if (Number.isFinite(pct)) out.shortPct = pct;
        if (Number.isFinite(ratio)) out.shortRatio = ratio;
      }
    } catch {
      out.partial = true;
    }

    // ไม่ได้อะไรเลย = โยน error ให้ registry รู้ว่า provider นี้ช่วยไม่ได้
    if (out.floatShares == null && out.shortPct == null) {
      throw new Error(`FMP: ไม่ได้ข้อมูล float/short ของ ${symbol} (อาจไม่อยู่ใน free tier)`);
    }
    return out;
  },
};
