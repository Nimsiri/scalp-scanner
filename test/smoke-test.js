// test/smoke-test.js — ทดสอบว่าระบบทำงานได้จริง (รันด้วย npm test)
//
// ทดสอบตามที่สเปกกำหนด:
//   1) server เปิดที่ port 3000 ได้
//   2) GET /api/status ตอบ 200
//   3) POST /api/scanner/start แล้ว status เปลี่ยนเป็น running จริง
//   4) POST /api/scanner/stop แล้วหยุดจริง (ไม่มี interval ค้าง)
//   5) เพิ่ม ticker แล้วอ่านกลับจาก watchlist.json ได้
//   6) ทุก provider file มี export ครบตาม interface เดียวกัน
//
// รันในโหมด MOCK_DATA=true → ไม่ต้องต่ออินเทอร์เน็ต ไม่ต้องมี API key ผลเหมือนกันทุกครั้ง
// ใช้ไฟล์ data/ ชั่วคราวแยก แล้วคืนสภาพเดิมตอนจบ (ไม่ทำลาย watchlist จริงของ user)

process.env.MOCK_DATA = 'true';
process.env.SESSION = 'all';
process.env.PORT = process.env.TEST_PORT || '3000';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'data', '_test-backup');
const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;

// ═══════════════ ตัวช่วยทดสอบ ═══════════════
let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { passed += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ไม่ใช่ JSON */ }
  return { status: res.status, json };
}

// ═══════════════ สำรอง / คืนไฟล์ data ═══════════════
const DATA_FILES = ['watchlist.json', 'settings.json', 'alerts.json', 'signals-history.json', 'alerts-history.json'];

async function backupData() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  for (const f of DATA_FILES) {
    const src = path.join(DATA_DIR, f);
    if (fs.existsSync(src)) await fsp.copyFile(src, path.join(BACKUP_DIR, f));
  }
}

async function restoreData() {
  for (const f of DATA_FILES) {
    const bak = path.join(BACKUP_DIR, f);
    const dst = path.join(DATA_DIR, f);
    if (fs.existsSync(bak)) await fsp.copyFile(bak, dst);
    else if (fs.existsSync(dst)) await fsp.unlink(dst); // ไฟล์นี้ test สร้างขึ้นมาเอง ลบทิ้ง
  }
  await fsp.rm(BACKUP_DIR, { recursive: true, force: true });
}

// ═══════════════ ทดสอบข้อ 6: interface ของ provider ═══════════════
// ทำก่อนเปิด server เพราะไม่ต้องพึ่ง server
async function testProviderInterface() {
  console.log('\n─── 6) ทุก provider file มี export ครบตาม interface เดียวกัน ───');

  const PROVIDER_DIR = path.join(ROOT, 'src', 'providers');
  const files = (await fsp.readdir(PROVIDER_DIR))
    .filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js');

  check('พบไฟล์ provider', files.length >= 5, `${files.length} ไฟล์: ${files.join(', ')}`);

  // field และ method ที่ทุก provider ต้องมี
  const REQUIRED_FIELDS = ['id', 'name', 'capabilities', 'limits'];
  const REQUIRED_METHODS = ['isConfigured', 'setKey', 'getQuota'];
  // ทุก capability ที่ประกาศ ต้องมีเมธอดชื่อเดียวกันจริง
  const CAPABILITY_METHODS = ['quote', 'bars', 'earnings', 'news', 'screener', 'fundamentals'];

  for (const file of files) {
    // ต้องแปลงเป็น file:// URL ก่อน import — Windows path เช่น "D:\..." ถ้าส่งดิบๆ
    // เข้า import() จะถูกตีความเป็น URL protocol "d:" แล้วพังด้วย ERR_UNSUPPORTED_ESM_URL_SCHEME
    const mod = await import(pathToFileURL(path.join(PROVIDER_DIR, file)).href);
    const p = mod.default;
    const label = `provider ${file}`;

    if (!p || typeof p !== 'object') { check(label, false, 'ไม่มี default export ที่เป็น object'); continue; }

    const missingFields = REQUIRED_FIELDS.filter((f) => p[f] === undefined);
    const missingMethods = REQUIRED_METHODS.filter((m) => typeof p[m] !== 'function');
    const capsOk = Array.isArray(p.capabilities) && p.capabilities.length > 0;
    // ประกาศ capability ไหน ต้องมีเมธอดนั้น (กันประกาศเกินจริง)
    const declaredButMissing = capsOk
      ? p.capabilities.filter((c) => CAPABILITY_METHODS.includes(c) && typeof p[c] !== 'function')
      : [];
    // มี requiresKey ต้องมีค่า (null ก็ได้ = ไม่ต้องใช้ key)
    const hasRequiresKey = 'requiresKey' in p;

    const problems = [];
    if (missingFields.length) problems.push(`ขาด field: ${missingFields.join(', ')}`);
    if (missingMethods.length) problems.push(`ขาดเมธอด: ${missingMethods.join(', ')}`);
    if (!capsOk) problems.push('capabilities ต้องเป็น array ที่ไม่ว่าง');
    if (declaredButMissing.length) problems.push(`ประกาศ capability แต่ไม่มีเมธอด: ${declaredButMissing.join(', ')}`);
    if (!hasRequiresKey) problems.push('ขาด field requiresKey');

    check(label, problems.length === 0,
      problems.length === 0
        ? `id=${p.id} caps=[${p.capabilities.join(',')}]`
        : problems.join(' | '));
  }

  // getQuota() ต้องคืนโครงสร้างที่ UI ใช้ได้
  const { PROVIDER_LIST } = await import(pathToFileURL(path.join(ROOT, 'src', 'providers', 'index.js')).href);
  let quotaOk = true;
  const quotaBad = [];
  for (const p of PROVIDER_LIST) {
    const q = p.getQuota();
    const need = ['usedMinute', 'usedDay', 'perMinute', 'perDay'];
    const miss = need.filter((k) => !(k in q));
    if (miss.length) { quotaOk = false; quotaBad.push(`${p.id}: ขาด ${miss.join(',')}`); }
  }
  check('getQuota() คืนโครงสร้างที่ถูกต้องทุก provider', quotaOk, quotaBad.join(' | ') || `${PROVIDER_LIST.length} provider`);
}

// ═══════════════ main ═══════════════
let serverProc = null;

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Scalp Scanner — Smoke Test');
  console.log(`  โหมดข้อมูลจำลอง (MOCK_DATA=true) · port ${PORT}`);
  console.log('═══════════════════════════════════════════════════════════');

  await backupData();

  // ล้าง watchlist ก่อนเริ่ม เพื่อให้ผลทดสอบไม่ขึ้นกับข้อมูลเดิม
  await fsp.writeFile(path.join(DATA_DIR, 'watchlist.json'), '[]', 'utf8');

  await testProviderInterface();

  // ---------- 1) เปิด server ----------
  console.log('\n─── 1) server เปิดที่ port ' + PORT + ' ได้ ───');
  const { server } = await import('../server.js');

  // รอให้ listen จริง
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) { up = true; break; }
    } catch { /* ยังไม่พร้อม */ }
    await sleep(250);
  }
  if (!check(`server ตอบที่ ${BASE}`, up, up ? '' : 'เปิดไม่สำเร็จภายใน 10 วินาที')) {
    finish();
    return;
  }

  const addr = server.address();
  check('server listen ที่ port ที่ถูกต้อง', addr?.port === PORT, `port=${addr?.port}`);

  // ---------- 2) GET /api/status ----------
  console.log('\n─── 2) GET /api/status ตอบ 200 ───');
  const st = await req('GET', '/api/status');
  check('GET /api/status ตอบ 200', st.status === 200, `status=${st.status}`);
  check('/api/status มี field running', typeof st.json?.running === 'boolean', `running=${st.json?.running}`);
  check('/api/status มี field market', !!st.json?.market, `ตลาด ${st.json?.market?.open ? 'เปิด' : 'ปิด'}`);
  check('scanner ยังไม่เริ่มทำงานเอง (แยกจาก server)', st.json?.running === false,
    'server เปิดแล้วแต่ scanner ต้องหยุดอยู่จนกด Start');

  // /api/state ต้องใช้ได้ด้วย (ชื่อพ้อง)
  const st2 = await req('GET', '/api/state');
  check('GET /api/state (ชื่อพ้อง) ตอบ 200', st2.status === 200, `status=${st2.status}`);

  // ---------- 5) เพิ่ม ticker แล้วอ่านกลับจากไฟล์ ----------
  // ทำก่อน start เพื่อให้มีหุ้นให้สแกน
  console.log('\n─── 5) เพิ่ม ticker แล้วอ่านกลับจาก watchlist.json ได้ ───');
  const add = await req('POST', '/api/watchlist', { tickers: 'NVDA, TSLA, ZZFAKE' });
  check('POST /api/watchlist ตอบ 200', add.status === 200, `status=${add.status}`);

  const okAdds = (add.json?.results || []).filter((r) => r.ok).map((r) => r.symbol);
  const badAdds = (add.json?.results || []).filter((r) => !r.ok).map((r) => r.symbol);
  check('เพิ่ม ticker ที่มีจริงได้', okAdds.includes('NVDA') && okAdds.includes('TSLA'), `เพิ่มได้: ${okAdds.join(', ')}`);
  check('ปฏิเสธ ticker ที่ไม่มีจริง (validate ทำงาน)', badAdds.includes('ZZFAKE'),
    `ปฏิเสธ: ${badAdds.join(', ') || 'ไม่ปฏิเสธอะไรเลย'}`);

  // อ่านกลับจากไฟล์จริงบนดิสก์ (ไม่ใช่จาก API — พิสูจน์ว่า persist จริง)
  await sleep(300); // รอ atomic write เสร็จ
  const wlPath = path.join(DATA_DIR, 'watchlist.json');
  let fileItems = [];
  try {
    fileItems = JSON.parse(await fsp.readFile(wlPath, 'utf8'));
  } catch (err) {
    check('อ่าน data/watchlist.json ได้', false, err.message);
  }
  const fileSymbols = fileItems.map((x) => x.symbol);
  check('data/watchlist.json มีข้อมูลที่เพิ่งเพิ่ม (persist จริง)',
    fileSymbols.includes('NVDA') && fileSymbols.includes('TSLA'),
    `ในไฟล์: [${fileSymbols.join(', ')}]`);
  check('ticker ที่ไม่มีจริงไม่ถูกเขียนลงไฟล์', !fileSymbols.includes('ZZFAKE'));

  // ตั้งราคาเป้าหมายเอง แล้วอ่านกลับจากไฟล์
  const tgt = await req('PUT', '/api/watchlist/NVDA/target', { targetPrice: 999.99 });
  check('PUT ตั้งราคาเป้าหมายเองได้', tgt.status === 200 && tgt.json?.mode === 'manual', `mode=${tgt.json?.mode}`);
  await sleep(300);
  const wl2 = JSON.parse(await fsp.readFile(wlPath, 'utf8'));
  check('ราคาเป้าหมายถูกบันทึกลงไฟล์', wl2.find((x) => x.symbol === 'NVDA')?.targetPrice === 999.99,
    `targetPrice=${wl2.find((x) => x.symbol === 'NVDA')?.targetPrice}`);

  // ล้างเป้าหมาย → กลับไปโหมด auto
  const tgtClear = await req('PUT', '/api/watchlist/NVDA/target', { targetPrice: null });
  check('ล้างราคาเป้าหมาย → กลับไปโหมด auto', tgtClear.json?.mode === 'auto', `mode=${tgtClear.json?.mode}`);

  // ---------- 3) start แล้ว running จริง ----------
  console.log('\n─── 3) POST /api/scanner/start แล้ว status เปลี่ยนเป็น running จริง ───');
  const start = await req('POST', '/api/scanner/start');
  check('POST /api/scanner/start ตอบ 200', start.status === 200, `status=${start.status}`);
  check('start คืน ok=true', start.json?.ok === true);

  const afterStart = await req('GET', '/api/status');
  check('/api/status บอกว่า running=true', afterStart.json?.running === true, `running=${afterStart.json?.running}`);

  // start ซ้ำต้องไม่พัง และต้องบอกว่าทำงานอยู่แล้ว
  const startAgain = await req('POST', '/api/scanner/start');
  check('กด start ซ้ำไม่พัง และแจ้งว่าทำงานอยู่แล้ว',
    startAgain.status === 200 && startAgain.json?.ok === false && !!startAgain.json?.reason,
    startAgain.json?.reason || '');

  // รอให้สแกนรอบแรกเสร็จ (มีข้อมูลออกมา)
  let scanned = false;
  for (let i = 0; i < 60; i++) {
    const s = await req('GET', '/api/status');
    if (s.json?.scanCount > 0 && s.json?.scanning === false) { scanned = true; break; }
    await sleep(500);
  }
  const afterScan = await req('GET', '/api/status');
  check('สแกนรอบแรกเสร็จและมีผลลัพธ์ออกมา', scanned && (afterScan.json?.rows?.length > 0),
    `scanCount=${afterScan.json?.scanCount} rows=${afterScan.json?.rows?.length}`);

  // ตรวจว่าแถวมีข้อมูลที่จำเป็นครบ
  const row = (afterScan.json?.rows || [])[0];
  if (row) {
    check('แถวผลลัพธ์มีคะแนนและ breakdown (ไม่เป็น black box)',
      Number.isFinite(row.score) && Array.isArray(row.breakdown) && row.breakdown.length === 6,
      `score=${row.score} breakdown=${row.breakdown?.length} ปัจจัย`);
    check('แถวผลลัพธ์มีแนวต้านและราคาเป้าหมาย',
      row.resistance != null && 'alertTarget' in row && 'alertMode' in row,
      `แนวต้าน=${row.resistance?.level?.toFixed(2)} เป้า=${row.alertTarget?.toFixed(2)} โหมด=${row.alertMode}`);
    check('แถวผลลัพธ์มี R:R และขนาดไม้',
      row.rr != null && row.position != null,
      `R:R=${row.rr?.label || '-'} ขนาดไม้=${row.position?.shares}`);
    check('แถวผลลัพธ์มี Expected Move (จากค่าสถิติ)',
      row.expectedMove != null, `${row.expectedMove?.label}`);
  } else {
    check('แถวผลลัพธ์มีข้อมูลครบ', false, 'ไม่มีแถวผลลัพธ์เลย');
  }

  // ---------- 4) stop แล้วหยุดจริง ไม่มี interval ค้าง ----------
  console.log('\n─── 4) POST /api/scanner/stop แล้วหยุดจริง (ไม่มี interval ค้าง) ───');
  const stop = await req('POST', '/api/scanner/stop');
  check('POST /api/scanner/stop ตอบ 200', stop.status === 200, `status=${stop.status}`);
  check('stop คืน ok=true', stop.json?.ok === true);

  const afterStop = await req('GET', '/api/status');
  check('/api/status บอกว่า running=false', afterStop.json?.running === false, `running=${afterStop.json?.running}`);
  check('nextScanAt ถูกล้าง (ไม่มี timer รออยู่)', !afterStop.json?.nextScanAt,
    `nextScanAt=${afterStop.json?.nextScanAt}`);

  // ---------- พิสูจน์ว่าไม่มี interval ค้างจริง ----------
  // ตั้ง interval เป็น 10 วินาที (ต่ำสุดที่ตั้งได้) แล้วรอ 12 วินาที
  // ถ้ามี timer ค้าง scanCount จะเพิ่ม
  await req('PUT', '/api/settings', { scanIntervalSec: 10 });
  const countAtStop = (await req('GET', '/api/status')).json?.scanCount;
  console.log(`   ⏳ รอ 12 วินาที เพื่อพิสูจน์ว่าไม่มี timer ค้าง (scanCount ตอนนี้ = ${countAtStop})...`);
  await sleep(12_000);
  const countLater = (await req('GET', '/api/status')).json?.scanCount;
  check('หยุดแล้วไม่มีรอบสแกนเกิดขึ้นอีก (ไม่มี interval ค้างจริง)',
    countLater === countAtStop,
    `scanCount: ${countAtStop} → ${countLater}${countLater !== countAtStop ? ' ← มี timer ค้าง!' : ' (ไม่เปลี่ยน ✓)'}`);

  // stop ซ้ำต้องไม่พัง
  const stopAgain = await req('POST', '/api/scanner/stop');
  check('กด stop ซ้ำไม่พัง และแจ้งว่าหยุดอยู่แล้ว',
    stopAgain.status === 200 && stopAgain.json?.ok === false && !!stopAgain.json?.reason,
    stopAgain.json?.reason || '');

  // ---------- Scan Now ต้องทำงานได้ตอนลูปหยุดอยู่ ----------
  console.log('\n─── เพิ่มเติม: Scan Now ทำงานได้แม้ลูปหยุดอยู่ ───');
  const beforeNow = (await req('GET', '/api/status')).json?.scanCount;
  const scanNow = await req('POST', '/api/scanner/scan-now');
  check('POST /api/scanner/scan-now ตอบ 200', scanNow.status === 200, `status=${scanNow.status}`);
  const afterNow = await req('GET', '/api/status');
  check('Scan Now สแกนให้ 1 รอบจริง', afterNow.json?.scanCount === beforeNow + 1,
    `scanCount: ${beforeNow} → ${afterNow.json?.scanCount}`);
  check('Scan Now ไม่ทำให้ลูปกลับมาทำงาน', afterNow.json?.running === false,
    `running=${afterNow.json?.running}`);

  // ---------- ทดสอบการแจ้งเตือนราคา + กันเตือนซ้ำ ----------
  console.log('\n─── เพิ่มเติม: แจ้งเตือนราคา + กันเตือนซ้ำ + reset ───');
  const rows = afterNow.json?.rows || [];
  const target = rows.find((r) => r.from === 'watchlist' && Number.isFinite(r.price));
  if (target) {
    // ตั้งเป้าต่ำกว่าราคาปัจจุบัน → ต้อง trigger รอบถัดไป
    await req('PUT', `/api/watchlist/${target.symbol}/target`, { targetPrice: Math.round(target.price * 0.97 * 100) / 100 });
    await req('POST', '/api/scanner/scan-now');
    const r1 = (await req('GET', '/api/status')).json?.rows?.find((r) => r.symbol === target.symbol);
    check('ราคาแตะเป้า → แจ้งเตือนทำงาน', r1?.alertTriggered === true, `${target.symbol} triggered=${r1?.alertTriggered}`);

    // สแกนอีกรอบ ต้องไม่เตือนซ้ำ
    await req('POST', '/api/scanner/scan-now');
    const r2 = (await req('GET', '/api/status')).json?.rows?.find((r) => r.symbol === target.symbol);
    check('สแกนซ้ำแล้วไม่เตือนซ้ำ (กันเตือนรัว)',
      r2?.alertTriggered === true && r2?.alertJustTriggered === false,
      `alertJustTriggered=${r2?.alertJustTriggered}`);

    // reset แล้วต้องเตือนใหม่ได้
    const rst = await req('POST', `/api/alerts/${target.symbol}/reset`);
    check('POST reset alert รายตัวสำเร็จ', rst.status === 200 && rst.json?.ok === true);
    await req('POST', '/api/scanner/scan-now');
    const r3 = (await req('GET', '/api/status')).json?.rows?.find((r) => r.symbol === target.symbol);
    check('reset แล้วเตือนใหม่ได้', r3?.alertJustTriggered === true, `alertJustTriggered=${r3?.alertJustTriggered}`);
  } else {
    check('ทดสอบการแจ้งเตือนราคา', false, 'ไม่มีแถวจาก watchlist ให้ทดสอบ');
  }

  // ═══════════ regression test: บั๊กที่เคยเจอจากการรีวิวโค้ด ═══════════
  console.log('\n─── regression: กด Scan Now แล้วกด Start ตามทันที ต้องไม่เกิดรอบซ้อน/timer กำพร้า ───');
  {
    await req('POST', '/api/scanner/stop');
    await req('PUT', '/api/settings', { scanIntervalSec: 10 });

    // ยิง scan-now แบบไม่รอผล แล้วกด start ทันทีระหว่างที่ยังสแกนอยู่
    const nowPromise = req('POST', '/api/scanner/scan-now');
    await sleep(60); // ให้ _scanning เป็น true ก่อน
    const startDuring = await req('POST', '/api/scanner/start');
    check('กด Start ระหว่างที่ Scan Now ทำงาน → ไม่ error', startDuring.status === 200);
    await nowPromise;

    // รอให้ทุกอย่างนิ่ง แล้วหยุด
    for (let i = 0; i < 40; i++) {
      const s2 = await req('GET', '/api/status');
      if (!s2.json?.scanning) break;
      await sleep(250);
    }
    await req('POST', '/api/scanner/stop');
    const afterStopCount = (await req('GET', '/api/status')).json?.scanCount;

    console.log(`   ⏳ รอ 13 วินาที ตรวจว่าไม่มี timer กำพร้าหลุดรอด (scanCount = ${afterStopCount})...`);
    await sleep(13_000);
    const laterCount = (await req('GET', '/api/status')).json?.scanCount;
    check('ไม่มี timer กำพร้าหลังกด Scan Now + Start + Stop',
      laterCount === afterStopCount,
      `scanCount: ${afterStopCount} → ${laterCount}${laterCount !== afterStopCount ? ' ← มี timer หลุดรอด!' : ' (ไม่เปลี่ยน ✓)'}`);
  }

  console.log('\n─── regression: signals-history ต้องบันทึก targetBreakout ที่ backtest ใช้ ───');
  {
    // ทำให้เกิดสัญญาณด้วยการลดเกณฑ์คะแนนลง
    await req('PUT', '/api/settings', { signalScore: 1, sentimentTopN: 1 });
    await req('POST', '/api/scanner/scan-now');
    await sleep(500);

    let hist = [];
    try {
      hist = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'signals-history.json'), 'utf8'));
    } catch { /* ยังไม่มีไฟล์ */ }

    const latest = hist[hist.length - 1];
    check('มีสัญญาณถูกบันทึกลง signals-history.json', !!latest, `รวม ${hist.length} รายการ`);
    if (latest) {
      check('บันทึก targetBreakout (field ที่ backtest อ่าน)',
        Number.isFinite(latest.targetBreakout),
        `targetBreakout=${latest.targetBreakout} · target=${latest.target}`);
      check('targetBreakout อยู่เหนือ target (แนวต้าน) จริง',
        latest.targetBreakout > latest.target,
        `${latest.target} → ${latest.targetBreakout}`);
      // ★ v2: rr ที่บันทึกเป็นค่า "สุทธิ" แล้ว — กำไรหักต้นทุน หารด้วย (ระยะ stop + ต้นทุน)
      // ตรวจสูตรนี้เข้มกว่าเดิม เพราะจับได้ทั้งกรณี entry ผิด, stop ผิด และ costPerShare ไม่ถูกบันทึก
      {
        const cost = latest.costPerShare ?? 0;
        const recomputed = ((latest.targetBreakout - latest.entry) - cost) / ((latest.entry - latest.stop) + cost);
        check('R:R สุทธิที่บันทึกไว้สอดคล้องกับ entry/stop/targetBreakout/costPerShare',
          Math.abs(recomputed - latest.rr) < 0.02,
          `คำนวณใหม่ได้ ${recomputed.toFixed(3)} vs ที่บันทึก ${latest.rr?.toFixed(3)} (ต้นทุน $${cost.toFixed(3)}/หุ้น)`);

        const recomputedGross = (latest.targetBreakout - latest.entry) / (latest.entry - latest.stop);
        check('R:R ขั้นต้นที่บันทึกไว้ถูกต้อง และสูงกว่าค่าสุทธิเสมอ',
          Number.isFinite(latest.rrGross)
            && Math.abs(recomputedGross - latest.rrGross) < 0.02
            && latest.rrGross > latest.rr,
          `ขั้นต้น ${latest.rrGross?.toFixed(3)} > สุทธิ ${latest.rr?.toFixed(3)}`);
      }
    }
    await req('POST', '/api/settings/reset');
  }

  // ★ v2: timer ตัวที่สอง (hot-poll) ต้องไม่ทำลายข้อกำหนด "กด Stop แล้วหยุดจริง"
  console.log('\n─── regression: บั๊กที่เจอตอนทดสอบเชิงลึก ───');
  {
    // ── B1: screener ล้ม ต้องไม่บอกว่า "ยังไม่ได้เปิด screener" ──
    // เดิม getScreener กลืน error แล้วคืน [] → ข้อความบอกให้ไปเปิด screener ทั้งที่เปิดอยู่แล้ว
    // เก็บ watchlist เดิมไว้ก่อน — เทสต์ข้างล่างยังต้องใช้
    const savedWl = ((await req('GET', '/api/watchlist')).json?.items || []).map((w) => w.symbol);
    await req('DELETE', '/api/watchlist');
    // ★ ปิดหุ้นไทยชั่วคราว — รายชื่อหุ้นไทยตั้งต้นจะทำให้ "ไม่มีหุ้นให้สแกน" ไม่เกิดขึ้น
    const prevTh = (await req('GET', '/api/settings')).json?.settings?.thEnabled;
    await req('PUT', '/api/settings', { useAutoScreener: false, thEnabled: false });
    await req('POST', '/api/scanner/scan-now');
    const offNote = (await req('GET', '/api/rows')).json?.summary?.note || '';
    check('B1 · screener ปิดอยู่ → บอกว่าปิดอยู่',
      offNote.includes('ปิดอยู่'), offNote.slice(0, 100));

    await req('PUT', '/api/settings', { useAutoScreener: true, thEnabled: prevTh !== false });
    await req('POST', '/api/scanner/scan-now');
    const onRows = (await req('GET', '/api/rows')).json;
    const onNote = onRows?.summary?.note || '';
    check('B1 · screener เปิดและทำงานได้ → ไม่มีข้อความบอกให้ไปเปิด screener',
      (onRows?.rows || []).length > 0 || !onNote.includes('เปิด auto screener'),
      `${(onRows?.rows || []).length} แถว · note="${onNote.slice(0, 80)}"`);
    check('B1 · summary มีช่อง screenerFailures ให้ UI อ่าน',
      Array.isArray(onRows?.summary?.screenerFailures),
      `screenerFailures=${JSON.stringify(onRows?.summary?.screenerFailures)}`);

    // ── B5/B6: เติมไม้แล้วความเสี่ยงรวมต้องไม่เกิน 1R เดิม และ R ต้องคิดถูกหลังเติม ──
    const rows2 = (await req('GET', '/api/rows')).json?.rows || [];
    const cand = rows2.find((r) => r.passed && (r.position?.shares || 0) >= 4);
    if (!cand) {
      check('B5 · เติมไม้แล้วความเสี่ยงรวมไม่เกิน 1R', true, '(ไม่มีแถวที่เปิดไม้ได้ในรอบนี้ — ข้าม)');
    } else {
      const op = await req('POST', '/api/trades/open', { symbol: cand.symbol, tf: cand.tf });
      const t = op.json?.trade;
      // 1R ต้องเท่ากับ "เงินที่เสียจริงถ้าโดน stop" = (ระยะ stop + ต้นทุน) × จำนวนหุ้น
      // ไม่ใช่ระยะ stop เฉยๆ ไม่งั้นลิมิตขาดทุนรายวันจะปล่อยให้เสียเกินที่ตั้งไว้
      check('B7 · 1R เท่ากับเงินที่เสียจริงเมื่อโดน stop (รวมต้นทุน)',
        t && Number.isFinite(t.initialRiskAmount)
          && Math.abs(t.initialRiskAmount - (t.riskPerShare + t.costPerShare) * t.shares) < 0.01,
        `1R = $${t?.initialRiskAmount?.toFixed(2)} = ${t?.shares} หุ้น × ($${t?.riskPerShare?.toFixed(3)} stop + $${t?.costPerShare?.toFixed(3)} ต้นทุน)`);

      // และต้องใกล้เคียงงบความเสี่ยงที่ตั้งไว้ (ทุน × riskPct) ไม่ใช่ต่ำกว่ามาก
      // ★ ใช้ทุนของตลาดนั้น (หุ้นไทยมีทุนแยกเป็นบาท) · หุ้นไทยปัดลงทีละ 100 หุ้น จึงต่ำกว่างบได้ไม่เกิน 1 lot
      const stNow = (await req('GET', '/api/settings')).json?.settings;
      const isTh = cand.market === 'TH';
      const budget = (isTh ? stNow.thAccountSize : stNow.accountSize) * (stNow.riskPct / 100);
      const lowOk = isTh ? budget - (t?.riskNetPerShare || 0) * 100 : budget * 0.9;
      check('B7 · 1R ใกล้เคียงงบความเสี่ยงที่ตั้งไว้',
        t && t.initialRiskAmount <= budget * 1.02 && t.initialRiskAmount >= lowOk,
        `${cand.symbol}: 1R = ${cand.cur || '$'}${t?.initialRiskAmount?.toFixed(2)} · งบที่ตั้ง = ${cand.cur || '$'}${budget.toFixed(2)}`);
      check('B6 · มีช่อง realizedPnl เป็นเงิน ไม่ใช่สัดส่วนหุ้น',
        t && t.realizedPnl === 0 && Number.isFinite(t.initialShares),
        `realizedPnl=${t?.realizedPnl} initialShares=${t?.initialShares}`);
      await req('POST', `/api/trades/${encodeURIComponent(t.id)}/close`, {});
      await req('DELETE', '/api/trades/closed');
    }
    await req('POST', '/api/settings/reset');
    if (savedWl.length > 0) await req('POST', '/api/watchlist', { tickers: savedWl.join(',') });
  }

  console.log('\n─── v2.1: ค่าเงิน ───');
  {
    const r = await req('GET', '/api/fx');
    check('GET /api/fx ตอบ 200', r.status === 200 && r.json?.ok === true);

    const d = r.json?.data;
    check('ได้เรตและประวัติสถิติครบ',
      !!d && Number.isFinite(d.rate) && d.stats?.windowDays >= 60 && Number.isFinite(d.stats?.percentile),
      d ? `${d.pair}=${d.rate.toFixed(4)} · สถิติ ${d.stats.windowDays} วัน · เปอร์เซ็นไทล์ ${d.stats.percentile.toFixed(0)}` : `error=${r.json?.error}`);

    if (d) {
      const buy = d.directions?.BUY_USD;
      const sell = d.directions?.SELL_USD;
      check('มีคะแนนครบทั้ง 2 ทิศทาง อยู่ในช่วง 0-100',
        buy && sell && buy.score >= 0 && buy.score <= 100 && sell.score >= 0 && sell.score <= 100,
        `ซื้อดอลลาร์ ${buy?.score} · ขายดอลลาร์ ${sell?.score}`);

      // สองทิศทางต้องขัดกัน — เรตถูกสำหรับฝั่งหนึ่งคือเรตแพงสำหรับอีกฝั่ง
      check('คะแนนสองทิศทางสวนทางกันจริง (ไม่ดีพร้อมกันทั้งคู่)',
        !(buy.score >= 70 && sell.score >= 70) && Math.abs((buy.score + sell.score) - 100) < 45,
        `ผลรวม ${(buy.score + sell.score).toFixed(0)} (ควรใกล้ 100)`);

      check('breakdown คะแนนมี 3 ปัจจัย น้ำหนักรวม 100',
        buy.factors?.length === 3 && buy.factors.reduce((a, f) => a + f.weight, 0) === 100,
        buy.factors?.map((f) => `${f.label} ${f.weight}%`).join(' · '));

      // เรตที่ได้จริงต้องแย่กว่าเรตกลางทั้งสองทาง (ส่วนต่างกินทั้งขาซื้อและขาขาย)
      check('เรตหลังหักส่วนต่างแย่กว่าเรตกลางทั้งสองทิศทาง',
        d.effBuyUsd > d.rate && d.effSellUsd < d.rate,
        `กลาง ${d.rate.toFixed(4)} · ซื้อ ${d.effBuyUsd.toFixed(4)} · ขาย ${d.effSellUsd.toFixed(4)} (ส่วนต่าง ${d.spreadPct}%)`);

      check('มีคำเตือนว่าไม่ใช่การพยากรณ์',
        typeof d.disclaimer === 'string' && d.disclaimer.includes('ไม่ใช่การพยากรณ์'));
    }

    // เรตเป้าที่ตั้งเอง: ตั้งให้เข้าเงื่อนไขแน่ๆ แล้วต้องขึ้นธง manualHit
    if (d) {
      await req('PUT', '/api/settings', { fxBuyBelow: Number((d.rate * 1.05).toFixed(4)), fxSellAbove: Number((d.rate * 1.5).toFixed(4)) });
      const r2 = await req('POST', '/api/fx/check', {});
      const buy2 = r2.json?.data?.directions?.BUY_USD;
      check('เรตเป้าที่ตั้งเองทำงาน (ต่ำกว่าเป้า → ขึ้นธง)',
        buy2?.manualHit === true,
        `เป้า ${buy2?.manualTarget?.toFixed(4)} · เรต ${r2.json?.data?.rate?.toFixed(4)}`);

      // ตั้งเป้าที่เป็นไปไม่ได้ → ต้องไม่ขึ้นธง
      await req('PUT', '/api/settings', { fxBuyBelow: Number((d.rate * 0.5).toFixed(4)) });
      const r3 = await req('POST', '/api/fx/check', {});
      check('เรตที่ยังไม่ถึงเป้า → ไม่ขึ้นธง',
        r3.json?.data?.directions?.BUY_USD?.manualHit === false);

      // เป้าที่ขัดกันเอง ต้องได้คำเตือน
      const conflict = await req('PUT', '/api/settings', { fxBuyBelow: 36, fxSellAbove: 33 });
      check('เรตเป้าซื้อ/ขายที่ทับช่วงกันได้คำเตือน',
        (conflict.json?.warnings || []).some((w) => w.includes('ขัดกันเอง')),
        (conflict.json?.warnings || []).find((w) => w.includes('ขัดกันเอง')) || 'ไม่มีคำเตือน');

      const badPair = await req('PUT', '/api/settings', { fxPair: 'USDTHB' });
      const gp = (await req('GET', '/api/settings')).json?.settings;
      check('คู่เงินผิดรูปแบบถูกปฏิเสธ ไม่ทับค่าเดิม',
        gp?.fxPair === 'USD/THB' && (badPair.json?.warnings || []).some((w) => w.includes('คู่เงิน')));

      await req('POST', '/api/settings/reset');
    }

    // ── ★ หลายคู่เงิน ──
    {
      const put = await req('PUT', '/api/fx/pairs', { pairs: ['USD/THB', 'eur/thb', 'EURTHB', 'JPY/THB', 'EUR/THB'] });
      check('เพิ่มหลายคู่เงินได้ · ตัวพิมพ์เล็กแปลงให้ · ตัดคู่ซ้ำและคู่ผิดรูปแบบ',
        put.status === 200 && JSON.stringify(put.json?.pairs) === JSON.stringify(['USD/THB', 'EUR/THB', 'JPY/THB'])
          && (put.json?.warnings || []).some((w) => w.includes('EURTHB')),
        `pairs=${JSON.stringify(put.json?.pairs)}`);

      const eur = await req('POST', '/api/fx/check', { pair: 'EUR/THB' });
      const ed = eur.json?.data;
      check('ตรวจเฉพาะคู่ที่เลือกได้ และป้ายทิศทางเปลี่ยนตามสกุลเงิน',
        ed?.pair === 'EUR/THB' && ed.directions?.BUY_USD?.label === 'แลกบาท → ยูโร'
          && ed.directions?.SELL_USD?.label === 'แลกยูโร → บาท',
        `${ed?.pair} · ${ed?.directions?.BUY_USD?.label} / ${ed?.directions?.SELL_USD?.label}`);

      const all = (await req('GET', '/api/fx')).json;
      check('GET /api/fx คืนทุกคู่ใน byPair · data ยังเป็นของคู่หลัก',
        all?.data?.pair === 'USD/THB' && ['USD/THB', 'EUR/THB', 'JPY/THB'].every((p) => p in (all?.byPair || {}))
          && Array.isArray(all?.currencies) && all.currencies.length > 10,
        `byPair=${Object.keys(all?.byPair || {}).join(', ')}`);

      // เรตเป้าของคู่หนึ่งต้องไม่รั่วไปคู่อื่น
      if (ed) {
        await req('PUT', '/api/settings', { fxTargets: { 'EUR/THB': { buyBelow: Number((ed.rate * 1.05).toFixed(4)) } } });
        const e2 = (await req('POST', '/api/fx/check', { pair: 'EUR/THB' })).json?.data;
        const u2 = (await req('POST', '/api/fx/check', { pair: 'USD/THB' })).json?.data;
        check('เรตเป้าแยกตามคู่: EUR/THB ขึ้นธง แต่ USD/THB ไม่โดนด้วย',
          e2?.directions?.BUY_USD?.manualHit === true && u2?.directions?.BUY_USD?.manualHit === false,
          `EUR manualHit=${e2?.directions?.BUY_USD?.manualHit} · USD manualHit=${u2?.directions?.BUY_USD?.manualHit}`);
      }

      const notWatched = await req('POST', '/api/fx/check', { pair: 'GBP/THB' });
      check('ตรวจคู่ที่ไม่ได้เฝ้าดู → 400', notWatched.status === 400);

      const empty = await req('PUT', '/api/fx/pairs', { pairs: [] });
      check('ลบจนไม่เหลือคู่เงินไม่ได้ (ใช้รายการเดิม)',
        (empty.json?.pairs || []).length === 3 && (empty.json?.warnings || []).some((w) => w.includes('อย่างน้อย 1')));

      const resetOne = await req('POST', '/api/fx/reset', { pair: 'EUR/THB' });
      check('รีเซ็ตการเตือนทีละคู่ได้',
        resetOne.status === 200 && !Object.keys(resetOne.json?.alertState || {}).some((k) => k.startsWith('EUR/THB:')));

      await req('POST', '/api/settings/reset');
      const after = (await req('GET', '/api/fx')).json;
      check('คืนค่าเริ่มต้นแล้วกลับเหลือคู่หลักคู่เดียว', JSON.stringify(after?.pairs) === JSON.stringify(['USD/THB']),
        `pairs=${JSON.stringify(after?.pairs)}`);
    }

    // ── B2/B3/B4: คุณภาพข้อมูลค่าเงิน ──
    if (d) {
      check('B4 · มีช่องบอกว่าช่วงแกว่งแคบเกินไปหรือไม่',
        typeof d.narrowRange === 'boolean' && Number.isFinite(d.rangePct),
        `ช่วงแกว่งทั้งปี ${d.rangePct?.toFixed(2)}% · narrowRange=${d.narrowRange}`);
      check('B3 · มีช่องนับเรตที่เป็น 0/ติดลบที่ถูกตัดทิ้ง',
        Number.isFinite(d.droppedBadRates),
        `ตัดทิ้ง ${d.droppedBadRates} วัน`);
      check('B4 · มี warnings array ให้ UI แสดง', Array.isArray(d.warnings),
        (d.warnings || []).join(' · ').slice(0, 120) || '(ไม่มีคำเตือน)');
      // เปอร์เซ็นไทล์ต้องอยู่ในช่วงที่เป็นไปได้ และสอดคล้องกับตำแหน่งเทียบ low/high
      const atLow = Math.abs(d.rate - d.stats.low) < 1e-9;
      const atHigh = Math.abs(d.rate - d.stats.high) < 1e-9;
      check('B2 · เปอร์เซ็นไทล์สอดคล้องกับตำแหน่งจริงเทียบจุดต่ำสุด/สูงสุด',
        d.stats.percentile >= 0 && d.stats.percentile <= 100
          && (!atLow || d.stats.percentile < 50) && (!atHigh || d.stats.percentile > 50),
        `pct=${d.stats.percentile.toFixed(1)} · เรต ${d.rate.toFixed(4)} · ช่วง ${d.stats.low.toFixed(4)}-${d.stats.high.toFixed(4)}`);
    }

    const hist = await req('GET', '/api/fx/history');
    check('GET /api/fx/history ตอบ 200 และคืน array',
      hist.status === 200 && Array.isArray(hist.json?.history));

    const reset = await req('POST', '/api/fx/reset', {});
    check('POST /api/fx/reset สำเร็จ', reset.status === 200 && reset.json?.ok === true);
  }

  console.log('\n─── ★ กฎแจ้งเตือนจากแดชบอร์ด ───');
  {
    const bad = await req('PUT', '/api/alert-rules', { scoreAlertMin: 150, scoreAlertScope: 'everything', minPrice: 999 });
    const g1 = (await req('GET', '/api/settings')).json?.settings || {};
    check('กฎแจ้งเตือน: คะแนนเกิน 100 ถูกปรับ · ขอบเขตผิดถูกปฏิเสธ · ฟิลด์อื่นนอกกฎไม่ถูกแก้',
      g1.scoreAlertMin === 100 && g1.scoreAlertScope === 'all' && g1.minPrice !== 999
        && (bad.json?.warnings || []).length >= 2,
      `min=${g1.scoreAlertMin} scope=${g1.scoreAlertScope} minPrice=${g1.minPrice}`);

    // เปิดกฎแบบกว้างสุด แล้วสแกน → ต้องมีหุ้นเข้าเกณฑ์ และสแกนซ้ำต้องไม่เตือนตัวเดิมอีกในวันเดียวกัน
    await req('POST', '/api/score-alerts/reset');
    await req('PUT', '/api/alert-rules', {
      scoreAlertEnabled: true, scoreAlertMin: 0, scoreAlertRequirePassed: false, scoreAlertScope: 'all', scoreAlertLine: false,
    });
    await req('POST', '/api/scanner/scan-now');
    const s1 = (await req('GET', '/api/score-alerts')).json;
    const alerted = Object.keys(s1?.state || {});
    check('คะแนนถึงเกณฑ์ → บันทึกการแจ้งเตือน (รวมทั้งรอบเป็นรายการเดียว)',
      alerted.length > 0 && s1?.history?.[0]?.hits?.length === alerted.length,
      `เตือน ${alerted.length} ตัว: ${alerted.slice(0, 6).join(', ')}`);

    await req('POST', '/api/scanner/scan-now');
    const s2 = (await req('GET', '/api/score-alerts')).json;
    check('สแกนซ้ำวันเดียวกัน → ไม่เตือนตัวเดิมซ้ำ',
      (s2?.history || []).length === (s1?.history || []).length,
      `ประวัติ ${s1?.history?.length} → ${s2?.history?.length} รายการ`);

    const rs = await req('POST', '/api/score-alerts/reset');
    check('ล้างสถานะแจ้งเตือนคะแนนได้', rs.json?.ok === true && rs.json?.count === alerted.length, `ล้าง ${rs.json?.count} ตัว`);

    // ปิดกฎ → สแกนแล้วต้องไม่มีการเตือนเพิ่ม
    await req('PUT', '/api/alert-rules', { scoreAlertEnabled: false });
    await req('POST', '/api/scanner/scan-now');
    const s3 = (await req('GET', '/api/score-alerts')).json;
    check('ปิดกฎแล้วไม่เตือน', Object.keys(s3?.state || {}).length === 0);

    await req('POST', '/api/settings/reset');
  }

  console.log('\n─── v2: ค่าตั้งค่าใหม่ต้องบันทึกได้และ validate จริง ───');
  {
    const r = await req('PUT', '/api/settings', {
      minStopPct: 0.75, costPct: 0.08, tradeAtrBasis: 'daily', stopAtrDaily: 0.4,
      entryMode: 'confirm', requireTrendTemplate: true, minTrendChecks: 5,
      trackTrades: true, tp1R: 1.2, trailAtrMult: 2.5, exitAtTarget: false,
    });
    const g = (await req('GET', '/api/settings')).json?.settings || {};
    check('บันทึกค่าคณิตศาสตร์ความเสี่ยงแบบ v2 ได้',
      g.minStopPct === 0.75 && g.costPct === 0.08 && g.stopAtrDaily === 0.4,
      `minStopPct=${g.minStopPct} costPct=${g.costPct} stopAtrDaily=${g.stopAtrDaily}`);
    check('บันทึกค่า boolean ของระบบคุมไม้ได้ (ไม่กลายเป็นสตริง)',
      g.trackTrades === true && g.exitAtTarget === false,
      `trackTrades=${JSON.stringify(g.trackTrades)} exitAtTarget=${JSON.stringify(g.exitAtTarget)}`);

    const bad = await req('PUT', '/api/settings', { entryMode: 'ไม่มีโหมดนี้', tradeAtrBasis: 'weekly', minStopPct: 999 });
    const g2 = (await req('GET', '/api/settings')).json?.settings || {};
    check('ค่าที่ไม่รู้จักถูกปฏิเสธและคืนคำเตือน ไม่ทับค่าเดิม',
      g2.entryMode === 'confirm' && g2.tradeAtrBasis === 'daily' && g2.minStopPct <= 20
        && (bad.json?.warnings || []).length >= 3,
      `entryMode=${g2.entryMode} basis=${g2.tradeAtrBasis} minStopPct=${g2.minStopPct} · คำเตือน ${(bad.json?.warnings || []).length} ข้อ`);
    await req('POST', '/api/settings/reset');
  }

  console.log('\n─── v2: วงจรชีวิตไม้ผ่าน REST API ───');
  {
    await req('POST', '/api/scanner/scan-now');
    const allRows = (await req('GET', '/api/rows')).json?.rows || [];
    const tradable = allRows.find((r) => r.passed && (r.position?.shares || 0) > 0);

    if (!tradable) {
      check('เปิดไม้จากแถวที่ผ่านด่านได้', true, '(รอบนี้ไม่มีแถวที่ผ่านด่าน — ข้ามการตรวจ)');
    } else {
      const open = await req('POST', '/api/trades/open', { symbol: tradable.symbol, tf: tradable.tf });
      check('เปิดไม้จากแถวที่ผ่านด่านได้',
        open.status === 200 && open.json?.ok === true,
        `${tradable.symbol} ${tradable.tf} · ${open.json?.trade?.shares} หุ้น · 1R=$${open.json?.trade?.riskPerShare?.toFixed(3)}`);

      const t = open.json?.trade;
      check('ไม้ที่เปิดมี 1R เป็นเงินจริงและ stop ตรงกับแผน',
        t && t.riskPerShare > 0 && Math.abs((t.entry - t.stop) - t.riskPerShare) < 1e-6,
        `entry=${t?.entry?.toFixed(2)} stop=${t?.stop?.toFixed(2)} 1R=$${t?.riskPerShare?.toFixed(3)}`);

      const dup = await req('POST', '/api/trades/open', { symbol: tradable.symbol, tf: tradable.tf });
      check('เปิดไม้ซ้ำหุ้นเดิมไม่ได้', dup.status === 400 && dup.json?.ok === false, dup.json?.error || '');

      const list = await req('GET', '/api/trades');
      check('GET /api/trades คืนไม้ที่เปิดอยู่',
        list.status === 200 && (list.json?.open || []).length === 1,
        `open=${(list.json?.open || []).length} · ลิมิต ${list.json?.limits?.maxOpenTrades} ไม้`);

      const closed = await req('POST', `/api/trades/${encodeURIComponent(t.id)}/close`, {});
      check('ปิดไม้เองได้และบันทึกผลเป็น R',
        closed.status === 200 && closed.json?.ok === true && Number.isFinite(closed.json?.trade?.totalR),
        `${closed.json?.trade?.exitLabel} · ${closed.json?.trade?.totalR?.toFixed(2)}R`);

      const after = (await req('GET', '/api/trades')).json;
      check('ปิดแล้วหายจากรายการไม้ที่เปิดอยู่ และเข้าไปอยู่ในประวัติ',
        (after?.open || []).length === 0 && (after?.closed || []).length >= 1,
        `open=${(after?.open || []).length} closed=${(after?.closed || []).length}`);

      await req('DELETE', '/api/trades/closed');
    }

    const bogus = await req('POST', '/api/trades/open', { symbol: 'ZZNOTREAL' });
    check('เปิดไม้จากหุ้นที่ไม่มีในผลสแกน → 404 ไม่ crash',
      bogus.status === 404 && bogus.json?.ok === false, bogus.json?.error || '');
  }

  console.log('\n─── regression v2: hot-poll timer ต้องถูกเก็บเมื่อกด Stop ───');
  {
    await req('POST', '/api/scanner/start');
    await sleep(400);
    const onState = (await req('GET', '/api/status')).json;
    check('ขณะลูปทำงาน hot-poll ถูกตั้ง timer ไว้',
      onState?.hotPolling === true,
      `hotPolling=${onState?.hotPolling} · ทุก ${onState?.hotPollSec} วินาที`);

    await req('POST', '/api/scanner/stop');
    const offState = (await req('GET', '/api/status')).json;
    check('กด Stop แล้ว hot-poll timer ถูกเก็บทันที', offState?.hotPolling === false,
      `hotPolling=${offState?.hotPolling}`);

    // รอให้ยาวกว่าช่วง hot-poll หนึ่งรอบ แล้วยืนยันว่าไม่มีอะไรฟื้นขึ้นมาเอง
    const waitSec = Math.min(8, (onState?.hotPollSec || 20));
    await sleep(waitSec * 1000 + 500);
    const after = (await req('GET', '/api/status')).json;
    check('รอเกินหนึ่งรอบ hot-poll แล้วยังไม่มี timer ฟื้นขึ้นมาเอง',
      after?.hotPolling === false && after?.running === false,
      `รอ ${waitSec}s · hotPolling=${after?.hotPolling} · running=${after?.running}`);
  }

  console.log('\n─── regression v2: สแกนแบบขนานต้องได้แถวครบเท่าเดิม ───');
  {
    await req('PUT', '/api/settings', { scanConcurrency: 1 });
    await req('POST', '/api/scanner/scan-now');
    const serialRows = ((await req('GET', '/api/rows')).json?.rows || []).length;

    await req('PUT', '/api/settings', { scanConcurrency: 6 });
    await req('POST', '/api/scanner/scan-now');
    const parallelRows = ((await req('GET', '/api/rows')).json?.rows || []).length;

    check('สแกนขนาน 6 ตัวได้จำนวนแถวเท่ากับสแกนทีละตัว',
      serialRows > 0 && serialRows === parallelRows,
      `ทีละตัว ${serialRows} แถว · ขนาน ${parallelRows} แถว`);
    await req('POST', '/api/settings/reset');
  }

  console.log('\n─── regression: ด่านมูลค่าซื้อขายต้องใช้ tfMinutes จริง (ไม่ hard-code 5 นาที) ───');
  {
    await req('PUT', '/api/settings', { timeframes: ['5m', '15m'], sentimentTopN: 0 });
    await req('POST', '/api/scanner/scan-now');
    const rowsTf = (await req('GET', '/api/status')).json?.rows || [];

    // จับหุ้นที่มีทั้งแถว 5m และ 15m แล้วเทียบข้อความด่านมูลค่าซื้อขาย
    const bySymbol = new Map();
    for (const r of rowsTf) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, {});
      bySymbol.get(r.symbol)[r.tf] = r;
    }
    const pair = [...bySymbol.values()].find((x) => x['5m'] && x['15m']);

    if (pair) {
      const dvFail = (r) => (r.failReasons || []).some((x) => x.includes('มูลค่าซื้อขาย'));
      // ทั้งสอง timeframe ควรตัดสินด่านมูลค่าซื้อขายเหมือนกัน เพราะเทียบเป็น "ต่อ 5 นาที" ทั้งคู่
      check('แถว 5m และ 15m ของหุ้นเดียวกันตัดสินด่านมูลค่าซื้อขายตรงกัน',
        dvFail(pair['5m']) === dvFail(pair['15m']),
        `${pair['5m'].symbol}: 5m=${dvFail(pair['5m']) ? 'ตก' : 'ผ่าน'} · 15m=${dvFail(pair['15m']) ? 'ตก' : 'ผ่าน'}`);
    } else {
      check('แถว 5m และ 15m ของหุ้นเดียวกันตัดสินด่านมูลค่าซื้อขายตรงกัน', false, 'ไม่พบหุ้นที่มีทั้ง 2 timeframe');
    }
    await req('PUT', '/api/settings', { timeframes: ['5m'] });
  }

  console.log('\n─── regression: แถวที่ตก R:R ต้องไม่โชว์ขนาดไม้ ───');
  {
    await req('POST', '/api/scanner/scan-now');
    const rowsRR = (await req('GET', '/api/status')).json?.rows || [];
    const failedRR = rowsRR.filter((r) => (r.failReasons || []).some((x) => x.includes('R:R')));
    if (failedRR.length > 0) {
      check('แถวที่ R:R ต่ำกว่าเกณฑ์ มีขนาดไม้เป็น 0',
        failedRR.every((r) => (r.position?.shares || 0) === 0),
        `${failedRR.length} แถวที่ตก R:R · ขนาดไม้: ${failedRR.map((r) => r.position?.shares).join(',')}`);
    } else {
      check('แถวที่ R:R ต่ำกว่าเกณฑ์ มีขนาดไม้เป็น 0', true, '(รอบนี้ไม่มีแถวที่ตก R:R — ข้ามการตรวจ)');
    }

    // เหตุผลตกด่านต้องถูกรายงานใน summary.topRejects (เดิมรายงานแต่ข้อความ crash)
    const summ = (await req('GET', '/api/rows')).json?.summary;
    const anyFailed = rowsRR.some((r) => !r.passed);
    if (anyFailed) {
      check('summary.topRejects รายงานเหตุผลตกด่านจริง (ไม่ใช่แค่ข้อความ error)',
        (summ?.topRejects || []).length > 0,
        (summ?.topRejects || []).map((t) => `${t.why}(${t.count})`).join(' · ') || 'ว่างเปล่า');
    }
  }

  // ---------- ลบ ticker ----------
  console.log('\n─── เพิ่มเติม: ลบ ticker ───');
  const del = await req('DELETE', '/api/watchlist/TSLA');
  check('DELETE /api/watchlist/:symbol สำเร็จ', del.status === 200 && del.json?.ok === true);
  await sleep(300);
  const wl3 = JSON.parse(await fsp.readFile(wlPath, 'utf8'));
  check('ticker ถูกลบออกจากไฟล์จริง', !wl3.map((x) => x.symbol).includes('TSLA'),
    `เหลือ: [${wl3.map((x) => x.symbol).join(', ')}]`);

  const delMissing = await req('DELETE', '/api/watchlist/NOTEXIST');
  check('ลบ ticker ที่ไม่มี → ตอบ 404 ไม่ crash', delMissing.status === 404, `status=${delMissing.status}`);

  // ---------- Settings ----------
  console.log('\n─── เพิ่มเติม: Settings ───');
  const getSet = await req('GET', '/api/settings');
  check('GET /api/settings ตอบ 200', getSet.status === 200);
  check('API key ถูก mask ไม่ส่งค่าเต็มกลับมา',
    Object.values(getSet.json?.settings?.apiKeys || {}).every((v) => v === '' || String(v).startsWith('••••')),
    JSON.stringify(getSet.json?.settings?.apiKeys));
  check('มี session ให้เลือกครบ 4 แบบ (regular/pre/post/all)',
    (getSet.json?.sessions || []).length === 4,
    (getSet.json?.sessions || []).map((s) => s.value).join(', '));

  const putSet = await req('PUT', '/api/settings', { accountSize: 25000, riskPct: 2 });
  check('PUT /api/settings บันทึกได้', putSet.status === 200 && putSet.json?.settings?.accountSize === 25000,
    `accountSize=${putSet.json?.settings?.accountSize}`);

  // ค่าที่ผิดต้องถูกปรับให้อยู่ในช่วงที่ใช้งานได้ พร้อมคำเตือน
  const badSet = await req('PUT', '/api/settings', { scanIntervalSec: 1, riskPct: 999 });
  check('ค่าที่ผิดถูกปรับให้อยู่ในช่วงที่ใช้ได้ + มีคำเตือน',
    (badSet.json?.warnings || []).length > 0 && badSet.json?.settings?.scanIntervalSec >= 10,
    `scanIntervalSec=${badSet.json?.settings?.scanIntervalSec} warnings=${(badSet.json?.warnings || []).length}`);

  // น้ำหนักที่รวมไม่ถึง 100 ต้องถูก normalize
  const wSet = await req('PUT', '/api/settings', { weights: { rvol: 50, volatility: 50, resistance: 50, momentum: 50, sentiment: 50, liquidity: 50 } });
  const wSum = Object.values(wSet.json?.settings?.weights || {}).reduce((a, b) => a + b, 0);
  check('น้ำหนักคะแนนถูกปรับให้รวมได้ 100', Math.abs(wSum - 100) < 0.5, `รวม=${wSum}`);

  await req('POST', '/api/settings/reset'); // คืนค่าเริ่มต้น

  // ---------- Providers ----------
  console.log('\n─── เพิ่มเติม: สถานะ provider + ลำดับ fallback ───');
  const prov = await req('GET', '/api/providers');
  check('GET /api/providers ตอบ 200', prov.status === 200);
  check('รายงานสถานะ provider ทุกตัว', (prov.json?.providers || []).length >= 6,
    `${(prov.json?.providers || []).length} provider`);
  check('provider ที่ไม่มี key ถูกทำเครื่องหมาย disabled (ไม่ crash)',
    (prov.json?.providers || []).some((p) => p.status === 'disabled' || p.configured),
    (prov.json?.providers || []).map((p) => `${p.id}=${p.status}`).join(' '));
  check('bars ไม่ใช้ Finnhub (free tier ไม่ให้แท่งเทียน)',
    !(prov.json?.chains?.bars || []).includes('finnhub'),
    `bars: ${(prov.json?.chains?.bars || []).join(' → ')}`);

  // ---------- ★ หุ้นไทย (SET) ----------
  console.log('\n─── ★ หุ้นไทย (SET) ───');
  {
    const mk = await import('../src/markets.js');
    const mh = await import('../src/market-hours.js');
    const ind = await import('../indicators.js');
    const sc = await import('../src/scoring.js');
    const pv = await import('../src/providers/index.js');

    check('แยกตลาดจากสัญลักษณ์ได้ (PTT.BK / ^SET.BK = ไทย · NVDA = อเมริกา)',
      mk.marketOf('PTT.BK') === 'TH' && mk.marketOf('^SET.BK') === 'TH' && mk.marketOf('NVDA') === 'US' && mk.marketOf('ptt.bk') === 'TH');

    const ticks = [[1.5, 0.01], [3, 0.02], [7, 0.05], [20, 0.1], [41.25, 0.25], [150, 0.5], [257, 1], [500, 2]];
    check('ช่องราคา (tick) ตามตาราง SET ถูกทุกระดับราคา',
      ticks.every(([p, t]) => Math.abs(mk.setTickSize(p) - t) < 1e-9) && mk.tickSize(41.25, 'US') === 0.01,
      ticks.map(([p]) => `${p}→${mk.setTickSize(p)}`).join(' '));

    // เวลาทำการ (ต.ค. 2026 นิวยอร์กยังเป็นเวลาฤดูร้อน UTC-4 · ไทย UTC+7)
    const at = (iso) => new Date(iso);
    const mon1030 = mh.thaiMarketStatus(at('2026-10-05T03:30:00Z'), { dataDelayMin: 30 });
    check('จันทร์ 10:30 น. เวลาไทย = ตลาดไทยเปิด (ช่วงเช้า)',
      mon1030.open && mon1030.actualPhase === 'morning', `${mon1030.localTime} ${mon1030.actualPhaseLabel}`);
    const usSameMoment = mh.marketStatus('regular', at('2026-10-05T03:30:00Z'));
    check('เวลาเดียวกันนั้นที่นิวยอร์กคือคืนวันอาทิตย์ — เหตุผลที่ต้องใช้นาฬิกาแยก',
      usSameMoment.isWeekend === true, `นิวยอร์ก ${usSameMoment.nyDate} ${usSameMoment.nyTime}`);
    const lunch1245 = mh.thaiMarketStatus(at('2026-10-05T05:45:00Z'), { dataDelayMin: 30 });
    check('12:45 น. = พักเที่ยง แต่ยังสแกนต่อเพราะข้อมูลช้า 30 นาที',
      !lunch1245.open && lunch1245.actualPhase === 'lunch' && lunch1245.scanOpen && lunch1245.inDelayTail,
      lunch1245.reason);
    const lunch1330 = mh.thaiMarketStatus(at('2026-10-05T06:30:00Z'), { dataDelayMin: 30 });
    check('13:30 น. = พักเที่ยง และหยุดสแกน', !lunch1330.open && !lunch1330.scanOpen && lunch1330.nextChangeMin === 60,
      `${lunch1330.nextChangeLabel}`);
    const aft = mh.thaiMarketStatus(at('2026-10-05T08:00:00Z'), { dataDelayMin: 30 });
    check('15:00 น. = ช่วงบ่าย เปิด', aft.open && aft.actualPhase === 'afternoon');
    const sat = mh.thaiMarketStatus(at('2026-10-03T03:30:00Z'));
    const hol = mh.thaiMarketStatus(at('2026-10-13T03:30:00Z'));
    check('วันเสาร์และวันหยุดตลาดไทย (13 ต.ค.) = ปิด', !sat.open && sat.isWeekend && !hol.open && hol.isHoliday,
      `${sat.reason} · ${hol.reason}`);

    // วันทำการสำหรับกฎ "เตือนวันละครั้ง"
    const k1 = mh.marketDateKey('TH', at('2026-10-05T03:30:00Z')); // 10:30 ไทย
    const k2 = mh.marketDateKey('TH', at('2026-10-05T06:30:00Z')); // 13:30 ไทย
    const u1 = mh.marketDateKey('US', at('2026-10-05T03:30:00Z'));
    const u2 = mh.marketDateKey('US', at('2026-10-05T06:30:00Z'));
    check('วันทำการของหุ้นไทยไม่เปลี่ยนกลางวัน (วันที่นิวยอร์กเปลี่ยนตอน 11:00 น. เวลาไทย)',
      k1 === k2 && k1 === '2026-10-05' && u1 !== u2, `ไทย ${k1}/${k2} · นิวยอร์ก ${u1}/${u2}`);

    // VWAP ต้อง reset ตามวันของตลาดไทย ไม่ใช่เที่ยงคืนนิวยอร์ก
    const vb = Array.from({ length: 24 }, (_, i) => {
      const px = 40 + i * 0.25;
      return { date: new Date(Date.parse('2026-10-05T03:00:00Z') + i * 300_000), open: px, high: px, low: px, close: px, volume: 1000 };
    });
    const vNy = ind.sessionVwap(vb);
    const vTh = ind.sessionVwap(vb, 'Asia/Bangkok');
    check('VWAP ของหุ้นไทยต่อเนื่องทั้งช่วงเช้า (ถ้าใช้เวลานิวยอร์กจะ reset ตอน 11:00 น.)',
      Math.abs(vNy[12] - vb[12].close) < 1e-9 && vTh[12] < vb[12].close - 1,
      `แท่ง 11:00 น.: ใช้เวลานิวยอร์ก ${vNy[12].toFixed(2)} · ใช้เวลาไทย ${vTh[12].toFixed(2)}`);

    // ขนาดไม้ทีละ 100 หุ้น
    const ps = sc.positionSize({ accountSize: 300_000, riskPct: 1, riskPerShare: 0.7, sizeMult: 1, price: 40, lotSize: 100 });
    const psUs = sc.positionSize({ accountSize: 300_000, riskPct: 1, riskPerShare: 0.7, sizeMult: 1, price: 40 });
    check('ขนาดไม้หุ้นไทยปัดลงเป็นทวีคูณของ 100 หุ้น (หุ้นอเมริกาเหมือนเดิม)',
      ps.shares === 4200 && psUs.shares === 4285, `ไทย ${ps.shares} · อเมริกา ${psUs.shares}`);

    check('แปลง $ เป็น ฿ เฉพาะจำนวนเงิน',
      mk.localizeText('เป้า $41.50 · ทุน $300,000 · ใช้ $ ได้', '฿') === 'เป้า ฿41.50 · ทุน ฿300,000 · ใช้ $ ได้');

    // ตัดแท่งพักเที่ยงและแท่งเปล่า (ดัชนีไม่มีวอลุ่ม ต้องไม่ถูกตัดทิ้งหมด)
    const mkBar = (hhmmBkk, volume) => {
      const [h, m] = hhmmBkk.split(':').map(Number);
      return { date: new Date(Date.UTC(2026, 9, 5, h - 7, m)), open: 1, high: 1, low: 1, close: 1, volume };
    };
    const raw = [mkBar('10:00', 500), mkBar('12:25', 300), mkBar('12:30', 0), mkBar('13:30', 0), mkBar('14:30', 800), mkBar('15:00', 0), mkBar('16:25', 900)];
    const kept = pv._filterThaiSessionBars(raw, 'PTT.BK').map((b) => b.volume);
    const keptIdx = pv._filterThaiSessionBars(raw.map((b) => ({ ...b, volume: 0 })), '^SET.BK').length;
    check('ตัดแท่งพักเที่ยงและแท่งที่ไม่มีวอลุ่มของหุ้นไทยทิ้ง',
      // หุ้น: เหลือ 10:00 12:25 14:30 16:25 · ดัชนี (ไม่มีวอลุ่มทุกแท่ง): เหลือทุกแท่งในเวลาทำการ 5 แท่ง
      JSON.stringify(kept) === JSON.stringify([500, 300, 800, 900]) && keptIdx === 5,
      `เหลือ ${kept.length} แท่ง · ดัชนีเหลือ ${keptIdx} แท่ง`);

    // ตั้งค่า
    const sv = await req('PUT', '/api/settings', { thUniverse: 'ptt, DELTA.BK, bad!!, PTT', thMaxSpreadTicks: 0 });
    check('รายชื่อหุ้นไทย: ตัด .BK ตัดตัวซ้ำ ข้ามตัวที่ผิดรูปแบบ',
      JSON.stringify(sv.json?.settings?.thUniverse) === '["PTT","DELTA"]' && (sv.json?.warnings || []).some((w) => w.includes('BAD!!')),
      `${JSON.stringify(sv.json?.settings?.thUniverse)} · ${(sv.json?.warnings || []).join(' | ').slice(0, 120)}`);
    check('spread หุ้นไทยต่ำกว่า 1 ช่องราคา ถูกปรับเป็น 1', sv.json?.settings?.thMaxSpreadTicks === 1);

    // สแกนหุ้นไทยจริง (ข้อมูลจำลอง) — ปิดหุ้นอเมริกาชั่วคราวให้เห็นผลชัด
    const savedWl = ((await req('GET', '/api/watchlist')).json?.items || []).map((w) => w.symbol);
    await req('DELETE', '/api/watchlist');
    await req('PUT', '/api/settings', { usEnabled: false, thEnabled: true, thUseUniverse: true, thUniverse: ['PTT', 'DELTA', 'KBANK'] });
    const addTh = await req('POST', '/api/watchlist', { tickers: 'AOT.BK' });
    check('เพิ่มหุ้นไทย AOT.BK เข้ารายการเฝ้าดูได้', (addTh.json?.results || []).some((x) => x.ok && x.symbol === 'AOT.BK'),
      JSON.stringify(addTh.json?.results || []).slice(0, 120));
    await req('POST', '/api/scanner/scan-now');
    const thRes = (await req('GET', '/api/rows')).json || {};
    const thRows = thRes.rows || [];
    const syms = [...new Set(thRows.map((r) => r.symbol))].sort();
    check('สแกนเฉพาะหุ้นไทย: รายชื่อตั้งต้น + รายการเฝ้าดู', JSON.stringify(syms) === '["AOT.BK","DELTA.BK","KBANK.BK","PTT.BK"]',
      syms.join(', '));
    check('แถวหุ้นไทยระบุตลาด/สกุลเงิน (TH / THB / ฿)',
      thRows.length > 0 && thRows.every((r) => r.market === 'TH' && r.currency === 'THB' && r.cur === '฿'));
    check('ขนาดไม้ของทุกแถวเป็นทวีคูณของ 100 หุ้น',
      thRows.every((r) => ((r.position?.shares || 0) % 100) === 0),
      thRows.map((r) => r.position?.shares || 0).slice(0, 8).join(', '));
    const moneyDollar = thRows.filter((r) => /\$[\d(.\-]/.test(JSON.stringify(r)));
    check('ข้อความในแถวหุ้นไทยใช้ ฿ ไม่มี $ หลงเหลือ', moneyDollar.length === 0,
      moneyDollar.length ? `${moneyDollar[0].symbol}: ${JSON.stringify(moneyDollar[0]).match(/.{0,40}\$[\d(.\-].{0,20}/)?.[0]}` : '');
    const withAuto = thRows.filter((r) => r.alertMode === 'confirm' && Number.isFinite(r.alertTarget) && r.resistance?.level);
    check('ระดับยืนยันเบรกของหุ้นไทยห่างแนวต้านอย่างน้อย 1 ช่องราคา',
      withAuto.every((r) => r.alertTarget - r.resistance.level >= r.tick * 0.999),
      withAuto.slice(0, 3).map((r) => `${r.symbol} แนวต้าน ${r.resistance.level.toFixed(2)} → ${r.alertTarget.toFixed(2)} (tick ${r.tick})`).join(' · ') || '(ไม่มีแถวโหมดยืนยัน)');
    check('ภาวะตลาดไทยประเมินจากดัชนี SET/SET50', !!thRes.summary?.regimes?.TH?.regime && (thRes.summary?.marketsScanned || []).join() === 'TH',
      `TH=${thRes.summary?.regimes?.TH?.regime} · scanned=${(thRes.summary?.marketsScanned || []).join()}`);
    const stTh = (await req('GET', '/api/status')).json || {};
    check('สถานะมีทั้งตลาดอเมริกาและตลาดไทย', !!stTh.markets?.US && !!stTh.markets?.TH && stTh.markets.TH.tzLabel === 'ไทย',
      `ไทย: ${stTh.markets?.TH?.actualPhaseLabel} ${stTh.markets?.TH?.localTime}`);

    // เปิดหุ้นอเมริกากลับ → ผลหุ้นไทยต้องยังอยู่คู่กัน
    await req('PUT', '/api/settings', { usEnabled: true });
    await req('POST', '/api/watchlist', { tickers: 'NVDA' });
    await req('POST', '/api/scanner/scan-now');
    const both = (await req('GET', '/api/rows')).json?.rows || [];
    check('สแกนสองตลาดพร้อมกันได้ (ตั้งให้สแกนตอนตลาดปิด)', both.some((r) => r.market === 'TH') && both.some((r) => r.market === 'US'),
      `ไทย ${both.filter((r) => r.market === 'TH').length} แถว · อเมริกา ${both.filter((r) => r.market === 'US').length} แถว`);

    await req('DELETE', '/api/watchlist');
    if (savedWl.length) await req('POST', '/api/watchlist', { tickers: savedWl.join(',') });
    await req('POST', '/api/settings/reset');
  }

  // ---------- Backtest ----------
  console.log('\n─── เพิ่มเติม: Backtest ───');
  const bt = await req('GET', '/api/backtest?window=60');
  check('GET /api/backtest ตอบ 200', bt.status === 200, `status=${bt.status}`);
  check('backtest คืนโครงสร้างครบ (overall + drawdown + byScoreBucket)',
    bt.json?.overall != null && bt.json?.drawdown != null && Array.isArray(bt.json?.byScoreBucket));
  check('backtest มี max drawdown', 'maxDrawdownR' in (bt.json?.drawdown || {}),
    `maxDrawdownR=${bt.json?.drawdown?.maxDrawdownR}`);
  check('backtest ระบุข้อจำกัดของการทดสอบ', (bt.json?.limitations || []).length >= 3,
    `${(bt.json?.limitations || []).length} ข้อ`);

  // ---------- หน้าเว็บ ----------
  console.log('\n─── เพิ่มเติม: หน้าเว็บโหลดได้ ───');
  for (const [p, name] of [['/', 'แดชบอร์ด'], ['/settings', 'Settings'], ['/backtest', 'Backtest'], ['/app.js', 'app.js']]) {
    const res = await fetch(`${BASE}${p}`);
    const body = await res.text();
    check(`GET ${p} (${name}) โหลดได้`, res.ok && body.length > 500, `${res.status}, ${body.length} bytes`);
  }

  // ---------- error handling ----------
  console.log('\n─── เพิ่มเติม: error handling (server ต้องไม่ crash) ───');
  const notFound = await req('GET', '/api/ไม่มีจริง');
  check('API ที่ไม่มี → ตอบ 404 ไม่ crash', notFound.status === 404, `status=${notFound.status}`);

  const badBody = await fetch(`${BASE}/api/watchlist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ไม่ใช่ JSON',
  });
  check('body ที่ไม่ใช่ JSON → ไม่ทำให้ server ตาย', badBody.status >= 400 && badBody.status < 500,
    `status=${badBody.status}`);

  const stillAlive = await req('GET', '/api/status');
  check('server ยังทำงานอยู่หลังเจอ request ที่ผิดรูปแบบ', stillAlive.status === 200);

  finish();
}

function finish() {
  const total = passed + failed;
  const pct = total > 0 ? ((passed / total) * 100).toFixed(1) : '0';

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  ผลการทดสอบ: ✅ ผ่าน ${passed} · ❌ ไม่ผ่าน ${failed} · รวม ${total} ข้อ (${pct}%)`);
  console.log('═══════════════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\nข้อที่ไม่ผ่าน:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  ❌ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }
  console.log('');

  restoreData()
    .catch((err) => console.error('คืนไฟล์ data ไม่สำเร็จ:', err.message))
    .finally(() => process.exit(failed > 0 ? 1 : 0));
}

main().catch(async (err) => {
  console.error('\n❌ smoke test ล้มเหลว:', err.message);
  console.error(err.stack);
  await restoreData().catch(() => {});
  process.exit(1);
});
