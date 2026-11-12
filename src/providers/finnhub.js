// src/providers/finnhub.js — Finnhub (free 60 calls/นาที)
// บทบาท: แหล่งราคา realtime "หลัก" + ปฏิทินงบ + ข่าวบริษัท
//
// ⚠️ ข้อจำกัดสำคัญที่ต้องรู้: endpoint /stock/candle ย้ายไป premium แล้ว
//    free key จะได้ HTTP 403 "You don't have access to this resource"
//    → Finnhub จึง "แทน Yahoo ไม่ได้" สำหรับแท่งเทียน จึงไม่ประกาศ capability 'bars'
//    (ดู https://github.com/finnhubio/Finnhub-API/issues/546)

import { TokenBucket, QuotaTracker, httpJson } from './_shared.js';

const BASE = 'https://finnhub.io/api/v1';

let apiKey = '';
// free tier = 60 calls/นาที → เติม 1 token ต่อวินาที
const bucket = new TokenBucket({ capacity: 60, refillPerMs: 60 / 60_000 });
const quota = new QuotaTracker({ perMinute: 60, perDay: null });

async function call(path, params = {}, label = 'finnhub') {
  if (!apiKey) throw new Error('Finnhub: ยังไม่ได้ตั้ง FINNHUB_API_KEY');
  await bucket.acquire();
  const qs = new URLSearchParams({ ...params, token: apiKey });
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
  id: 'finnhub',
  name: 'Finnhub',
  // ไม่มี 'bars' โดยเจตนา — free tier ไม่ให้ candle
  capabilities: ['quote', 'earnings', 'news'],
  requiresKey: 'FINNHUB_API_KEY',
  limits: { perMinute: 60, perDay: null },
  signupUrl: 'https://finnhub.io/register',
  notes: 'ฟรี 60 ครั้ง/นาที — ใช้เป็นแหล่งราคาหลัก แต่ free tier ไม่ให้แท่งเทียน (/stock/candle เป็น premium)',

  isConfigured() { return !!apiKey; },
  setKey(k) { apiKey = (k || '').trim(); },
  getQuota() { return quota.snapshot(); },
  _quota: quota,

  // ---------- ราคาปัจจุบัน ----------
  // /quote คืน: c=current, d=change, dp=change%, h=high, l=low, o=open, pc=prevClose, t=timestamp
  async quote(symbol) {
    const j = await call('/quote', { symbol }, `finnhub quote(${symbol})`);
    // Finnhub ตอบ c=0 เมื่อไม่รู้จักสัญลักษณ์ (ไม่ใช่ HTTP error) — ต้องดักเอง
    if (!j || typeof j.c !== 'number' || j.c === 0) {
      throw new Error(`Finnhub ไม่มีราคาสำหรับ ${symbol} (อาจไม่ใช่สัญลักษณ์ที่ถูกต้อง)`);
    }
    return {
      symbol,
      price: j.c,
      bid: null, // /quote ฟรีไม่ให้ bid/ask (ต้องใช้ WebSocket หรือ premium)
      ask: null,
      prevClose: typeof j.pc === 'number' && j.pc > 0 ? j.pc : null,
      changePct: typeof j.dp === 'number' ? j.dp : null,
      dayHigh: typeof j.h === 'number' ? j.h : null,
      dayLow: typeof j.l === 'number' ? j.l : null,
      volume: null,
      avgVolume: null,
      ts: j.t ? j.t * 1000 : Date.now(),
      source: 'finnhub',
    };
  },

  // ---------- ปฏิทินประกาศงบ ----------
  // ดูล่วงหน้า 14 วัน — หุ้นที่จะประกาศงบใน 1-3 วัน = ความผันผวนสูง (ตามสเปกข้อ 5.5)
  async earnings(symbol) {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    const j = await call('/calendar/earnings', { symbol, from, to }, `finnhub earnings(${symbol})`);

    const list = Array.isArray(j?.earningsCalendar) ? j.earningsCalendar : [];
    if (list.length === 0) return { symbol, earningsDate: null, daysUntil: null, source: 'finnhub' };

    const next = list
      .map((e) => ({ ...e, d: new Date(`${e.date}T00:00:00Z`) }))
      .filter((e) => !Number.isNaN(e.d.getTime()))
      .sort((a, b) => a.d - b.d)[0];
    if (!next) return { symbol, earningsDate: null, daysUntil: null, source: 'finnhub' };

    return {
      symbol,
      earningsDate: next.d.toISOString(),
      daysUntil: (next.d.getTime() - Date.now()) / 86_400_000,
      hour: next.hour || null, // bmo = ก่อนเปิดตลาด, amc = หลังปิดตลาด
      source: 'finnhub',
    };
  },

  // ---------- ข่าวบริษัท ----------
  // Finnhub ไม่ให้คะแนน sentiment เป็นตัวเลขใน free tier
  // จึงประมาณจากคำในหัวข้อข่าว และ "ติดป้ายว่าเป็นการประมาณ" ไม่แอบอ้างว่าเป็นค่าจริง
  async news(symbol) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const j = await call('/company-news', { symbol, from, to }, `finnhub news(${symbol})`);

    const items = (Array.isArray(j) ? j : []).slice(0, 15);
    if (items.length === 0) {
      return { symbol, sentiment: null, articleCount: 0, headlines: [], estimated: true, source: 'finnhub' };
    }

    const scores = items.map((it) => keywordSentiment(it.headline || ''));
    const scored = scores.filter((s) => s !== 0);
    const avg = scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : 0;

    return {
      symbol,
      sentiment: avg,             // −1..+1
      articleCount: items.length,
      headlines: items.slice(0, 5).map((it) => ({
        title: it.headline,
        url: it.url,
        ts: it.datetime ? it.datetime * 1000 : null,
      })),
      estimated: true,            // ⚠️ ประมาณจากคำในหัวข้อ ไม่ใช่ค่า sentiment จริงจาก provider
      source: 'finnhub',
    };
  },
};

// ---------- ประมาณ sentiment จากคำในหัวข้อข่าว ----------
// วิธีนี้หยาบมาก ใช้เป็นตัวสำรองเท่านั้น (Alpha Vantage/Marketaux ให้ค่าจริง)
// จึงติดธง estimated:true ไว้ให้ UI แสดงว่า "ประมาณ" ไม่ใช่ค่าที่วัดได้
const POSITIVE = /\b(beat|beats|surge|surges|soar|soars|jump|jumps|rally|rallies|upgrade|upgraded|raise[sd]?|record|strong|top(s|ped)?|win|wins|approval|approved|breakthrough|partnership|expand|outperform|buyback|dividend)\b/gi;
const NEGATIVE = /\b(miss|misses|missed|plunge|plunges|drop|drops|fall|falls|sink|sinks|slump|downgrade|downgraded|cut|cuts|weak|loss|losses|lawsuit|sue[sd]?|investigation|probe|recall|delay|delayed|bankrupt|fraud|halt|halted|warn|warns|warning|layoff)\b/gi;

function keywordSentiment(text) {
  if (!text) return 0;
  const pos = (text.match(POSITIVE) || []).length;
  const neg = (text.match(NEGATIVE) || []).length;
  if (pos === 0 && neg === 0) return 0;
  // normalize เป็น −1..+1
  return (pos - neg) / (pos + neg);
}
