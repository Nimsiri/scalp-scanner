// src/providers/marketaux.js — Marketaux (ข่าว + sentiment ฟรี)
// บทบาท: แหล่ง sentiment ที่ "ใจกว้างกว่า" Alpha Vantage
//         free tier ประมาณ 100 request/วัน (ขึ้นกับแผนที่สมัคร)
//         เหมาะเป็นตัวหลักถ้าอยากได้ sentiment ครบทุกตัวในรอบ

import { TokenBucket, QuotaTracker, httpJson } from './_shared.js';

const BASE = 'https://api.marketaux.com/v1/news/all';

let apiKey = '';
// ไม่ประกาศ per-minute ชัดเจน — จำกัดเองไว้ที่ 10/นาที กันยิงถี่เกินไป
const bucket = new TokenBucket({ capacity: 10, refillPerMs: 10 / 60_000 });
const quota = new QuotaTracker({ perMinute: 10, perDay: 100 });

export default {
  id: 'marketaux',
  name: 'Marketaux',
  capabilities: ['news'],
  requiresKey: 'MARKETAUX_API_KEY',
  limits: { perMinute: 10, perDay: 100 },
  signupUrl: 'https://www.marketaux.com/register',
  notes: 'ฟรีประมาณ 100 request/วัน — ให้ค่า sentiment จริง โควตากว้างกว่า Alpha Vantage',

  isConfigured() { return !!apiKey; },
  setKey(k) { apiKey = (k || '').trim(); },
  getQuota() { return quota.snapshot(); },
  _quota: quota,

  async news(symbol) {
    if (!apiKey) throw new Error('Marketaux: ยังไม่ได้ตั้ง MARKETAUX_API_KEY');
    if (quota.isDailyExhausted()) throw new Error('Marketaux: โควตารายวันหมดแล้ว');

    await bucket.acquire();
    // ดูข่าว 3 วันย้อนหลัง เฉพาะภาษาอังกฤษ และต้องมี entity ที่ตรงกับหุ้นตัวนี้
    const publishedAfter = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 19);
    const qs = new URLSearchParams({
      symbols: symbol,
      filter_entities: 'true',
      language: 'en',
      published_after: publishedAfter,
      limit: '20',
      api_token: apiKey,
    });

    quota.countCall();
    let j;
    try {
      j = await httpJson(`${BASE}?${qs}`, { label: `marketaux news(${symbol})` });
      quota.countSuccess();
    } catch (err) {
      quota.countError(err);
      throw err;
    }

    const data = Array.isArray(j?.data) ? j.data : [];
    if (data.length === 0) {
      return { symbol, sentiment: null, articleCount: 0, headlines: [], estimated: false, source: 'marketaux' };
    }

    // Marketaux ให้ sentiment_score ต่อ entity (−1..+1) พร้อม match_score บอกความเกี่ยวข้อง
    const perArticle = [];
    for (const item of data) {
      const ent = (item.entities || []).find(
        (e) => String(e.symbol).toUpperCase() === symbol.toUpperCase()
      );
      const score = ent ? Number(ent.sentiment_score) : NaN;
      if (!Number.isFinite(score)) continue;
      const match = Number(ent?.match_score);
      perArticle.push({
        score,
        weight: Number.isFinite(match) && match > 0 ? Math.min(1, match / 100) : 0.5,
        title: item.title,
        url: item.url,
        ts: item.published_at ? Date.parse(item.published_at) : null,
      });
    }

    if (perArticle.length === 0) {
      return { symbol, sentiment: null, articleCount: data.length, headlines: [], estimated: false, source: 'marketaux' };
    }

    // ถ่วงน้ำหนักด้วยความเกี่ยวข้อง × ความใหม่ (ครึ่งชีวิต 24 ชม.)
    const now = Date.now();
    let wsum = 0;
    let vsum = 0;
    for (const a of perArticle) {
      const ageH = a.ts ? Math.max(0, (now - a.ts) / 3_600_000) : 24;
      const w = a.weight * Math.pow(0.5, ageH / 24);
      wsum += w;
      vsum += a.score * w;
    }

    return {
      symbol,
      sentiment: wsum > 0 ? vsum / wsum : null,
      articleCount: perArticle.length,
      headlines: perArticle.slice(0, 5).map((a) => ({ title: a.title, url: a.url, ts: a.ts })),
      estimated: false,
      source: 'marketaux',
    };
  },
};
