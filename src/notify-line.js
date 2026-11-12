// src/notify-line.js — ส่งแจ้งเตือนเข้า LINE (ช่องเสริม)
//
// ห่อ line.js เดิมไว้ เพื่อให้ web layer เรียกได้โดยไม่ต้องพึ่ง config.js
// (line.js เดิมอ่าน token จาก CFG ซึ่งมาจาก .env เท่านั้น
//  ไฟล์นี้ให้ใช้ token จาก settings ที่แก้ผ่านหน้าเว็บได้ด้วย)
//
// เปิด/ปิดได้ในหน้า Settings — ถ้าปิด (default) จะไม่ยิงอะไรเลย

import { settings } from './settings.js';
import { log } from './logbus.js';
import { fmtRate } from './fx.js';
import { marketInfo, localizeText } from './markets.js'; // ★ หุ้นไทยแสดงเป็น ฿

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

export function isLineConfigured() {
  const st = settings.all;
  return !!(st.lineToken && st.lineTarget);
}

// เวลาไทยแบบอ่านง่าย
function thTime(d = new Date()) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

// ---------- สร้างข้อความแจ้งเตือน ----------
// ใช้ข้อความธรรมดา (ไม่ใช่ Flex) เพื่อความเรียบง่ายและไม่พังถ้าโครงสร้าง Flex เปลี่ยน
// ⚠️ ถ้อยคำ: บอกข้อเท็จจริง ไม่รับประกันผล และมี disclaimer
function buildAlertText(payload) {
  const row = payload.row || {};
  const lines = [
    `🔔 ${payload.symbol} แตะจุดแจ้งเตือนแล้ว`,
    '',
    `ราคาล่าสุด : $${Number(payload.price).toFixed(2)}`,
    `จุดแจ้งเตือน: $${Number(payload.target).toFixed(2)} (${payload.label})`,
  ];

  if (Number.isFinite(payload.resistanceLevel)) {
    lines.push(`แนวต้าน    : $${Number(payload.resistanceLevel).toFixed(2)}`);
  }
  if (Number.isFinite(row.score)) {
    lines.push(`คะแนนโอกาส : ${row.score}/100`);
  }
  if (row.rr?.ok) {
    lines.push(`R:R        : ${row.rr.label} (stop $${row.rr.stop.toFixed(2)})`);
  }
  if (row.position?.shares > 0) {
    lines.push(`ขนาดไม้    : ${row.position.shares} หุ้น`);
  }
  if (row.expectedMove?.pct) {
    lines.push(`Expected Move: ${row.expectedMove.label} (จากค่าสถิติ ATR)`);
  }

  // เหตุผล — "ทุกสัญญาณต้องบอกทำไม" (สเปกข้อ 6)
  if (Array.isArray(row.topReasons) && row.topReasons.length > 0) {
    lines.push('', 'เหตุผล:');
    for (const r of row.topReasons.slice(0, 3)) lines.push(`• ${r}`);
  }

  lines.push('', `เวลา ${thTime()} (ไทย)`);
  lines.push('— เครื่องมือช่วยคัดกรอง ไม่ใช่คำแนะนำการลงทุน —');

  return localizeText(lines.join('\n'), marketInfo(payload.symbol).cur); // ★ หุ้นไทย: $ → ฿
}

// ---------- ส่งข้อความ ----------
// ---------- ★ v2.1: ข้อความแจ้งเตือนค่าเงิน ----------
function buildFxText(e) {
  const lines = [
    `💱 ${e.label} (${e.purpose})`,
    '',
    `${e.pair} = ${fmtRate(e.rate)}`,
    `เรตที่น่าจะได้จริง ${fmtRate(e.effectiveRate)} (หักส่วนต่างแล้ว)`,
    `คะแนนความคุ้ม ${e.score.toFixed(0)}/100 · เปอร์เซ็นไทล์ ${e.percentile.toFixed(0)} ของปีที่ผ่านมา`,
    '',
    'เพราะ:',
    ...e.reasons.map((r) => `• ${r}`),
  ];
  if (e.amountNote) lines.push('', `💵 ${e.amountNote}`);
  lines.push('', `⚠️ ${e.disclaimer}`, thTime(new Date(e.ts)));
  return lines.join('\n');
}

// ส่งแจ้งเตือนค่าเงินเข้า LINE — ใช้เส้นทางเดียวกับสัญญาณหุ้น ต่างแค่เนื้อความ
export async function pushFxToLine(entry) {
  return pushToLine(buildFxText(entry), `ค่าเงิน ${entry.pair}`);
}

export async function pushSignalToLine(payload) {
  return pushToLine(buildAlertText(payload), payload.symbol);
}

// ---------- ★ หุ้นคะแนนถึงเกณฑ์ — ทั้งรอบสแกนรวมเป็นข้อความเดียว (ประหยัดโควตา LINE OA) ----------
const SCORE_LINE_MAX = 10;
function buildScoreText(p) {
  const hits = p.hits || [];
  const lines = [`🔔 หุ้นคะแนนถึงเกณฑ์ ≥ ${p.min} (${hits.length} ตัว)`, ''];
  hits.slice(0, SCORE_LINE_MAX).forEach((h, i) => {
    const chg = Number.isFinite(h.changePct) ? ` (${h.changePct >= 0 ? '+' : ''}${h.changePct.toFixed(2)}%)` : '';
    const cur = h.cur || marketInfo(h.symbol).cur; // ★ หุ้นไทย = ฿
    lines.push(`${i + 1}) ${h.symbol} ${h.tf} · คะแนน ${Number(h.score).toFixed(0)} · ${cur}${Number(h.price).toFixed(2)}${chg}`);
    const extra = [
      h.isSignal ? 'สัญญาณ ✓' : h.passed ? 'ผ่านด่าน ✓' : 'ยังไม่ผ่านด่านคุณภาพ',
      h.rr ? `R:R ${h.rr}` : null,
      Number.isFinite(h.rvol) ? `RVOL ${h.rvol.toFixed(2)}x` : null,
    ].filter(Boolean);
    lines.push(`   ${extra.join(' · ')}`);
  });
  if (hits.length > SCORE_LINE_MAX) lines.push(`…และอีก ${hits.length - SCORE_LINE_MAX} ตัว (ดูในแดชบอร์ด)`);
  lines.push('', `เวลา ${thTime(new Date(p.ts))} (ไทย) · เตือนหุ้นละไม่เกิน 1 ครั้งต่อวัน`);
  lines.push('— เครื่องมือช่วยคัดกรอง ไม่ใช่คำแนะนำการลงทุน —');
  return lines.join('\n');
}

export async function pushScoreAlertToLine(payload) {
  return pushToLine(buildScoreText(payload), `คะแนนถึงเกณฑ์ ${payload.hits?.length || 0} ตัว`);
}

// ---------- ตัวส่งจริง (ใช้ร่วมกันระหว่างสัญญาณหุ้นและค่าเงิน) ----------
async function pushToLine(text, label) {
  const st = settings.all;
  if (!st.lineEnabled) return { ok: false, skipped: true, reason: 'ปิดการส่ง LINE อยู่' };
  if (!isLineConfigured()) {
    return { ok: false, skipped: true, reason: 'ยังไม่ได้ตั้ง LINE token / target' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${st.lineToken}`,
      },
      body: JSON.stringify({
        to: st.lineTarget,
        messages: [{ type: 'text', text: String(text).slice(0, 4900) }], // LINE จำกัด 5000 ตัวอักษร
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LINE HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    log.success(`ส่งแจ้งเตือน ${label} เข้า LINE แล้ว`);
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('ส่ง LINE หมดเวลารอ (timeout)');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- ส่งข้อความทดสอบ (ปุ่มในหน้า Settings) ----------
export async function sendLineTest() {
  const st = settings.all;
  if (!isLineConfigured()) {
    return { ok: false, reason: 'ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN และ LINE_TARGET_ID' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${st.lineToken}` },
      body: JSON.stringify({
        to: st.lineTarget,
        messages: [{
          type: 'text',
          text: `✅ ทดสอบการเชื่อมต่อ Scalp Scanner สำเร็จ\nเวลา ${thTime()} (ไทย)`,
        }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `LINE HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'หมดเวลารอ (timeout)' : err.message };
  } finally {
    clearTimeout(timer);
  }
}
