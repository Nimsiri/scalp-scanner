// src/market-hours.js — เวลาทำการของตลาดหุ้นอเมริกา (เขตเวลา America/New_York)
// รองรับ session ทั้ง 4 แบบตามสเปกข้อ 8 (โค้ดเดิมใน config.js รู้จักแค่ regular/extended/always)
//
//   pre     04:00 - 09:30 ET  (ก่อนเปิดตลาด)
//   regular 09:30 - 16:00 ET  (เวลาทำการปกติ)
//   post    16:00 - 20:00 ET  (หลังปิดตลาด)
//   all     04:00 - 20:00 ET  (ทุกช่วงรวมกัน)

// ช่วงเวลาเป็น "นาทีนับจากเที่ยงคืน ET"
const SESSIONS = {
  pre: { start: 4 * 60, end: 9 * 60 + 30, label: 'ก่อนเปิดตลาด (Pre-market)' },
  regular: { start: 9 * 60 + 30, end: 16 * 60, label: 'เวลาทำการปกติ (Regular)' },
  post: { start: 16 * 60, end: 20 * 60, label: 'หลังปิดตลาด (Post-market)' },
  all: { start: 4 * 60, end: 20 * 60, label: 'ทุกช่วง (Pre + Regular + Post)' },
};

const NY_TZ = 'America/New_York';
const TH_TZ = 'Asia/Bangkok';

// ---------- ★ เวลาตามเขตเวลาใดก็ได้ (ใช้ร่วมกันระหว่างตลาดอเมริกาและตลาดไทย) ----------
// สร้าง Intl.DateTimeFormat ครั้งเดียวต่อเขตเวลา — เดิมสร้างใหม่ทุกครั้งที่เรียก
const fmtCache = new Map();
function formatter(kind, tz) {
  const key = `${kind}:${tz}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = kind === 'parts'
      ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false })
      : kind === 'date'
        ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        : new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    fmtCache.set(key, f);
  }
  return f;
}

export function zonedNow(tz, now = new Date()) {
  const map = {};
  for (const p of formatter('parts', tz).formatToParts(now)) map[p.type] = p.value;

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[map.weekday] ?? now.getDay();
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // บาง locale คืน 24:xx แทน 00:xx
  const minute = Number(map.minute);

  return { weekday, hour, minute, minutes: hour * 60 + minute };
}

export function dateKeyIn(tz, now = new Date()) {
  return formatter('date', tz).format(now);
}

export function timeStringIn(tz, now = new Date()) {
  return formatter('time', tz).format(now);
}

// ---------- เวลาปัจจุบันตามเขต New York ----------
export function nyNow(now = new Date()) {
  return zonedNow(NY_TZ, now);
}

// ---------- วันที่ปัจจุบันตามเขต New York (YYYY-MM-DD) ----------
export function nyDateKey(now = new Date()) {
  return dateKeyIn(NY_TZ, now);
}

// ---------- เวลาปัจจุบันแบบข้อความ (แสดงในหน้าเว็บ) ----------
export function nyTimeString(now = new Date()) {
  return timeStringIn(NY_TZ, now);
}

// ---------- วันหยุดตลาดหุ้นอเมริกา ----------
// ⚠️ ข้อจำกัดที่ต้องรู้: รายการนี้เป็นค่าคงที่ในโค้ด (hard-coded) ต้องอัปเดตมือทุกปี
//    ไม่ได้เช็คจาก API ปฏิทินตลาด และไม่ครอบคลุมวันปิดครึ่งวัน (early close 13:00 ET)
//    ถ้าไม่มีข้อมูลของปีนั้น ระบบจะถือว่าเป็นวันทำการปกติ (fail-open)
const HOLIDAYS = {
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
         '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
         '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
};

export function isMarketHoliday(now = new Date()) {
  const key = nyDateKey(now);
  const year = key.slice(0, 4);
  const list = HOLIDAYS[year];
  if (!list) return { holiday: false, unknown: true }; // ไม่มีข้อมูลปีนี้ = ถือว่าทำการปกติ
  return { holiday: list.includes(key), unknown: false };
}

// ---------- ตลาดเปิดอยู่หรือไม่ ตาม session ที่เลือก ----------
export function isMarketOpen(session = 'regular', now = new Date()) {
  const s = SESSIONS[session] || SESSIONS.regular;
  const { weekday, minutes } = nyNow(now);

  if (weekday === 0 || weekday === 6) return false; // เสาร์-อาทิตย์
  if (isMarketHoliday(now).holiday) return false;

  return minutes >= s.start && minutes < s.end;
}

// ---------- สถานะตลาดแบบละเอียด (ส่งไปแสดงในหน้าเว็บ) ----------
export function marketStatus(session = 'regular', now = new Date()) {
  const { weekday, minutes } = nyNow(now);
  const s = SESSIONS[session] || SESSIONS.regular;
  const hol = isMarketHoliday(now);

  // ช่วงที่ตลาดอยู่จริงตอนนี้ (ไม่เกี่ยวกับ session ที่ user เลือก)
  let actualPhase = 'closed';
  if (weekday !== 0 && weekday !== 6 && !hol.holiday) {
    if (minutes >= SESSIONS.pre.start && minutes < SESSIONS.pre.end) actualPhase = 'pre';
    else if (minutes >= SESSIONS.regular.start && minutes < SESSIONS.regular.end) actualPhase = 'regular';
    else if (minutes >= SESSIONS.post.start && minutes < SESSIONS.post.end) actualPhase = 'post';
  }

  const open = isMarketOpen(session, now);

  // อีกกี่นาทีจะเปิด/ปิด (ตาม session ที่เลือก)
  let nextChangeMin = null;
  let nextChangeLabel = null;
  if (weekday >= 1 && weekday <= 5 && !hol.holiday) {
    if (open) {
      nextChangeMin = s.end - minutes;
      nextChangeLabel = `ปิดในอีก ${formatMins(nextChangeMin)}`;
    } else if (minutes < s.start) {
      nextChangeMin = s.start - minutes;
      nextChangeLabel = `เปิดในอีก ${formatMins(nextChangeMin)}`;
    }
  }

  const phaseLabels = {
    pre: 'ก่อนเปิดตลาด', regular: 'เวลาทำการปกติ',
    post: 'หลังปิดตลาด', closed: 'ตลาดปิด',
  };

  let reason = null;
  if (!open) {
    if (weekday === 0 || weekday === 6) reason = 'วันหยุดสุดสัปดาห์';
    else if (hol.holiday) reason = 'วันหยุดตลาดหุ้นอเมริกา';
    else if (actualPhase !== 'closed') reason = `ตอนนี้เป็นช่วง "${phaseLabels[actualPhase]}" แต่คุณตั้ง session ไว้เป็น "${session}"`;
    else reason = 'อยู่นอกเวลาทำการทุกช่วง';
  }

  return {
    open,
    session,
    sessionLabel: s.label,
    actualPhase,
    actualPhaseLabel: phaseLabels[actualPhase],
    nyTime: nyTimeString(now),
    nyDate: nyDateKey(now),
    weekday,
    isWeekend: weekday === 0 || weekday === 6,
    isHoliday: hol.holiday,
    holidayDataUnknown: hol.unknown,
    nextChangeMin,
    nextChangeLabel,
    reason,
  };
}

function formatMins(m) {
  if (!Number.isFinite(m) || m < 0) return '—';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h > 0 ? `${h} ชม. ${mm} นาที` : `${mm} นาที`;
}

// ═══════════════════ ★ ตลาดหุ้นไทย (SET) — เขตเวลา Asia/Bangkok ═══════════════════
//
// ช่วงซื้อขายต่อเนื่อง (ไม่นับช่วง pre-open ที่จับคู่ราคาแบบ auction)
//   เช้า   10:00 - 12:30
//   บ่าย   14:30 - 16:30
// ไทยไม่มีการปรับเวลาฤดูร้อน แต่ต้องใช้เวลาไทยจริง ไม่ใช่เวลานิวยอร์ก:
// 10:00 วันจันทร์ที่กรุงเทพ = 23:00 วันอาทิตย์ที่นิวยอร์ก ถ้าใช้ตัวเช็คของตลาดอเมริกา
// ทั้งช่วงเช้าวันจันทร์จะถูกมองว่าเป็น "วันหยุดสุดสัปดาห์"
const TH_RANGES = { morning: [600, 750], afternoon: [870, 990] };
export const TH_SESSION_LABEL = 'เวลาทำการ (เช้า 10:00–12:30 · บ่าย 14:30–16:30)';

// วันหยุดตลาดหลักทรัพย์ฯ — ⚠️ ค่าคงที่ในโค้ด ต้องอัปเดตมือทุกปีตามประกาศของ SET
// ใส่เฉพาะวันที่แน่ใจ: ถ้าขาดไป ระบบแค่สแกนในวันหยุด (ข้อมูลไม่ขยับ → ถูกตีเป็นข้อมูลไม่อัปเดต ไม่มีการแจ้งเตือน)
// แต่ถ้าใส่ผิด ระบบจะไม่สแกนในวันที่ตลาดเปิดจริง ซึ่งแย่กว่า
// ปี 2027: ยังไม่มีวันหยุดทางพุทธศาสนา (มาฆบูชา/วิสาขบูชา/อาสาฬหบูชา) และวันหยุดชดเชย — รอ SET ประกาศ
const TH_HOLIDAYS = {
  2026: ['2026-01-01', '2026-03-03', '2026-04-06', '2026-04-13', '2026-04-14', '2026-04-15',
         '2026-05-01', '2026-05-04', '2026-06-01', '2026-06-03', '2026-07-28', '2026-07-29',
         '2026-08-12', '2026-10-13', '2026-10-23', '2026-12-10', '2026-12-31'],
  2027: ['2027-01-01', '2027-04-06', '2027-04-13', '2027-04-14', '2027-04-15', '2027-05-04',
         '2027-06-03', '2027-07-28', '2027-08-12', '2027-10-13', '2027-12-10', '2027-12-31'],
};

export function isThaiMarketHoliday(now = new Date()) {
  const key = dateKeyIn(TH_TZ, now);
  const list = TH_HOLIDAYS[key.slice(0, 4)];
  if (!list) return { holiday: false, unknown: true };
  return { holiday: list.includes(key), unknown: false };
}

const TH_PHASE_LABELS = {
  pre: 'ก่อนเปิดตลาด', morning: 'ช่วงเช้า', lunch: 'พักเที่ยง',
  afternoon: 'ช่วงบ่าย', after: 'ปิดตลาดแล้ว', closed: 'ตลาดปิด',
};

// dataDelayMin: ข้อมูลฟรีของหุ้นไทยช้ากว่าจริง จึงสแกนต่ออีกช่วงหนึ่งหลังปิดแต่ละช่วง
// (ไม่งั้นราคา 15-30 นาทีสุดท้ายของช่วงเช้าและช่วงบ่ายจะไม่เคยถูกสแกนเลย)
export function thaiMarketStatus(now = new Date(), { dataDelayMin = 0 } = {}) {
  const { weekday, minutes, hour, minute } = zonedNow(TH_TZ, now);
  const hol = isThaiMarketHoliday(now);
  const isWeekend = weekday === 0 || weekday === 6;
  const tradingDay = !isWeekend && !hol.holiday;
  const [mS, mE] = TH_RANGES.morning;
  const [aS, aE] = TH_RANGES.afternoon;

  let phase = 'closed';
  if (tradingDay) {
    if (minutes < mS) phase = 'pre';
    else if (minutes < mE) phase = 'morning';
    else if (minutes < aS) phase = 'lunch';
    else if (minutes < aE) phase = 'afternoon';
    else phase = 'after';
  }
  const open = phase === 'morning' || phase === 'afternoon';

  const delay = Math.max(0, Number(dataDelayMin) || 0);
  const inDelayTail = tradingDay && !open &&
    ((minutes >= mE && minutes < mE + delay) || (minutes >= aE && minutes < aE + delay));

  let nextChangeMin = null;
  let nextChangeLabel = null;
  if (phase === 'morning') { nextChangeMin = mE - minutes; nextChangeLabel = `พักเที่ยงในอีก ${formatMins(nextChangeMin)}`; }
  else if (phase === 'afternoon') { nextChangeMin = aE - minutes; nextChangeLabel = `ปิดในอีก ${formatMins(nextChangeMin)}`; }
  else if (phase === 'pre') { nextChangeMin = mS - minutes; nextChangeLabel = `เปิดในอีก ${formatMins(nextChangeMin)}`; }
  else if (phase === 'lunch') { nextChangeMin = aS - minutes; nextChangeLabel = `เปิดช่วงบ่ายในอีก ${formatMins(nextChangeMin)}`; }

  let reason = null;
  if (!open) {
    if (isWeekend) reason = 'วันหยุดสุดสัปดาห์';
    else if (hol.holiday) reason = 'วันหยุดตลาดหุ้นไทย';
    else if (phase === 'lunch') reason = 'พักเที่ยง — เปิดอีกครั้ง 14:30 น.';
    else if (phase === 'pre') reason = 'ยังไม่เปิดตลาด (เปิด 10:00 น.)';
    else reason = 'ปิดตลาดแล้ว (16:30 น.)';
    if (inDelayTail) {
      const endMin = (minutes < aS ? mE : aE) + delay;
      const hh = String(Math.floor(endMin / 60)).padStart(2, '0');
      const mm = String(endMin % 60).padStart(2, '0');
      reason += ` · ข้อมูลช้าราว ${delay} นาที จึงสแกนต่อถึง ${hh}:${mm} น.`;
    }
  }

  return {
    market: 'TH',
    open,
    scanOpen: open || inDelayTail,
    inDelayTail,
    session: 'regular',
    sessionLabel: TH_SESSION_LABEL,
    actualPhase: phase,
    actualPhaseLabel: TH_PHASE_LABELS[phase],
    localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    localDate: dateKeyIn(TH_TZ, now),
    tzLabel: 'ไทย',
    weekday,
    isWeekend,
    isHoliday: hol.holiday,
    holidayDataUnknown: hol.unknown,
    nextChangeMin,
    nextChangeLabel,
    reason,
    dataDelayMin: delay,
  };
}

// ---------- ★ สถานะของตลาดใดก็ได้ในรูปแบบเดียวกัน ----------
// ตลาดอเมริกา = marketStatus() เดิมทุกอย่าง แค่เติมฟิลด์กลาง (market, scanOpen, localTime ...)
export function marketStatusFor(market, session = 'regular', now = new Date(), opts = {}) {
  if (market === 'TH') return thaiMarketStatus(now, opts);
  const s = marketStatus(session, now);
  return { ...s, market: 'US', scanOpen: s.open, inDelayTail: false, localTime: s.nyTime, localDate: s.nyDate, tzLabel: 'นิวยอร์ก' };
}

// ---------- ★ "วันทำการ" ของหุ้นแต่ละตลาด (ใช้กับกฎเตือนวันละครั้ง) ----------
// ช่วงซื้อขายของตลาดไทยคร่อมเที่ยงคืนของนิวยอร์ก ถ้าใช้วันที่นิวยอร์ก หุ้นไทยจะถูกเตือนได้ 2 ครั้งในวันเดียว
export function marketDateKey(market, now = new Date()) {
  return dateKeyIn(market === 'TH' ? TH_TZ : NY_TZ, now);
}

export function marketTz(market) {
  return market === 'TH' ? TH_TZ : NY_TZ;
}

export { SESSIONS };
