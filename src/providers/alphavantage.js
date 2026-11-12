// src/providers/alphavantage.js — Alpha Vantage (free 25 ครั้ง/วัน, 5 ครั้ง/นาที)
// บทบาท: endpoint NEWS_SENTIMENT ให้คะแนน sentiment เป็น "ตัวเลขจริง" (ไม่ใช่การเดาจากคำ)
//
// ⚠️ โควตาแคบมาก — 25 ครั้ง/วัน (เมื่อก่อน 500 ตอนนี้เหลือ 25)
//    กลยุทธ์ประหยัดโควตาในไฟล์นี้:
//      1) เรียกเฉพาะหุ้นที่ผ่านการคัดกรองชั้นแรกแล้ว (registry เรียกให้เฉพาะ top N)
//      2) cache ผลไว้ 6 ชั่วโมง (จัดการใน providers/index.js)
//      3) โควตาหมดแล้วหยุดยิงทันที ไม่เสียเวลา round-trip

import { TokenBucket, QuotaTracker, httpJson } from './_shared.js';

const BASE = 'https://www.alphavantage.co/query';

let apiKey = '';
// 5 ครั้ง/นาที
const bucket = new TokenBucket({ capacity: 5, refillPerMs: 5 / 60_000 });
const quota = new QuotaTracker({ perMinute: 5, perDay: 25 });

export default {
  id: 'alphavantage',
  name: 'Alpha Vantage',
  capabilities: ['news'],
  requiresKey: 'ALPHAVANTAGE_API_KEY',
  limits: { perMinute: 5, perDay: 25 },
  signupUrl: 'https://www.alphavantage.co/support/#api-key',
  notes: 'ฟรี 25 ครั้ง/วัน เท่านั้น — ให้คะแนน sentiment เป็นตัวเลขจริง เรียกเฉพาะหุ้นคะแนนสูงสุด',

  isConfigured() { return !!apiKey; },
  setKey(k) { apiKey = (k || '').trim(); },
  getQuota() { return quota.snapshot(); },
  _quota: quota,

  // ---------- NEWS_SENTIMENT ----------
  // ตอบกลับ: { feed: [ { title, url, overall_sentiment_score, ticker_sentiment: [...] } ] }
  // ใช้ ticker_sentiment ที่ตรงกับหุ้นตัวนั้นเป็นหลัก (แม่นกว่า overall ของบทความ
  // เพราะบทความหนึ่งพูดถึงหลายหุ้น สัญญาณของแต่ละตัวไม่เหมือนกัน)
  async news(symbol) {
    if (!apiKey) throw new Error('Alpha Vantage: ยังไม่ได้ตั้ง ALPHAVANTAGE_API_KEY');
    if (quota.isDailyExhausted()) throw new Error('Alpha Vantage: โควตารายวันหมดแล้ว (25 ครั้ง/วัน)');

    await bucket.acquire();
    const qs = new URLSearchParams({
      function: 'NEWS_SENTIMENT',
      tickers: symbol,
      sort: 'LATEST',
      limit: '50',
      apikey: apiKey,
    });

    quota.countCall();
    let j;
    try {
      j = await httpJson(`${BASE}?${qs}`, { label: `alphavantage news(${symbol})` });
      quota.countSuccess();
    } catch (err) {
      quota.countError(err);
      throw err;
    }

    const feed = Array.isArray(j?.feed) ? j.feed : [];
    if (feed.length === 0) {
      return { symbol, sentiment: null, articleCount: 0, headlines: [], estimated: false, source: 'alphavantage' };
    }

    // ดึงคะแนนของ ticker ตัวนี้จากแต่ละบทความ
    const perArticle = [];
    for (const item of feed) {
      const mine = (item.ticker_sentiment || []).find(
        (t) => String(t.ticker).toUpperCase() === symbol.toUpperCase()
      );
      const raw = mine ? Number(mine.ticker_sentiment_score) : Number(item.overall_sentiment_score);
      if (!Number.isFinite(raw)) continue;
      // ถ่วงน้ำหนักด้วย relevance — ข่าวที่พูดถึงหุ้นนี้เป็นหลักมีน้ำหนักมากกว่าข่าวที่แค่เอ่ยชื่อผ่านๆ
      const relevance = mine ? Number(mine.relevance_score) : 0.5;
      perArticle.push({
        score: raw,
        weight: Number.isFinite(relevance) && relevance > 0 ? relevance : 0.1,
        title: item.title,
        url: item.url,
        ts: parseAvTime(item.time_published),
      });
    }

    if (perArticle.length === 0) {
      return { symbol, sentiment: null, articleCount: feed.length, headlines: [], estimated: false, source: 'alphavantage' };
    }

    // ให้น้ำหนักข่าวใหม่มากกว่าข่าวเก่า (ครึ่งชีวิต 24 ชม.) — scalping สนใจข่าววันนี้
    const now = Date.now();
    let wsum = 0;
    let vsum = 0;
    for (const a of perArticle) {
      const ageH = a.ts ? Math.max(0, (now - a.ts) / 3_600_000) : 24;
      const recency = Math.pow(0.5, ageH / 24);
      const w = a.weight * recency;
      wsum += w;
      vsum += a.score * w;
    }

    return {
      symbol,
      sentiment: wsum > 0 ? vsum / wsum : null, // −1..+1 (ค่าจริงจาก provider)
      articleCount: perArticle.length,
      headlines: perArticle.slice(0, 5).map((a) => ({ title: a.title, url: a.url, ts: a.ts })),
      estimated: false, // ค่าจริง ไม่ใช่การประมาณ
      source: 'alphavantage',
    };
  },
};

// Alpha Vantage ส่งเวลาเป็น "20260908T143000" (ไม่มี timezone → เป็น ET)
function parseAvTime(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}-04:00`); // ประมาณ ET (EDT)
  return Number.isFinite(t) ? t : null;
}
