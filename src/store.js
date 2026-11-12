// src/store.js — อ่าน/เขียนไฟล์ JSON ในโฟลเดอร์ data/ แบบปลอดภัย
// หลักการสำคัญ: เขียนลงไฟล์ .tmp ก่อน แล้วค่อย rename ทับไฟล์จริง
// เพราะ rename เป็น atomic operation ของ OS ถ้าไฟดับ/ปิดโปรแกรมกลางคัน
// ไฟล์จริงจะไม่เสีย (จะเป็นของเก่าทั้งไฟล์ หรือของใหม่ทั้งไฟล์ ไม่มีครึ่งๆ กลางๆ)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// โฟลเดอร์ data/ อยู่ระดับเดียวกับ src/ (คือ root ของโปรเจกต์)
export const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');

// เตรียมโฟลเดอร์ data/ ให้พร้อมใช้งาน (ทำครั้งเดียวตอนโหลดไฟล์นี้)
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error(`[store] สร้างโฟลเดอร์ data/ ไม่สำเร็จ: ${err.message}`);
}

function filePath(name) {
  // กัน path traversal: ยอมรับแค่ชื่อไฟล์ ไม่ยอมให้มี / หรือ ..
  const safe = path.basename(name);
  return path.join(DATA_DIR, safe);
}

// ---------- อ่านไฟล์ JSON ----------
// ถ้าไฟล์ไม่มี หรือ JSON เสีย จะคืน fallback แทนการ throw
// (ไฟล์เสียจะถูก rename เป็น .corrupt-<timestamp> เก็บไว้ให้ตรวจสอบ ไม่ลบทิ้ง)
export async function readJson(name, fallback = null) {
  const p = filePath(name);
  let raw;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback; // ยังไม่มีไฟล์ = ใช้ค่าเริ่มต้น ไม่ใช่ error
    console.error(`[store] อ่าน ${name} ไม่สำเร็จ: ${err.message}`);
    return fallback;
  }

  if (!raw.trim()) return fallback; // ไฟล์ว่าง

  try {
    return JSON.parse(raw);
  } catch (err) {
    // JSON เสีย — เก็บไฟล์เสียไว้ตรวจสอบ แล้วเริ่มใหม่จาก fallback
    const backup = `${p}.corrupt-${Date.now()}`;
    try {
      await fsp.rename(p, backup);
      console.error(`[store] ${name} JSON เสีย — ย้ายไปเก็บที่ ${path.basename(backup)} แล้วเริ่มใหม่`);
    } catch {
      console.error(`[store] ${name} JSON เสีย และย้ายไฟล์สำรองไม่สำเร็จ: ${err.message}`);
    }
    return fallback;
  }
}

// เวอร์ชัน sync สำหรับตอน boot (settings ต้องพร้อมก่อน server เริ่ม)
export function readJsonSync(name, fallback = null) {
  const p = filePath(name);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] อ่าน ${name} (sync) ไม่สำเร็จ: ${err.message}`);
    }
    return fallback;
  }
}

// ---------- เขียนไฟล์ JSON แบบ atomic ----------
// คิวการเขียนต่อไฟล์ ป้องกันการเขียนซ้อนกัน (เช่น user กดเพิ่ม ticker รัวๆ)
const writeQueues = new Map(); // name -> Promise ของการเขียนล่าสุด

export function writeJson(name, data) {
  const prev = writeQueues.get(name) || Promise.resolve();
  // ต่อคิวไปเรื่อยๆ — .catch() กันไม่ให้ error ของงานก่อนหน้าทำให้คิวขาด
  const next = prev.catch(() => {}).then(() => doWrite(name, data));
  writeQueues.set(name, next);
  return next;
}

async function doWrite(name, data) {
  const p = filePath(name);
  const tmp = `${p}.tmp`;
  try {
    // JSON.stringify แบบ 2 spaces เพื่อให้ user เปิดอ่าน/แก้ด้วยมือได้
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, p); // atomic
    return true;
  } catch (err) {
    console.error(`[store] เขียน ${name} ไม่สำเร็จ: ${err.message}`);
    // เก็บกวาดไฟล์ .tmp ที่ค้าง
    try { await fsp.unlink(tmp); } catch { /* ไม่มีไฟล์ค้าง ก็ไม่เป็นไร */ }
    return false;
  }
}

// รอให้การเขียนทุกไฟล์ที่ค้างอยู่เสร็จ (ใช้ตอนปิดโปรแกรม)
export async function flushAll() {
  await Promise.allSettled([...writeQueues.values()]);
}

// ---------- ต่อท้ายไฟล์ JSON ที่เป็น array ----------
// ใช้กับ signals-history.json / alerts log
// maxItems: เก็บแค่ N รายการล่าสุด (กันไฟล์โตไม่จำกัด)
export async function appendToArray(name, item, maxItems = 5000) {
  const arr = (await readJson(name, [])) || [];
  const list = Array.isArray(arr) ? arr : [];
  list.push(item);
  // ตัดของเก่าออกถ้าเกินโควตา
  const trimmed = list.length > maxItems ? list.slice(list.length - maxItems) : list;
  await writeJson(name, trimmed);
  return trimmed.length;
}
