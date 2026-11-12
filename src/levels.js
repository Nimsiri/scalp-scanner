// src/levels.js — หาแนวต้าน/แนวรับ ด้วย fractal swing pivot + การรวมกลุ่ม (clustering)
//
// ═══ ทำไมใช้วิธีนี้ (สเปกข้อ 4 ขอให้อธิบายเหตุผล) ═══
//
// ปัญหาของ "highest high ของ 20 แท่งล่าสุด" แบบตรงๆ:
//   ถ้าหุ้นกำลังทำ new high อยู่ ค่า highest-high จะ ≈ ราคาปัจจุบัน
//   → ราคาเป้าหมาย (แนวต้าน × 0.999) จะอยู่ "ต่ำกว่า" ราคาปัจจุบัน
//   → ระบบจะแจ้งเตือนทันทีทุกรอบ ไร้ความหมาย
//
// ทำไมไม่ใช้ pivot point รายวัน (R1/R2 จาก High/Low/Close เมื่อวาน):
//   คำนวณครั้งเดียวตอนเช้าแล้วนิ่งทั้งวัน
//   หุ้น scalp ที่วิ่ง 8% จากข่าวจะทะลุ R2 ใน 20 นาทีแรก
//   แล้วอีก 6 ชั่วโมงที่เหลือไม่มีแนวอะไรให้ใช้เลย
//   → pivot point เหมาะกับกรอบเวลาใหญ่ ไม่เหมาะกับ scalping บน 5 นาที
//
// วิธีที่เลือก — fractal swing pivot:
//   แท่งจะนับเป็น "pivot high" เมื่อ high ของมันสูงกว่า high ของ k แท่งทั้งซ้ายและขวา
//   ความหมาย: ราคาไปถึงจุดนั้นแล้ว "ถูกปฏิเสธจริง" มีคนขายรออยู่จริง
//   ข้อดีสำคัญ: เพราะต้องรอ k แท่งขวายืนยัน มันจะไม่มีทางเป็นแท่งปัจจุบัน
//              → ไม่เกิดปัญหาเป้าหมายอ้างอิงตัวเอง
//
// การรวมกลุ่ม (clustering):
//   pivot ที่ราคาห่างกันไม่เกิน 0.25 × ATR ถือเป็น "โซนเดียวกัน"
//   ใช้ "ขอบล่าง" ของโซนเป็นราคาที่ actionable (เพราะแรงขายเริ่มตรงนั้น)
//   และนับจำนวนครั้งที่ราคามาชน (touches): ชน 3 ครั้ง = กำแพงจริง, wick เดี่ยว = อ่อน
//   จำนวน touches ถูกส่งต่อไปเป็นส่วนหนึ่งของคะแนนด้วย

// ---------- หา pivot high แบบ fractal ----------
// คืน array ของ { idx, price, date }
// เงื่อนไข: high[i] >= high ของ k แท่งซ้าย และ high[i] > high ของ k แท่งขวา
// (ใช้ >= ทางซ้าย เพื่อไม่ให้ยอดแบนราบ (flat top) ถูกนับซ้ำหลายแท่ง)
export function findPivotHighs(bars, k = 2) {
  const out = [];
  if (!Array.isArray(bars) || bars.length < 2 * k + 1) return out;

  // i หยุดที่ length-1-k เพราะแท่งท้ายๆ ยังไม่มีแท่งขวาพอที่จะยืนยัน
  for (let i = k; i <= bars.length - 1 - k; i++) {
    const h = bars[i].high;
    if (!Number.isFinite(h)) continue;

    let isPivot = true;
    for (let j = 1; j <= k; j++) {
      if (!(h >= bars[i - j].high)) { isPivot = false; break; }
      if (!(h > bars[i + j].high)) { isPivot = false; break; }
    }
    if (isPivot) out.push({ idx: i, price: h, date: bars[i].date });
  }
  return out;
}

// ---------- หา pivot low (ใช้อ้างอิงแนวรับ / จุดตัดขาดทุน) ----------
export function findPivotLows(bars, k = 2) {
  const out = [];
  if (!Array.isArray(bars) || bars.length < 2 * k + 1) return out;

  for (let i = k; i <= bars.length - 1 - k; i++) {
    const l = bars[i].low;
    if (!Number.isFinite(l)) continue;

    let isPivot = true;
    for (let j = 1; j <= k; j++) {
      if (!(l <= bars[i - j].low)) { isPivot = false; break; }
      if (!(l < bars[i + j].low)) { isPivot = false; break; }
    }
    if (isPivot) out.push({ idx: i, price: l, date: bars[i].date });
  }
  return out;
}

// ---------- รวม pivot ที่อยู่ใกล้กันเป็นโซนเดียว ----------
// tolerance = atr × clusterAtrMult
// คืน array ของโซน เรียงจากราคาต่ำไปสูง
export function clusterLevels(pivots, atr, clusterAtrMult = 0.25) {
  if (!Array.isArray(pivots) || pivots.length === 0) return [];
  const tol = Number.isFinite(atr) && atr > 0 ? atr * clusterAtrMult : 0;

  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const zones = [];
  let cur = null;

  for (const p of sorted) {
    // ถ้าอยู่ในระยะ tolerance จากโซนปัจจุบัน → รวมเข้าโซนเดิม
    if (cur && p.price - cur.low <= tol) {
      cur.low = Math.min(cur.low, p.price);
      cur.high = Math.max(cur.high, p.price);
      cur.touches += 1;
      cur.members.push(p);
      cur.lastIdx = Math.max(cur.lastIdx, p.idx);
    } else {
      if (cur) zones.push(cur);
      cur = { low: p.price, high: p.price, touches: 1, members: [p], lastIdx: p.idx };
    }
  }
  if (cur) zones.push(cur);

  // คำนวณค่ากลางและความ "สด" ของแต่ละโซน
  for (const z of zones) {
    z.mid = (z.low + z.high) / 2;
    z.width = z.high - z.low;
  }
  return zones;
}

// ---------- ตัวหลัก: หาแนวต้านที่ใช้งานได้จริง ----------
// อินพุต:
//   bars   — แท่งเทียน (เรียงเก่า → ใหม่)
//   price  — ราคาปัจจุบัน
//   atr    — ค่า ATR ล่าสุด (ใช้กำหนดขนาด tolerance และการ projection)
//   opts   — { pivotK, clusterAtrMult, lookback, minDistancePct }
//            minDistancePct = แนวต้านต้องอยู่เหนือราคาปัจจุบันอย่างน้อยกี่ %
//            สำคัญมาก: ถ้าไม่กำหนด แนวต้านที่อยู่เหนือราคาแค่ 0.05% จะทำให้
//            ราคาเป้าหมาย (แนวต้าน − 0.1%) ตกไปอยู่ "ต่ำกว่า" ราคาปัจจุบัน
//            → แจ้งเตือนทันทีทุกรอบแบบไร้ความหมาย
//            scanner จะส่งค่า alertOffsetPct มาที่นี่เพื่อกันปัญหานี้ตั้งแต่ต้นทาง
//
// เอาต์พุต:
//   level      — ราคาแนวต้านที่ actionable (ขอบล่างของโซน)
//   method     — 'pivot-cluster' | 'lookback-high' | 'projected'
//   confirmed  — true เฉพาะเมื่อเป็นแนวต้านที่ราคาเคยชนแล้วเด้งจริง
//   touches    — จำนวนครั้งที่ราคามาชนโซนนี้
//   distanceAtr— อยู่ห่างจากราคาปัจจุบันกี่เท่าของ ATR
//   note       — คำอธิบายภาษาไทยสำหรับแสดงใน UI
export function findResistance(bars, price, atr, opts = {}) {
  const { pivotK = 2, clusterAtrMult = 0.25, lookback = 20, minDistancePct = 0 } = opts;

  // ราคาขั้นต่ำที่แนวต้านต้องอยู่เหนือ เพื่อให้เป้าหมายที่คำนวณได้ยังอยู่เหนือราคาปัจจุบัน
  const minLevel = price * (1 + Math.max(0, minDistancePct) / 100);

  const empty = {
    level: null, method: 'none', confirmed: false, touches: 0,
    zoneLow: null, zoneHigh: null, distanceAtr: null, distancePct: null,
    note: 'ข้อมูลไม่พอสำหรับหาแนวต้าน', zones: [],
  };

  if (!Array.isArray(bars) || bars.length < 2 * pivotK + 2) return empty;
  if (!Number.isFinite(price) || price <= 0) return empty;

  const pivots = findPivotHighs(bars, pivotK);
  const zones = clusterLevels(pivots, atr, clusterAtrMult);

  // ---------- 1) หาโซนที่อยู่เหนือราคาปัจจุบัน (ใกล้ที่สุดก่อน) ----------
  // ใช้ขอบล่างของโซน (z.low) เป็นเกณฑ์ "อยู่เหนือราคา" และเป็นราคาที่ actionable
  const above = zones
    .filter((z) => z.low > minLevel)
    .sort((a, b) => a.low - b.low);

  if (above.length > 0) {
    const z = above[0];
    return finish(z.low, 'pivot-cluster', true, z.touches, z.low, z.high, zones,
      `แนวต้านยืนยันแล้ว (ราคาชน ${z.touches} ครั้ง)`);
  }

  // ---------- 2) ไม่มีโซนยืนยันเหนือราคา → ลอง highest high ของช่วง lookback ----------
  // ไม่รวมแท่งปัจจุบัน (แท่งที่ยังไม่ปิด) เพราะจะกลายเป็นอ้างอิงตัวเอง
  const win = bars.slice(Math.max(0, bars.length - 1 - lookback), bars.length - 1);
  if (win.length > 0) {
    const hh = Math.max(...win.map((b) => b.high).filter(Number.isFinite));
    if (Number.isFinite(hh) && hh > minLevel) {
      return finish(hh, 'lookback-high', false, 1, hh, hh, zones,
        `ยังไม่มีแนวต้านยืนยัน — ใช้จุดสูงสุด ${lookback} แท่งล่าสุดแทน`);
    }
  }

  // ---------- 3) ราคาอยู่เหนือทุกอย่าง (เบรกไปแล้ว) → ประมาณเป้าจากระยะ ATR ----------
  // ติดป้ายชัดว่าเป็น "การประมาณ" ไม่ใช่แนวต้านที่สังเกตได้
  // และปัจจัย "ระยะห่างจากแนวต้าน" ในคะแนนจะได้ค่ากลางๆ ไม่ใช่ค่าปลอม
  if (Number.isFinite(atr) && atr > 0) {
    // เป้าประมาณต้องอยู่เหนือ minLevel ด้วย (ถ้า ATR เล็กมากให้ดันขึ้นไปให้พอ)
    const projected = Math.max(price + atr, minLevel * 1.0005);
    return finish(projected, 'projected', false, 0, projected, projected, zones,
      'ราคาอยู่เหนือแนวต้านเดิมทั้งหมด (เบรกแล้ว) — เป้านี้เป็นค่าประมาณจาก ATR ไม่ใช่แนวต้านจริง');
  }

  return { ...empty, zones, note: 'ราคาอยู่เหนือแนวต้านเดิมทั้งหมด และคำนวณ ATR ไม่ได้' };

  function finish(level, method, confirmed, touches, zoneLow, zoneHigh, allZones, note) {
    const dist = level - price;
    return {
      level,
      method,
      confirmed,
      touches,
      zoneLow,
      zoneHigh,
      distanceAtr: Number.isFinite(atr) && atr > 0 ? dist / atr : null,
      distancePct: (dist / price) * 100,
      note,
      // ส่งโซนทั้งหมดไปให้ UI วาดได้ (เอาแค่ 6 โซนที่ใกล้ราคาที่สุด)
      zones: allZones
        .map((z) => ({ low: z.low, high: z.high, touches: z.touches, lastIdx: z.lastIdx }))
        .sort((a, b) => Math.abs(a.low - price) - Math.abs(b.low - price))
        .slice(0, 6),
    };
  }
}

// ---------- หาแนวรับที่ใกล้ที่สุดใต้ราคา (ใช้อ้างอิงจุดตัดขาดทุน) ----------
export function findSupport(bars, price, atr, opts = {}) {
  const { pivotK = 2, clusterAtrMult = 0.25 } = opts;
  if (!Array.isArray(bars) || bars.length < 2 * pivotK + 2) return { level: null, touches: 0, confirmed: false };

  const pivots = findPivotLows(bars, pivotK);
  const zones = clusterLevels(pivots, atr, clusterAtrMult);

  const below = zones.filter((z) => z.high < price).sort((a, b) => b.high - a.high);
  if (below.length > 0) {
    const z = below[0];
    return { level: z.high, touches: z.touches, confirmed: true, zoneLow: z.low, zoneHigh: z.high };
  }
  return { level: null, touches: 0, confirmed: false };
}

// ---------- ราคาเป้าหมายสำหรับแจ้งเตือน (สเปกข้อ 4) ----------
// ถ้า user กรอกเอง → ใช้ค่านั้น (manual)
// ถ้าไม่กรอก → แนวต้าน × (1 − offsetPct/100)  เช่น offsetPct=0.1 → แนวต้าน × 0.999
export function resolveAlertTarget({
  manualTarget, resistance, alertOffsetPct = 0.1, price = null,
  entryMode = 'anticipate',      // ★ v2: 'anticipate' = เข้าก่อนเบรก (เดิม) · 'confirm' = รอทะลุจริง
  confirmOffsetPct = 0.05,       // ★ v2: โหมด confirm เตือนเมื่อราคาขึ้นเหนือแนวต้านกี่ %
}) {
  const manual = Number(manualTarget);
  if (Number.isFinite(manual) && manual > 0) {
    // ราคาตั้งเองที่อยู่ใต้ราคาปัจจุบันแล้ว = user ตั้งไว้นานแล้วและราคาผ่านไปแล้ว
    // ยังถือว่าใช้ได้ (จะ trigger ทันที) แต่ติดธงบอกให้ UI เตือนว่าควรตั้งใหม่
    const passed = Number.isFinite(price) && manual <= price;
    return {
      target: manual,
      mode: 'manual',
      label: 'ตั้งเอง',
      basis: null,
      belowPrice: passed,
      note: passed
        ? 'ราคาเป้าหมายที่คุณกรอกอยู่ต่ำกว่าราคาปัจจุบันแล้ว — ควรตั้งค่าใหม่'
        : 'ราคาเป้าหมายที่คุณกรอกเอง',
    };
  }

  // ═══ ★ v2: โหมด confirm — รอราคาทะลุแนวต้านจริงก่อนค่อยเตือน ═══
  //
  // โหมดเดิม (anticipate, แนวต้าน × 0.999) คือการ front-run breakout
  // แผนงานเดิมของโปรเจกต์ยอมรับเองว่า "ประมาณครึ่งหนึ่งจะกลายเป็นการเด้งกลับ"
  // ซึ่งแปลว่าครึ่งหนึ่งของไม้ตายที่แนวต้านโดยที่ไม่เคยได้กำไรเลย = ค่าเฉลี่ยกำไรต่อไม้ต่ำ
  //
  // โหมด confirm ยอมเสียราคาเข้าไปนิดหน่อย (confirmOffsetPct) แลกกับการรู้ว่า
  // แนวต้านแตกจริงแล้ว และ scanner จะบังคับให้แท่งที่ทะลุมีวอลุ่มยืนยันด้วย (ดู _checkQuality)
  if (entryMode === 'confirm' && resistance && Number.isFinite(resistance.level) && resistance.level > 0) {
    const target = resistance.level * (1 + confirmOffsetPct / 100);
    return {
      target,
      mode: 'confirm',
      label: `ยืนยันเบรก (แนวต้าน +${confirmOffsetPct}%)`,
      basis: resistance.level,
      confirmed: resistance.confirmed,
      method: resistance.method,
      alreadyBroken: Number.isFinite(price) && price >= target,
      note: `เตือนเมื่อราคาขึ้นเหนือแนวต้าน $${resistance.level.toFixed(2)} ไป ${confirmOffsetPct}% (= $${target.toFixed(2)}) ` +
            `พร้อมวอลุ่มยืนยัน — เข้าช้ากว่าโหมดเดิมแต่ตัดกรณีที่ชนแล้วเด้งกลับออกไป`,
    };
  }

  if (resistance && Number.isFinite(resistance.level) && resistance.level > 0) {
    const target = resistance.level * (1 - alertOffsetPct / 100);

    // ป้องกันเป้าหมายอัตโนมัติที่ตกไปอยู่ต่ำกว่าราคาปัจจุบัน
    // (เกิดเมื่อแนวต้านอยู่ใกล้ราคามากกว่าระยะ offset — เช่นแนวต้านห่าง 0.07% แต่ offset 0.1%)
    // กรณีนี้ไม่ควรแจ้งเตือน เพราะ "ราคาถึงเป้าแล้วตั้งแต่ก่อนคำนวณ" ไม่ใช่สัญญาณอะไร
    if (Number.isFinite(price) && target <= price) {
      return {
        target: null,
        mode: 'auto-invalid',
        label: 'auto (ใกล้แนวต้านเกินไป)',
        basis: resistance.level,
        note: `แนวต้าน $${resistance.level.toFixed(2)} อยู่ห่างจากราคาแค่ ${(((resistance.level - price) / price) * 100).toFixed(3)}% ` +
              `ซึ่งน้อยกว่าระยะแจ้งเตือน ${alertOffsetPct}% — ไม่ตั้งเป้าหมายรอบนี้ (กันเตือนแบบไร้ความหมาย)`,
      };
    }

    return {
      target,
      mode: 'auto',
      label: `auto (แนวต้าน −${alertOffsetPct}%)`,
      basis: resistance.level,
      confirmed: resistance.confirmed,
      method: resistance.method,
      // พูดตรงๆ ว่านี่คือการเข้าก่อนเบรกจริง ต้องมีวอลุ่มยืนยัน
      note: resistance.confirmed
        ? `คำนวณจากแนวต้าน $${resistance.level.toFixed(2)} (ชน ${resistance.touches} ครั้ง) — เป็นการเข้าก่อนเบรก ต้องมีวอลุ่มยืนยัน`
        : `คำนวณจาก ${resistance.method === 'projected' ? 'ค่าประมาณ ATR' : 'จุดสูงสุดย้อนหลัง'} $${resistance.level.toFixed(2)} — ยังไม่ใช่แนวต้านที่ยืนยันแล้ว`,
    };
  }

  return { target: null, mode: 'none', label: 'ยังคำนวณไม่ได้', basis: null, note: 'ไม่มีแนวต้านและไม่ได้ตั้งราคาเอง' };
}
