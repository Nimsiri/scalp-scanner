// src/score-alerts.js — ★ แจ้งเตือนเมื่อคะแนนหุ้นถึงเกณฑ์ที่ตั้งจากหน้าเว็บ
//
// กฎ (ตั้งจากปุ่ม "กฎแจ้งเตือน" ในการ์ดตารางหุ้น → settings.scoreAlert*):
//   คะแนน ≥ scoreAlertMin · (ถ้าเลือก) ต้องผ่านด่านคุณภาพ · (ถ้าเลือก) เฉพาะรายการเฝ้าดู
//   ข้ามหุ้นที่ข้อมูลไม่อัปเดตเสมอ — คะแนนจากราคาเก่าไม่ควรกลายเป็นข้อความเข้า LINE
//
// กันสแปม / ประหยัดโควตา LINE OA:
//   - หุ้นหนึ่งตัวเตือนไม่เกิน 1 ครั้งต่อวันทำการ (หุ้นอเมริกา = วันที่นิวยอร์ก · ★ หุ้นไทย = วันที่ไทย)
//   - ทุกตัวที่เข้าเกณฑ์ในรอบสแกนเดียวกันรวมเป็นการแจ้งเตือนเดียว (server ส่ง LINE ข้อความเดียว)
//   - หุ้นหลาย timeframe ใช้แถวที่คะแนนสูงสุดแถวเดียว

import { readJsonSync, writeJson, appendToArray } from './store.js';
import { marketDateKey } from './market-hours.js';
import { marketOf, MARKETS } from './markets.js';
import { log } from './logbus.js';

// ★ วันทำการของหุ้นตัวนั้น — ช่วงซื้อขายของตลาดไทยคร่อมเที่ยงคืนนิวยอร์ก
// ถ้าใช้วันที่นิวยอร์กกับหุ้นไทย สถานะจะถูกล้างกลางช่วงเช้า แล้วหุ้นตัวเดิมถูกเตือนซ้ำในวันเดียวกัน
const todayFor = (symbol) => marketDateKey(marketOf(symbol));

const STATE_FILE = 'score-alerts.json';          // { [symbol]: { lastDate, ts, score } }
const HISTORY_FILE = 'score-alerts-history.json';

let state = null;
function load() {
  if (!state) {
    const raw = readJsonSync(STATE_FILE, {});
    state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }
  return state;
}

// เงื่อนไขเดียวกับตัวอย่างสดในหน้าเว็บ (public/app.js → scoreRuleMatches) — แก้ที่หนึ่งต้องแก้อีกที่
export function matchesScoreRule(row, st) {
  if (!row || row.dataError || row.dataStale) return false;
  if (!Number.isFinite(row.score) || row.score < st.scoreAlertMin) return false;
  if (st.scoreAlertRequirePassed && !row.passed) return false;
  if (st.scoreAlertScope === 'watchlist' && row.from !== 'watchlist') return false;
  return true;
}

// ข้อมูลที่ส่งต่อให้หน้าเว็บ/LINE — ตัดให้เหลือเท่าที่ใช้ ไม่ส่งทั้งแถว
function brief(r) {
  const m = MARKETS[r.market] || MARKETS[marketOf(r.symbol)];
  return {
    symbol: r.symbol,
    market: m.id, // ★
    cur: m.cur,   // ★ '$' | '฿'
    tf: r.tf,
    score: r.score,
    price: r.price,
    changePct: r.changePct,
    passed: !!r.passed,
    isSignal: !!r.isSignal,
    rvol: r.rvol,
    rr: r.rr?.ok ? r.rr.label : null,
    from: r.from,
  };
}

/**
 * ตรวจแถวของรอบสแกนนี้ คืนรายการหุ้นที่ "เพิ่งเข้าเกณฑ์" (ยังไม่เคยเตือนวันนี้)
 * @returns {Promise<Array>} เรียงคะแนนมากไปน้อย · ว่าง = ไม่ต้องแจ้งอะไร
 */
export async function checkScoreAlerts(rows, st) {
  if (!st.scoreAlertEnabled) return [];
  const s = load();

  // สถานะของวันก่อนๆ ไม่ใช้แล้ว — ลบทิ้งกันไฟล์โตเรื่อยๆ (★ เทียบกับวันทำการของตลาดของหุ้นตัวนั้น)
  for (const [sym, v] of Object.entries(s)) if (v?.lastDate !== todayFor(sym)) delete s[sym];

  const best = new Map();
  for (const r of rows) {
    if (!matchesScoreRule(r, st)) continue;
    const prev = best.get(r.symbol);
    if (!prev || r.score > prev.score) best.set(r.symbol, r);
  }

  const now = new Date().toISOString();
  const hits = [];
  for (const [sym, r] of best) {
    if (s[sym]) continue; // เตือนไปแล้ววันนี้
    s[sym] = { lastDate: todayFor(sym), ts: now, score: r.score };
    hits.push(brief(r));
  }
  await writeJson(STATE_FILE, s);
  if (hits.length === 0) return [];

  hits.sort((a, b) => b.score - a.score);
  await appendToArray(HISTORY_FILE, { ts: now, min: st.scoreAlertMin, hits }, 500);
  log.success(`🔔 คะแนนถึงเกณฑ์ ≥${st.scoreAlertMin}: ` +
    hits.map((h) => `${h.symbol} (${Number(h.score).toFixed(0)})`).join(', '));
  return hits;
}

// หุ้นที่เตือนไปแล้ววันนี้ (หน้าเว็บใช้บอกว่า "เตือนไปแล้ว")
export function getScoreAlertState() {
  return Object.fromEntries(Object.entries(load()).filter(([sym, v]) => v?.lastDate === todayFor(sym)));
}

// ล้างสถานะวันนี้ → หุ้นที่ยังเข้าเกณฑ์จะถูกเตือนอีกครั้งในรอบสแกนถัดไป
export async function resetScoreAlerts() {
  const count = Object.keys(getScoreAlertState()).length;
  state = {};
  await writeJson(STATE_FILE, state);
  log.info(`ล้างสถานะแจ้งเตือนคะแนนของวันนี้ (${count} ตัว) — รอบสแกนถัดไปจะเตือนใหม่ถ้ายังเข้าเกณฑ์`);
  return { ok: true, count };
}

export async function getScoreAlertHistory(limit = 50) {
  const all = readJsonSync(HISTORY_FILE, []) || [];
  return (Array.isArray(all) ? all : []).slice(-limit).reverse();
}
