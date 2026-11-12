// src/providers/_shared.js — เครื่องมือที่ provider ทุกตัวใช้ร่วมกัน
// 1) TokenBucket    — จำกัดอัตราการเรียก (rate limit) ต่อ provider
// 2) QuotaTracker   — นับโควตาที่ใช้ไปรายนาที/รายวัน เพื่อแสดงในหน้าเว็บ
// 3) withBackoff    — retry แบบ exponential backoff + jitter
// 4) httpJson       — fetch + timeout + แปลง error ให้อ่านรู้เรื่อง

import { log } from '../logbus.js';

// ---------- 1) Token bucket ----------
// เติม token ตามเวลาที่ผ่านไป ถ้า token หมดต้องรอ
// ใช้กับ Finnhub (60/นาที), Twelve Data (8/นาที), Alpha Vantage (5/นาที)
export class TokenBucket {
  constructor({ capacity, refillPerMs }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs; // token ที่เติมต่อ 1 มิลลิวินาที
    this.tokens = capacity;
    this.last = Date.now();
    this._chain = Promise.resolve(); // คิวคำขอ ทำให้การรอเป็นลำดับ ไม่แย่ง token กัน
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.last = now;
    }
  }

  // รอจนได้ token 1 อัน (ต่อคิวกัน ป้องกัน race condition)
  acquire() {
    const run = async () => {
      this._refill();
      if (this.tokens < 1) {
        // ต้องรอนานเท่าไหร่ถึงจะมี token ครบ 1 อัน
        const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
        await new Promise((r) => setTimeout(r, waitMs));
        this._refill();
      }
      this.tokens -= 1;
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }
}

// ---------- 2) Quota tracker ----------
// นับจำนวน call ที่ใช้ไป reset ตามรอบ (นาที / วัน UTC)
export class QuotaTracker {
  constructor({ perMinute = null, perDay = null } = {}) {
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.minuteCount = 0;
    this.dayCount = 0;
    this.minuteKey = this._minuteKey();
    this.dayKey = this._dayKey();
    this.errors = 0;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastSuccessAt = null;
  }

  _minuteKey() { return Math.floor(Date.now() / 60_000); }
  // โควตารายวันของ provider ส่วนใหญ่ reset เที่ยงคืน UTC
  _dayKey() { return new Date().toISOString().slice(0, 10); }

  _roll() {
    const mk = this._minuteKey();
    if (mk !== this.minuteKey) { this.minuteKey = mk; this.minuteCount = 0; }
    const dk = this._dayKey();
    if (dk !== this.dayKey) { this.dayKey = dk; this.dayCount = 0; this.errors = 0; }
  }

  countCall() {
    this._roll();
    this.minuteCount += 1;
    this.dayCount += 1;
  }

  countSuccess() { this.lastSuccessAt = Date.now(); }

  countError(err) {
    this._roll();
    this.errors += 1;
    this.lastError = err ? String(err.message || err).slice(0, 200) : 'unknown';
    this.lastErrorAt = Date.now();
  }

  // โควตารายวันหมดแล้วหรือยัง — ถ้าหมด registry จะข้าม provider นี้ไปเลย ไม่ต้องยิงให้เสียเวลา
  isDailyExhausted() {
    this._roll();
    return this.perDay != null && this.dayCount >= this.perDay;
  }

  snapshot() {
    this._roll();
    return {
      perMinute: this.perMinute,
      perDay: this.perDay,
      usedMinute: this.minuteCount,
      usedDay: this.dayCount,
      remainingMinute: this.perMinute != null ? Math.max(0, this.perMinute - this.minuteCount) : null,
      remainingDay: this.perDay != null ? Math.max(0, this.perDay - this.dayCount) : null,
      errors: this.errors,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastSuccessAt: this.lastSuccessAt,
      // "ยังมีปัญหาอยู่จริง" = error ล่าสุดเกิดหลังความสำเร็จล่าสุด
      // (ถ้าเคย error แล้วสำเร็จต่อมา ไม่ควรขึ้นว่า degraded — เช่นตอนตรวจ ticker ที่ไม่มีจริง
      //  ก็นับเป็น error ของ provider ทั้งที่ provider ทำงานปกติ)
      currentlyFailing: this.lastErrorAt != null && (this.lastSuccessAt == null || this.lastErrorAt > this.lastSuccessAt),
    };
  }
}

// ---------- 3) retry + exponential backoff + jitter ----------
const DEFAULT_DELAYS = [2_000, 6_000, 18_000];

// เดาว่า error เป็นเรื่องชั่วคราว (ควร retry) หรือถาวร (ไม่ต้อง retry)
export function isTransientError(err) {
  if (!err) return false;
  if (err.status === 429) return true;                      // Too Many Requests
  if (err.status >= 500 && err.status < 600) return true;   // server ฝั่งเขาพัง
  const msg = String(err.message || '');
  return /429|too many requests|rate limit|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|invalid json response body|unexpected token/i.test(msg);
}

// error ที่บอกว่า "endpoint นี้ไม่อยู่ใน free tier" — retry ไปก็ไม่ได้ผล ต้องเลิกใช้ทันที
export function isAccessDeniedError(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403) return true;
  return /don't have access|access denied|premium|upgrade your plan|invalid api key|apikey is invalid/i.test(String(err.message || ''));
}

export async function withBackoff(fn, { label = 'request', delays = DEFAULT_DELAYS, onRetry = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // ไม่ retry ถ้าเป็น error ถาวร หรือ retry ครบจำนวนแล้ว
      if (!isTransientError(err) || isAccessDeniedError(err) || attempt === delays.length) throw err;

      // jitter ±25% สำคัญมาก — ถ้าหุ้นหลายตัวโดน 429 พร้อมกันแล้ว retry พร้อมกันอีก
      // ก็จะโดน 429 ซ้ำทั้งชุด การกระจายเวลาช่วยให้ทยอยผ่านไปได้
      const base = delays[attempt];
      const waitMs = Math.round(base * (0.75 + Math.random() * 0.5));
      if (onRetry) onRetry(attempt + 1, waitMs, err);
      else log.warn(`${label} ล้มเหลว (${err.message}) — รอ ${(waitMs / 1000).toFixed(1)}s แล้วลองใหม่ ครั้งที่ ${attempt + 1}/${delays.length}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// ---------- 4) fetch JSON พร้อม timeout ----------
export async function httpJson(url, { timeoutMs = 12_000, headers = {}, label = 'http' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`${label} HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
      err.status = res.status;
      throw err;
    }

    const text = await res.text();
    if (!text.trim()) throw new Error(`${label}: ตอบกลับมาเป็นค่าว่าง`);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // API ฟรีหลายเจ้าตอบเป็น HTML เวลาโดน rate limit — ให้ error สื่อความหมายชัดๆ
      throw new Error(`${label}: ตอบกลับไม่ใช่ JSON (อาจโดน rate limit หรือ endpoint เปลี่ยน) — ${text.slice(0, 120)}`);
    }

    // Alpha Vantage / Twelve Data แจ้ง error ผ่าน body ที่ HTTP 200 — ต้องดักเอง
    const noteMsg = json?.Note || json?.Information || json?.['Error Message'];
    if (noteMsg) {
      const err = new Error(`${label}: ${String(noteMsg).slice(0, 200)}`);
      // ข้อความประเภท "rate limit" ให้ถือเป็น transient เพื่อให้ backoff ทำงาน
      if (/frequency|rate limit|per day|per minute|thank you for using/i.test(noteMsg)) err.status = 429;
      throw err;
    }
    if (json?.status === 'error' && json?.message) {
      const err = new Error(`${label}: ${String(json.message).slice(0, 200)}`);
      if (json.code === 429) err.status = 429;
      if (json.code === 401 || json.code === 403) err.status = json.code;
      throw err;
    }

    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`${label}: หมดเวลารอ (timeout ${timeoutMs}ms)`);
      e.status = 408;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- แปลง timeframe เป็นนาที (ใช้คำนวณ dollar volume / scale ATR) ----------
export const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
