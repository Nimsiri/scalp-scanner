// src/alerts.js — ระบบแจ้งเตือนราคา (สเปกข้อ 4)
//
// หน้าที่:
//   1) ตัดสินว่าราคาแตะเป้าหมายแล้วหรือยัง
//   2) กันเตือนซ้ำ — เตือนแล้ว mark ว่า triggered ไม่เตือนรัวทุกรอบ
//   3) reset รายตัว / ทั้งหมด
//   4) เก็บ alert log พร้อม timestamp ลง data/alerts.json
//
// สถานะที่เก็บต่อ symbol:
//   { symbol, triggeredAt, triggerPrice, targetPrice, mode, resetAt }
//   triggeredAt = null  → ยังไม่เคยเตือน (พร้อมเตือน)
//   triggeredAt = เวลา  → เตือนแล้ว จะไม่เตือนซ้ำจนกด reset

import { readJson, writeJson, appendToArray } from './store.js';
import { log } from './logbus.js';
import { nyDateKey } from './market-hours.js';
import { marketInfo } from './markets.js'; // ★ หุ้นไทยแสดงเป็น ฿

const STATE_FILE = 'alerts.json';
const HISTORY_FILE = 'alerts-history.json';

let state = null; // { [symbol]: {...} }

async function load() {
  if (state) return state;
  const raw = await readJson(STATE_FILE, {});
  state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return state;
}

async function persist() {
  await writeJson(STATE_FILE, state);
}

// ---------- เช็คว่าถึงเป้าหมายหรือยัง ----------
// คืน { triggered, alreadyTriggered, entry }
//   triggered = true เฉพาะ "ครั้งแรก" ที่แตะเป้า (รอบถัดไปจะเป็น alreadyTriggered)
//
// เงื่อนไขที่ต้องผ่านก่อนจะเตือน:
//   - มีราคาเป้าหมายที่ใช้ได้ (target > 0)
//   - ราคาปัจจุบัน >= เป้าหมาย
//   - ยังไม่เคยเตือน (หรือ reset แล้ว)
export async function checkAlert({ symbol, price, target, mode, label, resistanceLevel = null }) {
  const s = await load();
  const sym = String(symbol).toUpperCase();
  const cur = s[sym] || null;

  const out = {
    symbol: sym,
    triggered: false,
    alreadyTriggered: false,
    triggeredAt: cur?.triggeredAt || null,
    triggerPrice: cur?.triggerPrice ?? null,
    target,
    mode,
    label,
  };

  // ไม่มีเป้าหมายที่ใช้ได้ → ไม่เตือน (แต่ยังคืนสถานะเดิม)
  if (!Number.isFinite(target) || target <= 0) return out;
  if (!Number.isFinite(price) || price <= 0) return out;

  // ยังไม่ถึงเป้า
  if (price < target) return out;

  // ถึงเป้าแล้ว — เคยเตือนไปแล้วหรือยัง?
  if (cur?.triggeredAt) {
    out.alreadyTriggered = true;
    return out;
  }

  // ---------- เตือนครั้งแรก ----------
  const now = new Date().toISOString();
  s[sym] = {
    symbol: sym,
    triggeredAt: now,
    triggerPrice: price,
    targetPrice: target,
    mode,
    label,
    resistanceLevel,
    resetAt: null,
    dateKey: nyDateKey(),
  };
  await persist();

  const entry = {
    ts: now,
    symbol: sym,
    price,
    target,
    mode,
    label,
    resistanceLevel,
    // ⚠️ ถ้อยคำ: บอกข้อเท็จจริงว่าราคาถึงจุดที่ตั้งไว้ ไม่รับประกันว่าจะขึ้นต่อ
    message: `${sym} ราคาแตะจุดแจ้งเตือน ${marketInfo(sym).cur}${target.toFixed(2)} แล้ว (ราคาล่าสุด ${marketInfo(sym).cur}${price.toFixed(2)}, เป้าหมาย: ${label})`,
  };

  await appendToArray(HISTORY_FILE, entry, 2000);
  log.success(entry.message);

  out.triggered = true;
  out.triggeredAt = now;
  out.triggerPrice = price;
  out.entry = entry;
  return out;
}

// ---------- สถานะการเตือนของ symbol หนึ่ง ----------
export async function getAlertState(symbol) {
  const s = await load();
  return s[String(symbol).toUpperCase()] || null;
}

export async function getAllAlertStates() {
  return { ...(await load()) };
}

// ---------- reset รายตัว (สเปกข้อ 4: "มีปุ่ม reset alert รายตัว") ----------
export async function resetAlert(symbol) {
  const s = await load();
  const sym = String(symbol).toUpperCase();
  if (!s[sym]) return { ok: false, reason: 'ยังไม่มีการแจ้งเตือนของสัญลักษณ์นี้' };

  const was = s[sym].triggeredAt;
  delete s[sym];
  await persist();
  log.info(`รีเซ็ตการแจ้งเตือนของ ${sym} แล้ว — พร้อมเตือนใหม่เมื่อราคาแตะเป้าอีกครั้ง`);
  return { ok: true, symbol: sym, previousTriggeredAt: was };
}

// ---------- reset ทั้งหมด ----------
export async function resetAllAlerts() {
  const count = Object.keys(await load()).length;
  state = {};
  await persist();
  log.info(`รีเซ็ตการแจ้งเตือนทั้งหมด (${count} รายการ)`);
  return { ok: true, count };
}

// ---------- ลบสถานะเมื่อ symbol ถูกลบออกจาก watchlist ----------
export async function forgetSymbol(symbol) {
  const s = await load();
  const sym = String(symbol).toUpperCase();
  if (s[sym]) {
    delete s[sym];
    await persist();
  }
}

// ---------- ประวัติการแจ้งเตือน (แสดงในหน้าเว็บ) ----------
export async function getAlertHistory(limit = 100) {
  const arr = (await readJson(HISTORY_FILE, [])) || [];
  const list = Array.isArray(arr) ? arr : [];
  return list.slice(-limit).reverse(); // ใหม่สุดขึ้นก่อน
}

export function _resetCache() { state = null; }
