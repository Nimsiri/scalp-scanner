// src/watchlist.js — จัดการรายการหุ้นที่ user เพิ่มเอง (สเปกข้อ 3)
// บันทึกลง data/watchlist.json → ปิดโปรแกรมแล้วเปิดใหม่ข้อมูลไม่หาย

import { readJson, writeJson } from './store.js';
import { validateTicker } from './providers/index.js';
import { log } from './logbus.js';

const FILE = 'watchlist.json';

// โครงสร้าง 1 รายการ:
// { symbol: 'TSLA', targetPrice: 123.45 | null, addedAt: ISO string, note: string }
let items = null; // cache ในหน่วยความจำ

async function load() {
  if (items) return items;
  const raw = await readJson(FILE, []);
  items = Array.isArray(raw) ? raw.filter((x) => x && typeof x.symbol === 'string') : [];
  return items;
}

async function persist() {
  await writeJson(FILE, items);
}

// ---------- อ่านรายการทั้งหมด ----------
export async function getWatchlist() {
  return [...(await load())];
}

// คืนแค่รายชื่อสัญลักษณ์ (scanner ใช้)
export async function getSymbols() {
  return (await load()).map((x) => x.symbol);
}

export async function getItem(symbol) {
  const list = await load();
  return list.find((x) => x.symbol === String(symbol).toUpperCase()) || null;
}

// ---------- เพิ่มหุ้น (รองรับหลายตัวคั่นด้วย comma) ----------
// validate ทุกตัวก่อนเพิ่ม โดยลอง fetch quote จริง
// คืนผลแยกรายตัว เพื่อให้ UI บอกได้ว่าตัวไหนสำเร็จ ตัวไหนไม่สำเร็จเพราะอะไร
export async function addTickers(input, { skipValidation = false } = {}) {
  const list = await load();

  // แยกด้วย comma, ช่องว่าง, ขึ้นบรรทัดใหม่, และ semicolon (ให้ user วางข้อความมาแบบไหนก็ได้)
  const requested = String(input || '')
    .split(/[,;\s\n]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (requested.length === 0) {
    return { added: [], results: [{ symbol: '', ok: false, reason: 'ไม่ได้กรอกสัญลักษณ์' }] };
  }

  // ตัดตัวซ้ำในคำขอเดียวกัน
  const unique = [...new Set(requested)];
  const results = [];
  const added = [];

  for (const symbol of unique) {
    // มีอยู่แล้ว
    if (list.some((x) => x.symbol === symbol)) {
      results.push({ symbol, ok: false, reason: 'มีอยู่ในรายการแล้ว', duplicate: true });
      continue;
    }

    // จำกัดจำนวนสูงสุด กันโควตา API หมดเร็วเกินไป
    if (list.length + added.length >= 100) {
      results.push({ symbol, ok: false, reason: 'รายการเต็ม (สูงสุด 100 ตัว)' });
      continue;
    }

    // ---------- ตรวจว่ามีจริง (สเปกข้อ 3: "validate ว่า ticker มีอยู่จริงก่อนเพิ่ม") ----------
    if (!skipValidation) {
      let v = await validateTicker(symbol);
      let sym = symbol;
      // ★ พิมพ์ชื่อย่อหุ้นไทยโดยไม่มี .BK (เช่น PTT) แล้วไม่พบในตลาดอเมริกา → ลองหาในตลาดไทยให้
      //    ชื่อที่ซ้ำกันทั้งสองตลาด (เช่น M = Macy's) จะได้หุ้นอเมริกา — หุ้นไทยต้องพิมพ์ M.BK เอง
      if (!v.ok && !symbol.includes('.') && !symbol.startsWith('^')) {
        const th = await validateTicker(`${symbol}.BK`);
        if (th.ok) { v = th; sym = th.symbol; }
      }
      if (!v.ok) {
        results.push({ symbol, ok: false, reason: v.reason });
        continue;
      }
      if (sym !== symbol && (list.some((x) => x.symbol === sym) || added.some((x) => x.symbol === sym))) {
        results.push({ symbol: sym, ok: false, reason: 'มีอยู่ในรายการแล้ว', duplicate: true });
        continue;
      }
      const item = { symbol: sym, targetPrice: null, addedAt: new Date().toISOString(), note: '' };
      list.push(item);
      added.push(item);
      results.push({ symbol: sym, ok: true, price: v.price, source: v.source, ...(sym !== symbol ? { resolvedFrom: symbol } : {}) });
    } else {
      const item = { symbol, targetPrice: null, addedAt: new Date().toISOString(), note: '' };
      list.push(item);
      added.push(item);
      results.push({ symbol, ok: true, skippedValidation: true });
    }
  }

  if (added.length > 0) {
    await persist();
    log.success(`เพิ่มหุ้นเข้ารายการเฝ้าดู: ${added.map((a) => a.symbol).join(', ')}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log.warn(`เพิ่มไม่สำเร็จ ${failed.length} ตัว: ${failed.map((f) => `${f.symbol} (${f.reason})`).join(', ')}`);
  }

  return { added, results };
}

// ---------- ลบหุ้นรายตัว ----------
export async function removeTicker(symbol) {
  const list = await load();
  const sym = String(symbol || '').toUpperCase();
  const idx = list.findIndex((x) => x.symbol === sym);
  if (idx === -1) return { ok: false, reason: 'ไม่พบสัญลักษณ์นี้ในรายการ' };

  list.splice(idx, 1);
  await persist();
  log.info(`ลบ ${sym} ออกจากรายการเฝ้าดู`);
  return { ok: true, symbol: sym };
}

// ---------- ตั้ง/ล้างราคาเป้าหมาย (สเปกข้อ 4) ----------
// targetPrice = null หรือ '' → กลับไปใช้โหมด auto (แนวต้าน −0.1%)
export async function setTargetPrice(symbol, targetPrice) {
  const list = await load();
  const sym = String(symbol || '').toUpperCase();
  const item = list.find((x) => x.symbol === sym);
  if (!item) return { ok: false, reason: 'ไม่พบสัญลักษณ์นี้ในรายการ' };

  if (targetPrice === null || targetPrice === undefined || targetPrice === '') {
    item.targetPrice = null;
    await persist();
    log.info(`${sym}: ล้างราคาเป้าหมาย — กลับไปใช้โหมดอัตโนมัติ (แนวต้าน −0.1%)`);
    return { ok: true, symbol: sym, targetPrice: null, mode: 'auto' };
  }

  const n = Number(targetPrice);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: 'ราคาเป้าหมายต้องเป็นตัวเลขมากกว่า 0' };
  }
  if (n > 1_000_000) {
    return { ok: false, reason: 'ราคาเป้าหมายสูงเกินความเป็นจริง' };
  }

  item.targetPrice = n;
  await persist();
  log.info(`${sym}: ตั้งราคาเป้าหมายเอง $${n.toFixed(2)}`);
  return { ok: true, symbol: sym, targetPrice: n, mode: 'manual' };
}

// ---------- บันทึกโน้ตของ user ----------
export async function setNote(symbol, note) {
  const list = await load();
  const item = list.find((x) => x.symbol === String(symbol || '').toUpperCase());
  if (!item) return { ok: false, reason: 'ไม่พบสัญลักษณ์นี้ในรายการ' };
  item.note = String(note || '').slice(0, 500);
  await persist();
  return { ok: true };
}

// ---------- ล้างรายการทั้งหมด ----------
export async function clearWatchlist() {
  items = [];
  await persist();
  log.warn('ล้างรายการเฝ้าดูทั้งหมด');
  return { ok: true };
}

// สำหรับ test: บังคับให้อ่านไฟล์ใหม่
export function _resetCache() { items = null; }
