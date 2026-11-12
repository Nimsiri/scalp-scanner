// journal.js — บันทึกเหตุการณ์ (สัญญาณเข้า/ออก) ลงไฟล์ logs/journal.jsonl แบบ 1 บรรทัด = 1 JSON
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const JOURNAL_PATH = path.join(LOG_DIR, 'journal.jsonl');

// เตรียมโฟลเดอร์ logs ให้พร้อมใช้งาน (ทำครั้งเดียวตอนโหลดไฟล์นี้)
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error(`⚠️  สร้างโฟลเดอร์ logs ไม่สำเร็จ: ${err.message}`);
}

// บันทึกเหตุการณ์ 1 รายการ (ไม่รอผลลัพธ์ ไม่ block การทำงานหลัก)
export function logEvent(kind, data) {
  const line = JSON.stringify({ kind, ts: new Date().toISOString(), ...data }) + '\n';
  fsp.appendFile(JOURNAL_PATH, line, 'utf8').catch((err) => {
    console.error(`⚠️  บันทึก journal ไม่สำเร็จ: ${err.message}`);
  });
}

// อ่าน journal ทั้งหมด กรองเฉพาะ kind ที่ต้องการ (ไม่ระบุ = คืนทั้งหมด)
// ข้ามบรรทัดที่ parse JSON ไม่ได้ (ไฟล์เสีย/เขียนค้าง) ทิ้งไปเงียบ ๆ
export async function readJournal(kind) {
  let raw;
  try {
    raw = await fsp.readFile(JOURNAL_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return []; // ยังไม่เคยมี event เลย
    console.error(`⚠️  อ่าน journal ไม่สำเร็จ: ${err.message}`);
    return [];
  }

  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (!kind || obj.kind === kind) out.push(obj);
    } catch {
      // บรรทัดเสีย ข้ามไป
    }
  }
  return out;
}
