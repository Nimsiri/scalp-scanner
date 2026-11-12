// setup-env.js — ตรวจและอัปเดตไฟล์ .env ให้พร้อมใช้กับเวอร์ชัน Web App อัตโนมัติ
//
// ทำอะไร:
//   1) ถ้าไม่มี .env → คัดลอกจาก .env.example
//   2) แก้ค่าที่ต้องเปลี่ยน (เช่น ATR_STOP_MULT=1.5 → 1.0) เฉพาะเมื่อยังเป็นค่าเก่าอยู่
//   3) เพิ่มค่าใหม่ที่ยังไม่มี ต่อท้ายไฟล์พร้อมคำอธิบาย
//   4) ลบบรรทัดที่ประกาศ key ซ้ำ (dotenv เอาตัวท้าย ทำให้แก้ตัวแรกแล้วไม่มีผล — สับสน)
//   5) สำรองไฟล์เดิมเป็น .env.backup-<เวลา> ก่อนเขียนทับทุกครั้ง
//
// ปลอดภัย:
//   - ไม่แตะค่าที่ user ตั้งเอง (LINE token, API key, ทุน, %ความเสี่ยง ฯลฯ)
//   - แก้เฉพาะค่าที่ยังเป็น "ค่าเก่าตามสเปกเดิม" เท่านั้น ถ้า user แก้เองแล้วจะไม่ยุ่ง
//   - รันซ้ำกี่ครั้งก็ได้ ผลเหมือนเดิม (idempotent)
//
// รันเอง: node setup-env.js       (run.bat เรียกให้อัตโนมัติแล้ว)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');

// ═══ ค่าที่ต้องเปลี่ยน — แก้เฉพาะเมื่อยังเป็นค่าเก่าอยู่ ═══
const MIGRATIONS = [
  {
    key: 'ATR_STOP_MULT',
    oldValue: '1.5',
    newValue: '1.0',
    critical: true,
    why: 'ค่า 1.5 เป็นการตั้งแบบ day trade ทำให้ระยะ stop กว้าง ~1.5 ATR\n' +
         '     แต่ระยะถึงเป้ามักอยู่แค่ ~0.5 ATR → R:R ได้ประมาณ 0.33 เสมอ\n' +
         '     ซึ่งไม่มีทางผ่านเกณฑ์ R:R 1:1.5 → จะไม่มีสัญญาณออกมาเลย',
  },
  {
    key: 'UNIVERSE_SIZE',
    oldValue: '60',
    newValue: '30',
    critical: false,
    why: 'ลดจำนวนหุ้นจาก auto screener เพื่อประหยัดโควตา API (คงไว้ 60 ก็ได้ ไม่พัง)',
  },
];

// ═══ ค่าใหม่ที่ต้องมี — เพิ่มเฉพาะที่ยังไม่มี ═══
const NEW_KEYS = [
  ['', '# ═══════════════════════════════════════════════════════════════'],
  ['', '# ค่าที่เพิ่มมาในเวอร์ชัน Web App (setup-env.js เพิ่มให้อัตโนมัติ)'],
  ['', '# หมายเหตุ: ค่าที่แก้ในหน้า Settings จะบันทึกลง data/settings.json'],
  ['', '#          ซึ่งมีลำดับความสำคัญ "สูงกว่า" ไฟล์นี้'],
  ['', '# ═══════════════════════════════════════════════════════════════'],
  ['', ''],
  ['', '# ---------- API keys ของแหล่งข้อมูลหลายชั้น (free tier ทั้งหมด) ----------'],
  ['', '# ไม่ใส่ตัวไหน = ระบบข้าม provider นั้นไปเลย ไม่ crash'],
  ['', '# กรอกผ่านหน้า Settings ของเว็บก็ได้ ไม่ต้องแก้ไฟล์นี้'],
  ['', ''],
  ['', '# Finnhub — ราคา realtime หลัก + ปฏิทินงบ + ข่าว (ฟรี 60 ครั้ง/นาที)'],
  ['', '# ขอที่ https://finnhub.io/register'],
  ['', '# หมายเหตุ: free tier ไม่ให้แท่งเทียน ระบบจึงใช้ Yahoo สำหรับแท่งเทียน'],
  ['FINNHUB_API_KEY', ''],
  ['', ''],
  ['', '# Twelve Data — สำรองราคา + แท่งเทียน (ฟรี 8 credits/นาที, 800/วัน)'],
  ['', '# ขอที่ https://twelvedata.com/pricing'],
  ['TWELVEDATA_API_KEY', ''],
  ['', ''],
  ['', '# Alpha Vantage — คะแนน sentiment เป็นตัวเลขจริง (ฟรี 25 ครั้ง/วัน เท่านั้น)'],
  ['', '# ขอที่ https://www.alphavantage.co/support/#api-key'],
  ['ALPHAVANTAGE_API_KEY', ''],
  ['', ''],
  ['', '# Marketaux — ข่าว + sentiment (โควตากว้างกว่า Alpha Vantage)'],
  ['', '# ขอที่ https://www.marketaux.com/register'],
  ['MARKETAUX_API_KEY', ''],
  ['', ''],
  ['', '# Financial Modeling Prep — float + short interest (ฟรี 250 ครั้ง/วัน)'],
  ['', '# ขอที่ https://site.financialmodelingprep.com/developer/docs'],
  ['FMP_API_KEY', ''],
  ['', ''],
  ['', '# ---------- โหมดข้อมูลจำลอง ----------'],
  ['', '# true = ใช้ข้อมูลสังเคราะห์ ไม่ต่ออินเทอร์เน็ต (ลองหน้าเว็บตอนตลาดปิดได้)'],
  ['', '# หรือใช้คำสั่ง npm run demo ซึ่งเปิดโหมดนี้ให้อัตโนมัติ'],
  ['MOCK_DATA', 'false'],
  ['', ''],
  ['', '# ---------- port ของ web server ----------'],
  ['PORT', '3000'],
  ['', ''],
  ['', '# ---------- ความเสี่ยง / จุดตัดขาดทุน ----------'],
  ['MIN_STOP_ATR', '0.35'],
  ['TARGET_EXT_ATR', '0.5'],
  ['MIN_RR', '1.5'],
  ['', ''],
  ['', '# ---------- แนวต้าน / ราคาเป้าหมายแจ้งเตือน ----------'],
  ['ALERT_OFFSET_PCT', '0.1'],
  ['PIVOT_K', '2'],
  ['CLUSTER_ATR_MULT', '0.25'],
  ['', ''],
  ['', '# ---------- น้ำหนักคะแนน 6 ปัจจัย (รวมต้องได้ 100) ----------'],
  ['W_RVOL', '25'],
  ['W_VOLATILITY', '20'],
  ['W_RESISTANCE', '15'],
  ['W_MOMENTUM', '15'],
  ['W_SENTIMENT', '15'],
  ['W_LIQUIDITY', '10'],
  ['RENORMALIZE_WEIGHTS', 'false'],
  ['', ''],
  ['', '# ---------- เกณฑ์คะแนน ----------'],
  ['', '# SIGNAL_SCORE   = คะแนนที่ถือว่าเป็น "สัญญาณ" (ถ้าไม่ใส่จะใช้ค่า MIN_SCORE เดิม)'],
  ['', '# HIDE_BELOW_SCORE = ซ่อนแถวที่คะแนนต่ำกว่านี้ออกจากตารางเลย (0 = แสดงทุกตัว)'],
  ['SIGNAL_SCORE', '70'],
  ['HIDE_BELOW_SCORE', '0'],
  ['', ''],
  ['', '# ---------- ช่วงความผันผวนที่เหมาะกับ scalping (%/วัน) ----------'],
  ['ATR_PCT_LOW', '1.5'],
  ['ATR_PCT_HIGH', '3.0'],
  ['', ''],
  ['', '# ---------- universe ----------'],
  ['USE_AUTO_SCREENER', 'true'],
  ['', ''],
  ['', '# ---------- สแกนตอนตลาดปิดหรือไม่ ----------'],
  ['', '# true = สแกนต่อแม้ตลาดปิด (เห็นราคาล่าสุดก่อนปิด)'],
  ['', '# false = ข้ามรอบไปเลย ประหยัดโควตา API'],
  ['SCAN_WHEN_CLOSED', 'true'],
  ['', ''],
  ['', '# ---------- sentiment ----------'],
  ['NEWS_PROVIDER_ORDER', 'alphavantage,marketaux,finnhub'],
  ['SENTIMENT_TOP_N', '3'],
  ['', ''],
  ['', '# ---------- LINE (ช่องเสริม) ----------'],
  ['', '# false = ไม่ส่ง LINE (ใช้แจ้งเตือนบนหน้าเว็บอย่างเดียว)'],
  ['LINE_ENABLED', 'false'],
];

const ASSIGN = /^([A-Z][A-Z0-9_]*)\s*=/;

function main() {
  console.log('');
  console.log('── ตรวจไฟล์ .env ──');

  // ---------- 1) ไม่มี .env → คัดลอกจาก .env.example ----------
  if (!fs.existsSync(ENV)) {
    if (!fs.existsSync(EXAMPLE)) {
      console.log('  [ผิดพลาด] ไม่พบทั้ง .env และ .env.example');
      console.log('            ไฟล์โปรเจกต์อาจไม่ครบ');
      process.exitCode = 1;
      return;
    }
    fs.copyFileSync(EXAMPLE, ENV);
    console.log('  ไม่พบ .env — คัดลอกจาก .env.example ให้แล้ว');
    console.log('  (ยังไม่ต้องกรอก API key ก็เปิดใช้งานได้ ใส่ทีหลังในหน้า Settings ได้)');
    console.log('');
    return; // .env.example มีค่าใหม่ครบแล้ว ไม่ต้อง migrate
  }

  const original = fs.readFileSync(ENV, 'utf8');
  let lines = original.split(/\r?\n/);

  const existing = new Set();
  for (const l of lines) {
    const m = ASSIGN.exec(l.trim());
    if (m) existing.add(m[1]);
  }

  const changed = [];
  const added = [];
  const skipped = [];

  // ---------- 2) แก้ค่าที่ต้องเปลี่ยน ----------
  for (const mig of MIGRATIONS) {
    if (!existing.has(mig.key)) continue;

    let done = false;
    lines = lines.map((l) => {
      const m = ASSIGN.exec(l.trim());
      if (!m || m[1] !== mig.key || done) return l;

      const current = l.trim().slice(l.trim().indexOf('=') + 1).trim();
      if (current === mig.oldValue) {
        done = true;
        changed.push(mig);
        return `${mig.key}=${mig.newValue}`;
      }
      // user แก้เป็นค่าอื่นเองแล้ว → ไม่ยุ่ง
      if (current !== mig.newValue) skipped.push({ ...mig, current });
      return l;
    });
  }

  // ---------- 3) เพิ่มค่าใหม่ที่ยังไม่มี ----------
  // เพิ่มเฉพาะ key ที่ขาด และเก็บคอมเมนต์/บรรทัดว่างที่อยู่ติดกันไปด้วย
  const missing = NEW_KEYS.filter(([k]) => k && !existing.has(k)).map(([k]) => k);

  if (missing.length > 0) {
    const block = [];
    let pendingComments = [];

    for (const [key, val] of NEW_KEYS) {
      if (!key) {
        pendingComments.push(val); // คอมเมนต์หรือบรรทัดว่าง
        continue;
      }
      if (existing.has(key)) {
        pendingComments = []; // key นี้มีแล้ว ทิ้งคอมเมนต์ของมันไป
        continue;
      }
      block.push(...pendingComments);
      pendingComments = [];
      block.push(`${key}=${val}`);
      added.push(key);
    }

    if (block.length > 0) {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', ...block, '');
    }
  }

  // ---------- 4) ลบบรรทัดที่ประกาศ key ซ้ำ (เก็บตัวท้าย ตามที่ dotenv ใช้) ----------
  const lastIdx = new Map();
  lines.forEach((l, i) => {
    const m = ASSIGN.exec(l.trim());
    if (m) lastIdx.set(m[1], i);
  });
  const deduped = [];
  const removedDupes = [];
  lines.forEach((l, i) => {
    const m = ASSIGN.exec(l.trim());
    if (m && lastIdx.get(m[1]) !== i) { removedDupes.push(m[1]); return; }
    deduped.push(l);
  });
  lines = deduped;

  const updated = lines.join('\r\n'); // CRLF ให้ Notepad เปิดอ่านสวย

  // ---------- ไม่มีอะไรเปลี่ยน ----------
  if (changed.length === 0 && added.length === 0 && removedDupes.length === 0) {
    console.log('  .env พร้อมใช้งานอยู่แล้ว ไม่ต้องแก้อะไร');
    if (skipped.length > 0) {
      for (const s of skipped) {
        console.log(`  หมายเหตุ: ${s.key} = ${s.current} (คุณตั้งค่าเองไว้ ระบบไม่แก้ให้)`);
      }
    }
    console.log('');
    return;
  }

  // ---------- 5) สำรองแล้วเขียน ----------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(ROOT, `.env.backup-${stamp}`);
  try {
    fs.copyFileSync(ENV, backup);
  } catch (err) {
    console.log(`  [ผิดพลาด] สำรองไฟล์ .env ไม่สำเร็จ: ${err.message}`);
    console.log('            ยกเลิกการแก้ไข เพื่อความปลอดภัยของข้อมูลเดิม');
    process.exitCode = 1;
    return;
  }

  try {
    fs.writeFileSync(ENV, updated, 'utf8');
  } catch (err) {
    console.log(`  [ผิดพลาด] เขียนไฟล์ .env ไม่สำเร็จ: ${err.message}`);
    console.log(`            ไฟล์เดิมยังอยู่ที่ ${path.basename(backup)}`);
    process.exitCode = 1;
    return;
  }

  // ---------- รายงาน ----------
  console.log(`  สำรองไฟล์เดิมไว้ที่ ${path.basename(backup)}`);

  for (const c of changed) {
    console.log('');
    console.log(`  ${c.critical ? '[สำคัญ]' : '       '} แก้ ${c.key}: ${c.oldValue} -> ${c.newValue}`);
    for (const line of c.why.split('\n')) console.log(`     ${line.replace(/^\s{5}/, '')}`);
  }

  if (added.length > 0) {
    console.log('');
    console.log(`  เพิ่มค่าใหม่ ${added.length} รายการ (ทุกตัวมีค่าเริ่มต้นที่ใช้งานได้ทันที):`);
    // พิมพ์ 6 ตัวต่อบรรทัด กันล้นจอ
    for (let i = 0; i < added.length; i += 6) {
      console.log(`     ${added.slice(i, i + 6).join(', ')}`);
    }
  }

  if (removedDupes.length > 0) {
    console.log('');
    console.log(`  ลบบรรทัดที่ประกาศซ้ำ ${removedDupes.length} บรรทัด: ${[...new Set(removedDupes)].join(', ')}`);
    console.log('     (dotenv ใช้ค่าตัวท้ายสุด ถ้าปล่อยไว้จะแก้ตัวแรกแล้วไม่มีผล ทำให้สับสน)');
  }

  if (skipped.length > 0) {
    console.log('');
    for (const s of skipped) {
      console.log(`  ไม่แก้ ${s.key} = ${s.current} (คุณตั้งค่าเองไว้ ระบบไม่ทับ)`);
    }
  }

  console.log('');
  console.log('  .env พร้อมใช้งานแล้ว (API key และ LINE token เดิมของคุณไม่ถูกแตะต้อง)');
  console.log('');
}

main();
