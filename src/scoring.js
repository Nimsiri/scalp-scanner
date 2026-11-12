// src/scoring.js — ระบบให้คะแนนโอกาสเคลื่อนไหว (Opportunity Score) 0-100
//
// ═══ หลักการ ═══
// ทุกปัจจัยแปลงเป็นคะแนน 0-100 ก่อน แล้วคูณน้ำหนัก → รวมเป็นคะแนนสุดท้าย
// ห้ามเป็น black box: ทุกปัจจัยคืน breakdown ที่บอกว่า
//   ค่าดิบเท่าไหร่ → แปลงเป็นกี่คะแนน → น้ำหนักเท่าไหร่ → ได้กี่คะแนน → "เพราะอะไร"
//
// ═══ ถ้อยคำ (ข้อกำหนดสเปกข้อ 6) ═══
// ห้าม: "จะขึ้น X%", "ชัวร์", "แนะนำให้ซื้อ"
// ใช้: "โอกาสเคลื่อนไหวสูง", "Expected Move (จากค่าสถิติ)"
// ทุกปัจจัยต้องมีคำอธิบาย "ทำไม" เสมอ

// ---------- helper: เส้นโค้งแบบ piecewise linear ----------
// points = [[x1,y1],[x2,y2],...] เรียงตาม x
// ค่าที่อยู่ระหว่างจุดจะถูก interpolate เป็นเส้นตรง
function curve(x, points) {
  if (!Number.isFinite(x)) return null;
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    if (x >= x1 && x <= x2) {
      const t = (x - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return points[points.length - 1][1];
}

const clamp100 = (v) => Math.max(0, Math.min(100, v));

// ═══════════════ ปัจจัยที่ 1: Relative Volume (RVOL) ═══════════════
// น้ำหนักสูงสุด 25% เพราะเป็นตัวชี้วัดสำคัญที่สุดของ scalping:
// หุ้นจะวิ่งแรงได้ต้องมีคนเข้ามาเทรดมากกว่าปกติ ไม่ใช่แค่ราคาขยับ
function scoreRvol(rvol) {
  if (!Number.isFinite(rvol)) {
    return { normalized: null, available: false, raw: null, rawLabel: '—',
      why: 'ไม่มีข้อมูล RVOL (ต้องมีข้อมูลย้อนหลังอย่างน้อย 3 วันในช่วงเวลาเดียวกัน)' };
  }
  // 1.0 = วอลุ่มปกติ → 0 คะแนน (ไม่มีอะไรน่าสนใจ)
  // 2.0 = สองเท่าของปกติ → 65 คะแนน (เริ่มมีนัยสำคัญ)
  // 5.0 ขึ้นไป → 100 (วอลุ่มพุ่งผิดปกติ)
  const n = clamp100(curve(rvol, [[0.5, 0], [1.0, 0], [1.5, 40], [2.0, 65], [3.0, 85], [5.0, 100]]));
  let why;
  if (rvol >= 3) why = `วอลุ่มพุ่ง ${rvol.toFixed(2)} เท่าของค่าเฉลี่ยช่วงเวลาเดียวกัน — มีแรงซื้อขายเข้ามาผิดปกติ`;
  else if (rvol >= 2) why = `วอลุ่ม ${rvol.toFixed(2)} เท่าของปกติ — มีความสนใจเข้ามามากกว่าปกติชัดเจน`;
  else if (rvol >= 1.5) why = `วอลุ่ม ${rvol.toFixed(2)} เท่าของปกติ — เริ่มมีความสนใจเข้ามา`;
  else why = `วอลุ่ม ${rvol.toFixed(2)} เท่าของปกติ — ยังไม่ต่างจากวันธรรมดา scalp ได้ยาก`;
  return { normalized: n, available: true, raw: rvol, rawLabel: `${rvol.toFixed(2)}x`, why };
}

// ═══════════════ ปัจจัยที่ 2: ATR% / ความผันผวน ═══════════════
// ⚠️ สำคัญ: ค่าที่ใส่เข้ามาต้องเป็น ATR% "เทียบเท่ารายวัน" ไม่ใช่ ATR% ของแท่ง 5 นาที
//    เหตุผล: ATR ของแท่ง 5 นาทีอยู่ราว 0.1-0.5% ของราคา ส่วน ATR รายวันอยู่ราว 1.5-5%
//    ถ้าเอา ATR% ของแท่ง 5 นาที (0.39%) มาเทียบกับช่วงที่เหมาะของรายวัน (1.5-3%)
//    หุ้นทุกตัวจะได้ 0 คะแนนหมด ทั้งที่ความผันผวนปกติดี
//    scanner จึงส่งค่า Expected Move (ATR รายวัน หรือ ATR intraday × √แท่งต่อวัน) มาที่นี่
//
// ⚠️ จุดที่ต่างจากตารางในโจทย์: ปัจจัยนี้เป็น "ระฆัง" ไม่ใช่ยิ่งมากยิ่งดี
// เหตุผล: หุ้นนิ่งเกินไป scalp ไม่ได้ (ไม่มีระยะให้วิ่ง)
//         แต่หุ้นเหวี่ยงเกินไปก็คุมความเสี่ยงไม่ได้ (stop กว้างมาก ขนาดไม้เล็กจนไม่คุ้ม
//         และโดน stop จากสัญญาณรบกวนตลอด)
// ช่วงที่ดีที่สุด (sweet spot) ปรับได้ในหน้า Settings: default 1.5%-3.0%
function scoreVolatility(atrPct, lo, hi) {
  if (!Number.isFinite(atrPct)) {
    return { normalized: null, available: false, raw: null, rawLabel: '—', why: 'คำนวณ ATR ไม่ได้ (ข้อมูลย้อนหลังไม่พอ)' };
  }
  // สร้างเส้นโค้งระฆัง: ต่ำกว่า lo/3 = 0, ในช่วง lo..hi = 100, สูงกว่า hi×2.5 = 20
  const n = clamp100(curve(atrPct, [
    [lo / 3, 0],
    [lo * 0.66, 45],
    [lo, 100],
    [hi, 100],
    [hi * 1.6, 60],
    [hi * 2.5, 20],
    [hi * 4, 5],
  ]));
  let why;
  if (atrPct < lo * 0.66) why = `ความผันผวน ${atrPct.toFixed(2)}%/วัน — นิ่งเกินไป ระยะไม่พอให้ scalp คุ้มค่าธรรมเนียม`;
  else if (atrPct <= hi) why = `ความผันผวน ${atrPct.toFixed(2)}%/วัน — อยู่ในช่วงที่เหมาะกับ scalping (${lo}-${hi}%)`;
  else if (atrPct <= hi * 1.6) why = `ความผันผวน ${atrPct.toFixed(2)}%/วัน — เหวี่ยงกว่าช่วงที่เหมาะ ต้องกว้าง stop ขนาดไม้จะเล็กลง`;
  else why = `ความผันผวน ${atrPct.toFixed(2)}%/วัน — เหวี่ยงมาก เสี่ยงโดน stop จากสัญญาณรบกวน`;
  return { normalized: n, available: true, raw: atrPct, rawLabel: `${atrPct.toFixed(2)}%`, why };
}

// ═══════════════ ปัจจัยที่ 3: ระยะห่างจากแนวต้าน ═══════════════
// ⚠️ จุดที่ต่างจากตารางในโจทย์: peak ที่ 0.3-1.0 ATR ไม่ใช่ "ยิ่งใกล้ยิ่งดี"
// เหตุผล: ชิดแนวต้านเกินไป (<0.15 ATR) หมายความว่าเป้ากับราคาแทบเท่ากัน
//         → R:R หายไปแล้ว ไม่เหลือระยะทำกำไร
//         ระยะ 0.3-1.0 ATR คือจุดที่ "ใกล้พอจะไปถึงในไม่กี่แท่ง แต่ไกลพอให้คุ้มความเสี่ยง"
function scoreResistance(resistance) {
  if (!resistance || !Number.isFinite(resistance.distanceAtr)) {
    return { normalized: null, available: false, raw: null, rawLabel: '—', why: 'ไม่มีข้อมูลแนวต้าน' };
  }
  const d = resistance.distanceAtr;

  // แนวต้านที่ยังไม่ยืนยัน (lookback-high / projected) ได้คะแนนกลางๆ ไม่ใช่คะแนนเต็ม
  // เพราะเราไม่รู้จริงว่ามีแรงขายรออยู่ตรงนั้นหรือไม่
  if (!resistance.confirmed) {
    return {
      normalized: 50, available: true, raw: d, rawLabel: `${d.toFixed(2)} ATR (ไม่ยืนยัน)`,
      why: resistance.method === 'projected'
        ? 'ราคาทะลุแนวต้านเดิมไปแล้ว ไม่มีแนวต้านข้างหน้าให้วัด — ให้คะแนนกลางๆ ไม่เดาแทน'
        : 'แนวต้านนี้มาจากจุดสูงสุดย้อนหลัง ยังไม่เคยถูกทดสอบว่ามีแรงขายจริง — ให้คะแนนกลางๆ',
    };
  }

  // ช่วงที่ให้คะแนนเต็มถูกขยายเป็น 0.3-1.5 ATR (เดิม 0.3-1.0)
  // เพื่อให้สอดคล้องกับตัวกรอง R:R — ดูคำอธิบายเต็มที่ riskReward()
  let n = clamp100(curve(d, [
    [0, 25],      // ชิดมาก = R:R หาย
    [0.15, 55],
    [0.3, 100],   // จุดที่ดีที่สุด
    [1.5, 100],
    [2.5, 60],
    [4.0, 20],
    [6.0, 5],     // ไกลเกินไป ไม่น่าไปถึงในกรอบเวลา scalp
  ]));

  // โบนัสตามจำนวนครั้งที่ราคามาชน: 3 ครั้ง = กำแพงจริง ถ้าทะลุได้จะวิ่งแรง
  // (touches มาก = แนวต้านนี้มีนัยสำคัญ ไม่ใช่ wick เดี่ยว)
  const touchBonus = Math.min(10, Math.max(0, (resistance.touches - 1) * 3));
  n = clamp100(n + touchBonus);

  let why;
  if (d < 0.15) why = `ห่างแนวต้านแค่ ${d.toFixed(2)} ATR — ชิดเกินไป เหลือระยะทำกำไรน้อย`;
  else if (d <= 1.5) why = `ห่างแนวต้าน ${d.toFixed(2)} ATR (ชน ${resistance.touches} ครั้ง) — ระยะเหมาะ ใกล้พอจะไปถึงและไกลพอให้คุ้มความเสี่ยง`;
  else if (d <= 2.5) why = `ห่างแนวต้าน ${d.toFixed(2)} ATR — ต้องวิ่งอีกพอตัวจึงจะถึง`;
  else why = `ห่างแนวต้าน ${d.toFixed(2)} ATR — ไกลเกินกรอบเวลา scalping`;
  if (touchBonus > 0) why += ` (+${touchBonus} จากการชนซ้ำ ${resistance.touches} ครั้ง = แนวต้านมีนัยสำคัญ)`;

  return { normalized: n, available: true, raw: d, rawLabel: `${d.toFixed(2)} ATR`, why };
}

// ═══════════════ ปัจจัยที่ 4: Momentum ═══════════════
// รวม 3 องค์ประกอบ: %เปลี่ยนแปลงวันนี้ + การเรียงตัวของ EMA + ความชันของ EMA
function scoreMomentum({ changePct, ema5, ema15, ema5Prev, price }) {
  const parts = [];
  let sum = 0;
  let weight = 0;

  // 4.1 %เปลี่ยนแปลงจากราคาปิดเมื่อวาน (60% ของปัจจัยนี้)
  if (Number.isFinite(changePct)) {
    // ติดลบ = 0-30, 0% = 40, +3% = 85, +8% ขึ้นไป = 100
    // (หุ้นที่ +15% แล้วอาจยืดตัวเกินไป แต่ยังให้คะแนนสูงเพราะมีโมเมนตัมจริง)
    const n = clamp100(curve(changePct, [[-8, 0], [-3, 15], [0, 40], [1.5, 65], [3, 85], [8, 100]]));
    sum += n * 0.6; weight += 0.6;
    parts.push(`เปลี่ยนแปลง ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% วันนี้`);
  }

  // 4.2 EMA5 เทียบ EMA15 — ทิศทางแนวโน้มระยะสั้น (25%)
  if (Number.isFinite(ema5) && Number.isFinite(ema15) && ema15 > 0) {
    const gapPct = ((ema5 - ema15) / ema15) * 100;
    const n = clamp100(curve(gapPct, [[-2, 0], [-0.5, 25], [0, 50], [0.3, 80], [1.0, 100]]));
    sum += n * 0.25; weight += 0.25;
    parts.push(ema5 > ema15 ? 'EMA5 อยู่เหนือ EMA15 (แนวโน้มสั้นขาขึ้น)' : 'EMA5 อยู่ใต้ EMA15 (แนวโน้มสั้นขาลง)');
  }

  // 4.3 ความชันของ EMA5 — กำลังเร่งขึ้นหรือแผ่วลง (15%)
  if (Number.isFinite(ema5) && Number.isFinite(ema5Prev) && ema5Prev > 0) {
    const slopePct = ((ema5 - ema5Prev) / ema5Prev) * 100;
    const n = clamp100(curve(slopePct, [[-0.5, 0], [-0.1, 30], [0, 50], [0.15, 80], [0.5, 100]]));
    sum += n * 0.15; weight += 0.15;
    parts.push(slopePct > 0 ? 'EMA5 ชี้ขึ้น' : 'EMA5 ชี้ลง');
  }

  if (weight === 0) {
    return { normalized: null, available: false, raw: null, rawLabel: '—', why: 'ข้อมูลไม่พอคำนวณโมเมนตัม' };
  }

  const n = clamp100(sum / weight);
  return {
    normalized: n,
    available: true,
    raw: changePct,
    rawLabel: Number.isFinite(changePct) ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` : '—',
    why: parts.join(' · '),
  };
}

// ═══════════════ ปัจจัยที่ 5: News Sentiment ═══════════════
// ⚠️ สำคัญ: ไม่มีข้อมูล ≠ ข่าวดี
// ถ้าไม่มี sentiment ต้องให้ 50 (กลาง) และ "ติดป้ายว่าไม่มีข้อมูล" ให้ user เห็น
// ห้ามให้ดูเหมือนว่าตรวจแล้วไม่มีข่าวร้าย
function scoreSentiment(news) {
  const s = news?.sentiment;
  if (!Number.isFinite(s)) {
    const reason = news?.unavailable
      ? 'ยังไม่ได้ตั้ง API key ของแหล่งข่าว หรือดึงข้อมูลไม่สำเร็จ'
      : 'ไม่พบข่าวของหุ้นตัวนี้ในช่วง 3 วันที่ผ่านมา';
    return {
      normalized: 50, available: false, raw: null, rawLabel: 'ไม่มีข้อมูล',
      why: `${reason} — ให้คะแนนกลางๆ 50 (ไม่มีข้อมูลไม่ได้แปลว่าข่าวดี)`,
    };
  }

  // sentiment −1..+1 → 0..100
  const n = clamp100((s + 1) * 50);
  let tone;
  if (s >= 0.35) tone = 'ข่าวเป็นบวกชัดเจน';
  else if (s >= 0.1) tone = 'ข่าวเป็นบวกเล็กน้อย';
  else if (s > -0.1) tone = 'ข่าวเป็นกลาง';
  else if (s > -0.35) tone = 'ข่าวเป็นลบเล็กน้อย';
  else tone = 'ข่าวเป็นลบชัดเจน';

  const est = news.estimated ? ' (ประมาณจากคำในหัวข้อข่าว ไม่ใช่ค่าที่วัดได้)' : '';
  return {
    normalized: n,
    available: true,
    raw: s,
    rawLabel: `${s >= 0 ? '+' : ''}${s.toFixed(2)}`,
    why: `${tone} จาก ${news.articleCount} ข่าว (แหล่ง: ${news.source || '—'})${est}`,
    headlines: news.headlines || [],
    estimated: !!news.estimated,
  };
}

// ═══════════════ ปัจจัยที่ 6: Spread / Liquidity ═══════════════
// spread กว้าง = ต้นทุนเข้าออกสูง กินกำไร scalp ที่หวังแค่ 0.5-1% ได้หมด
function scoreLiquidity({ spreadPct, dollarVolume5m, spreadTicks = null, valueCurve = null }) {
  const parts = [];
  let sum = 0;
  let weight = 0;

  // 6.1 spread (70% ของปัจจัยนี้ — สำคัญกว่า เพราะเป็นต้นทุนตรง)
  if (Number.isFinite(spreadTicks) && spreadTicks > 0) {
    // ★ หุ้นไทย: วัดเป็น "จำนวนช่องราคา" แทน %
    // ช่องราคาของ SET กว้าง (PTT 41.25 บาท ขยับทีละ 0.25 = 0.6%) — spread 1 ช่องคือแคบที่สุดที่เป็นไปได้
    // ถ้าวัดเป็น % ด้วยเกณฑ์ของหุ้นอเมริกา หุ้นไทยที่สภาพคล่องดีที่สุดก็ยังได้คะแนนต่ำ
    const n = clamp100(curve(spreadTicks, [[1, 90], [2, 55], [3, 30], [5, 0]]));
    sum += n * 0.7; weight += 0.7;
    parts.push(`spread ${spreadTicks.toFixed(0)} ช่องราคา (${Number.isFinite(spreadPct) ? spreadPct.toFixed(2) + '%' : '—'})`);
  } else if (Number.isFinite(spreadPct)) {
    // 0.02% = 100, 0.1% = 70, 0.35% = 25, 1% = 0
    const n = clamp100(curve(spreadPct, [[0.01, 100], [0.05, 90], [0.1, 70], [0.2, 45], [0.35, 25], [1.0, 0]]));
    sum += n * 0.7; weight += 0.7;
    parts.push(`spread ${spreadPct.toFixed(3)}%`);
  }

  // 6.2 มูลค่าซื้อขาย 5 นาที (30%)
  // ★ valueCurve = เกณฑ์ของตลาดนั้นเป็นล้านหน่วยเงินท้องถิ่น (หุ้นไทยส่งเกณฑ์เป็นล้านบาทมา)
  if (Number.isFinite(dollarVolume5m)) {
    const m = dollarVolume5m / 1_000_000;
    const n = clamp100(curve(m, valueCurve || [[0.1, 0], [0.5, 40], [2, 75], [10, 100]]));
    sum += n * 0.3; weight += 0.3;
    parts.push(`มูลค่าซื้อขาย 5 นาที $${m.toFixed(2)}M`);
  }

  if (weight === 0) {
    return { normalized: null, available: false, raw: null, rawLabel: '—',
      why: 'ไม่มีข้อมูล bid/ask และมูลค่าซื้อขาย (provider ฟรีบางเจ้าไม่ให้ bid/ask)' };
  }

  const n = clamp100(sum / weight);
  return {
    normalized: n,
    available: true,
    raw: spreadPct,
    rawLabel: Number.isFinite(spreadPct) ? `${spreadPct.toFixed(3)}%` : `$${(dollarVolume5m / 1e6).toFixed(1)}M`,
    why: parts.join(' · ') + (n < 40 ? ' — ต้นทุนเข้าออกสูง หักคะแนน' : ''),
  };
}

// ═══════════════ Expected Move (จากค่าสถิติ ATR) ═══════════════
// ใช้ ATR รายวัน 14 วันตรงๆ ถ้ามี (แม่นกว่า)
// ถ้าไม่มี ประมาณจาก ATR intraday ด้วยกฎรากที่สองของเวลา (square-root-of-time)
//   ATR รายวัน ≈ ATR ต่อแท่ง × √(จำนวนแท่งต่อวัน)
// ⚠️ ถ้อยคำ: เป็น "ค่าสถิติที่หุ้นตัวนี้มักแกว่ง" ไม่ใช่การพยากรณ์
export function expectedMove({ dailyAtrPct, intradayAtrPct, tfMinutes, sessionHours = 6.5 }) {
  if (Number.isFinite(dailyAtrPct) && dailyAtrPct > 0) {
    return {
      pct: dailyAtrPct,
      method: 'daily-atr',
      label: `${dailyAtrPct.toFixed(2)}%`,
      note: `จากค่าสถิติ ATR 14 วัน — หุ้นตัวนี้มักแกว่งประมาณ ${dailyAtrPct.toFixed(2)}% ต่อวัน (ไม่ใช่การพยากรณ์)`,
    };
  }

  if (Number.isFinite(intradayAtrPct) && intradayAtrPct > 0 && Number.isFinite(tfMinutes) && tfMinutes > 0) {
    const barsPerDay = (sessionHours * 60) / tfMinutes; // อเมริกา 6.5 ชม. · ★ ไทย 4.5 ชม.
    const pct = intradayAtrPct * Math.sqrt(barsPerDay);
    return {
      pct,
      method: 'scaled-intraday',
      label: `~${pct.toFixed(2)}%`,
      note: `ประมาณจาก ATR ${tfMinutes} นาที × √${Math.round(barsPerDay)} แท่ง — ค่าประมาณ ไม่ใช่ ATR รายวันจริง`,
    };
  }

  return { pct: null, method: 'none', label: '—', note: 'ข้อมูลไม่พอคำนวณ Expected Move' };
}

// ═══════════════ Risk / Reward ═══════════════
//
// ⚠️ ปัญหาที่เจอตอนทดสอบจริง และวิธีแก้ (สำคัญ — อ่านก่อนแก้ค่าพวกนี้)
//
// สเปกขอ 2 อย่างที่ขัดกันเองถ้าใช้สูตรเดิม:
//   ก) ปัจจัย "ระยะห่างจากแนวต้าน" ให้คะแนนสูงสุดเมื่อราคา "ใกล้เบรกเอาท์" (~0.3-1.0 ATR)
//   ข) กรองสัญญาณที่ R:R ต่ำกว่า 1:1.5 ออก
//
// สูตร stop เดิมของโปรเจกต์คือ min(ราคา − 1.5×ATR, swingLow − 0.15×ATR)
// Math.min = เลือกราคาที่ "ต่ำกว่า" = stop ที่ "กว้างกว่า" (ปลอดภัยจากสัญญาณรบกวน
// แต่เสีย R:R) ซึ่งเป็นการตั้งค่าแบบ day trade
//
// ผลคือ: ระยะ stop ≈ 1.5 ATR แต่ระยะถึงเป้า ≈ 0.5 ATR → R:R ≈ 0.33 เสมอ
// จะได้ R:R ถึง 1.5 ต้องให้แนวต้านห่าง ≥ 2.25 ATR ซึ่งเป็นช่วงที่ปัจจัย (ก) ให้คะแนนต่ำ
// → หุ้นที่คะแนนดีจะตกตัวกรอง R:R ทุกตัว เครื่องมือขัดขากันเอง ไม่มีสัญญาณออกเลย
//
// แก้ 2 จุด:
//   1) stop ใช้ Math.max (เลือกตัวที่ "แคบกว่า" ระหว่าง ATR stop กับ structure stop)
//      เพราะ scalping ถือสั้น ไม่ต้องเผื่อการแกว่งข้ามวัน — แต่มีพื้นขั้นต่ำ
//      (minStopAtr) กันไม่ให้ stop แคบจนโดนสัญญาณรบกวนเคาะออก
//   2) เป้าของ R:R ขยายเลยแนวต้านไปตามระยะ targetExtAtr
//      เพราะการเล่นจริงคือ "เข้าก่อนแนวต้าน → แนวต้านแตก → ราคาวิ่งต่อ"
//      ถ้าตั้งเป้าไว้ที่แนวต้านพอดี ก็คือไม่ได้กำไรจากการเบรกเลย
//
// ค่าทั้งหมดปรับได้ในหน้า Settings
export function riskReward({
  price, atrValue, swingLow, support = null, target,
  atrStopMult = 1.0,       // ระยะ stop สูงสุดเป็นเท่าของ ATR (ของ timeframe ที่สแกน)
  minStopAtr = 0.35,       // ระยะ stop ขั้นต่ำเป็นเท่าของ ATR
  minStopPct = 0.6,        // ★ v2: ระยะ stop ขั้นต่ำเป็น % ของราคา — ดูเหตุผลด้านล่าง
  targetExtAtr = 1.0,      // ขยายเป้าเลยแนวต้านไปกี่เท่าของ ATR (ใช้เมื่อ basis = intraday)
  costPct = 0.10,          // ★ v2: ต้นทุนไป-กลับนอกเหนือจาก spread (คอมมิชชัน + slippage) เป็น % ของราคา
  spreadPct = null,        // ★ v2: spread จริงจาก quote — เข้า+ออก = เสีย spread เต็ม 1 ครั้ง
  dailyAtrValue = null,    // ★ v2: ATR(14) ของแท่งรายวัน
  tradeAtrBasis = 'daily', // ★ v2: 'daily' = วัด stop/เป้าด้วย ATR รายวัน · 'intraday' = แบบ v1
  stopAtrDaily = 0.35,     // ★ v2: stop = กี่เท่าของ ATR รายวัน
  targetAtrDaily = 1.0,    // ★ v2: เป้า = กี่เท่าของ ATR รายวัน
}) {
  if (!Number.isFinite(price) || !Number.isFinite(atrValue) || atrValue <= 0) {
    return { ok: false, reason: 'คำนวณ ATR ไม่ได้' };
  }

  // ═══ ★ v2: "หน่วยของไม้" คือหัวใจของเรื่องนี้ ═══
  //
  // v1 วัดทั้ง stop และเป้าด้วย ATR ของแท่ง 5 นาที ซึ่งเป็นหน่วยที่เล็กมาก
  // (AAPL: ATR(5m) = $1.03 บนราคา $171 = 0.6% — และ stop ใช้แค่ 0.35 เท่าของนั้น = 0.21%)
  //
  // ผลคือทั้งไม้ถูกบีบให้อยู่ในกรอบ 5 นาที: ชนะก็ได้ 0.3% แพ้ก็เสีย 0.2%
  // ซึ่งคือคำอธิบายทั้งหมดของอาการ "กำไรต่อไม้น้อย" — ไม่เกี่ยวกับการเลือกหุ้นเลย
  //
  // v2 วัดด้วย ATR รายวัน: ถามว่า "หุ้นตัวนี้ปกติวิ่งวันละเท่าไหร่" แล้วตั้ง stop ที่เศษส่วนหนึ่งของนั้น
  // และตั้งเป้าที่อีกเศษส่วนหนึ่ง เป็นการยืดกรอบเวลาของไม้จาก "นาที" เป็น "ชั่วโมงถึงวัน"
  //
  // กันพลาด: หน่วยของไม้ต้องไม่เล็กกว่า ATR ของ timeframe ที่กำลังดูอยู่
  // (เกิดได้กับหุ้นที่วันนี้เหวี่ยงผิดปกติเทียบกับค่าเฉลี่ยรายวัน)
  const useDaily = tradeAtrBasis === 'daily' && Number.isFinite(dailyAtrValue) && dailyAtrValue > 0;
  const riskUnit = useDaily ? Math.max(dailyAtrValue, atrValue) : atrValue;
  const stopMult = useDaily ? stopAtrDaily : atrStopMult;
  const targetMult = useDaily ? targetAtrDaily : targetExtAtr;

  // ---------- จุดตัดขาดทุน ----------
  const atrStop = price - stopMult * riskUnit;

  // structure stop = ใต้แนวรับที่ยืนยันแล้ว ถ้าไม่มีก็ใช้ swing low ของ 6 แท่งล่าสุด
  const structureRef = Number.isFinite(support) ? support : swingLow;
  const structureStop = Number.isFinite(structureRef) ? structureRef - 0.15 * atrValue : -Infinity;

  // เลือกตัวที่แคบกว่า (ราคาสูงกว่า) — ต่างจากโค้ดเดิมที่ใช้ min
  let stop = Math.max(atrStop, structureStop);

  // ═══ ★ v2: พื้นขั้นต่ำของ stop มี 2 เกณฑ์ ต้องผ่านทั้งคู่ ═══
  //
  // เกณฑ์เดิมคือ minStopAtr × ATR เท่านั้น ซึ่ง "ATR" ที่ส่งเข้ามาคือ ATR ของแท่ง 5 นาที
  // ปัญหาที่เจอจริงใน data/signals-history.json:
  //   AAPL @ $171.65 · ATR(5m) = $1.03 · stop = 0.35 × 1.03 = $0.36 = 0.21% ของราคา
  //   → ทั้งไม้ (stop ถึงเป้า) กินพื้นที่แค่ 0.2-0.6% ซึ่งอยู่ "ใน" สัญญาณรบกวนของแท่งเดียว
  //   → spread 0.082% ไป-กลับ กินกำไรขั้นต้นไป 15% ก่อนคิดคอมมิชชันและ slippage
  //   → นี่คือสาเหตุเชิงคณิตศาสตร์ของอาการ "กำไรต่อไม้น้อย" ไม่ใช่เรื่องการเลือกหุ้น
  //
  // minStopPct บังคับว่า 1R ต้องมีขนาดเป็นเนื้อเป็นหนังก่อน ถึงจะยอมให้เปิดไม้
  // ผลที่ตามมา (ตั้งใจ): จำนวนหุ้นลดลงตามสัดส่วน → เงินที่เสี่ยงต่อไม้ "เท่าเดิม"
  //   แต่ 1R มีค่ามากขึ้น → กำไรเมื่อชนะเป็นตัวเงินมากขึ้น และต้นทุนเป็นสัดส่วนน้อยลง
  //   ตัวอย่างเดียวกัน: stop 0.6% → risk $1.03/หุ้น → 97 หุ้น (จาก 276) ความเสี่ยงยังคง $100
  //   แต่เป้า 2R = เคลื่อนไหว 1.2% แทน 0.42% → spread กินแค่ 7% ของกำไรแทน 15%
  const minStopDistance = Math.max(minStopAtr * atrValue, (minStopPct / 100) * price);
  if (price - stop < minStopDistance) stop = price - minStopDistance;

  const risk = price - stop;
  if (risk <= 0) return { ok: false, reason: 'จุดตัดขาดทุนคำนวณไม่ได้ (risk ≤ 0)' };

  // ═══ ★ v2: ต้นทุนการซื้อขายจริง ═══
  // เข้าซื้อจ่าย ask ออกขายรับ bid → เสีย spread เต็ม 1 ครั้งต่อรอบ
  // บวกคอมมิชชัน + slippage ที่ตั้งไว้ใน Settings
  const effSpreadPct = Number.isFinite(spreadPct) && spreadPct > 0 ? spreadPct : 0;
  const totalCostPct = effSpreadPct + costPct;
  const costPerShare = (totalCostPct / 100) * price;

  // ---------- เป้ากำไร ----------
  // ★ v2: แยก "จุดเข้า" ออกจาก "เป้า" ให้ชัด
  //   แนวต้านคือ *ตัวจุดชนวน* (จุดที่บอกว่าเข้าเมื่อไหร่) ไม่ใช่ *เป้า*
  //   เป้าคือระยะการเคลื่อนไหวที่วัดจากพฤติกรรมจริงของหุ้น (ATR รายวัน)
  //
  //   - ถ้ายังมีแนวต้านขวางอยู่เหนือจุดเข้า (โหมด anticipate) → เป้า = แนวต้าน + ครึ่งหนึ่งของระยะที่วัดได้
  //     (ต้องเผื่อว่าแนวต้านอาจเอาไม่อยู่ จึงไม่ตั้งเป้าไกลเท่ากรณีที่ทางโล่ง)
  //   - ถ้าไม่มีอะไรขวางแล้ว (โหมด confirm ที่ทะลุไปแล้ว) → เป้า = ระยะที่วัดได้เต็มๆ จากจุดเข้า
  const targetAtResistance = Number.isFinite(target) ? target : null;
  // แนวต้าน "ขวางอยู่" ก็ต่อเมื่อมันอยู่เหนือจุดเข้า
  // ในโหมด confirm จุดเข้าอยู่เหนือแนวต้านที่แตกแล้ว → ไม่ถือว่าขวาง (ไม่ใช่ข้อผิดพลาด)
  const overhead = Number.isFinite(targetAtResistance) && targetAtResistance > price;
  const measuredMove = targetMult * riskUnit;
  const targetBreakout = overhead
    ? targetAtResistance + measuredMove * 0.5
    : price + measuredMove;

  if (!Number.isFinite(targetBreakout) || targetBreakout <= price) {
    return { ok: false, stop, risk, reason: 'คำนวณราคาเป้าหมายไม่ได้ (ATR หรือแนวต้านใช้ไม่ได้)' };
  }

  const grossReward = targetBreakout - price;

  // ═══ ★ v2: R:R "สุทธิ" คือตัวที่ใช้ตัดสิน ═══
  // ชนะจริงได้ = กำไรขั้นต้น − ต้นทุน
  // แพ้จริงเสีย = ระยะ stop + ต้นทุน  (โดนตัดขาดทุนก็ยังต้องจ่าย spread/คอม)
  // การคิดแบบนี้ทำให้ไม้ที่เป้าใกล้จนต้นทุนกินหมด "ตกตัวกรอง R:R เอง" โดยไม่ต้องเพิ่มด่านใหม่
  const riskNet = risk + costPerShare;
  const rewardNet = grossReward - costPerShare;
  const rr = rewardNet > 0 ? rewardNet / riskNet : 0;

  // ตัวเลขขั้นต้น (ไม่หักต้นทุน) — แสดงคู่กันเพื่อให้เห็นว่าต้นทุนกินไปเท่าไหร่
  const rrGross = grossReward / risk;
  const rrConservative = overhead ? (targetAtResistance - price - costPerShare) / riskNet : null;

  const rewardPctOfPrice = (grossReward / price) * 100;
  const costShareOfReward = grossReward > 0 ? (costPerShare / grossReward) * 100 : 100;

  return {
    ok: true,
    stop,
    risk,                 // ระยะ stop บนกราฟ (ไม่รวมต้นทุน)
    riskNet,              // ★ v2: ขาดทุนจริงต่อหุ้นเมื่อโดน stop (รวมต้นทุน) — ใช้คำนวณขนาดไม้
    reward: grossReward,
    rewardNet,            // ★ v2
    costPerShare,         // ★ v2
    totalCostPct,         // ★ v2
    rr,                   // ★ v2: สุทธิแล้ว — ตัวนี้คือตัวที่ถูกกรองด้วย minRR
    rrGross,              // ★ v2: ก่อนหักต้นทุน (ตัวเลขเดิมของ v1)
    rrConservative,
    targetAtResistance,
    targetBreakout,
    rewardPctOfPrice,     // ★ v2: เป้าห่างจากราคาเข้ากี่ % — ตัวชี้วัด "ไม้ใหญ่พอไหม"
    costShareOfReward,    // ★ v2: ต้นทุนกินกำไรขั้นต้นไปกี่ %
    label: `1:${rr.toFixed(2)}`,
    labelGross: `1:${rrGross.toFixed(2)}`,
    labelConservative: Number.isFinite(rrConservative) ? `1:${rrConservative.toFixed(2)}` : '—',
    stopBasis: (price - stop) <= minStopDistance * 1.0001
      ? ((minStopPct / 100) * price >= minStopAtr * atrValue
        ? `พื้นขั้นต่ำ ${minStopPct}% ของราคา`
        : `พื้นขั้นต่ำ ${minStopAtr}×ATR(${tradeAtrBasis === 'daily' ? 'intraday' : 'tf'})`)
      : (atrStop >= structureStop
        ? `${stopMult}×ATR${useDaily ? ' รายวัน' : ''}`
        : 'ใต้แนวรับ/แนวต้านที่แตกแล้ว'),
    stopFloored: price - stop <= minStopDistance * 1.0001,
    costNote: `ต้นทุนไป-กลับ ${totalCostPct.toFixed(3)}% = $${costPerShare.toFixed(3)}/หุ้น` +
              (effSpreadPct > 0 ? ` (spread ${effSpreadPct.toFixed(3)}% + คอม/slippage ${costPct}%)` : ` (คอม/slippage ${costPct}% · ไม่มีข้อมูล spread)`) +
              ` — กินกำไรขั้นต้นไป ${costShareOfReward.toFixed(1)}%`,
    riskUnit,
    riskUnitBasis: useDaily ? 'daily' : 'intraday',
    measuredMove,
    note: (overhead
        ? `เป้า $${targetBreakout.toFixed(2)} = แนวต้าน $${targetAtResistance.toFixed(2)} + ครึ่งหนึ่งของระยะที่วัดได้ ($${(measuredMove / 2).toFixed(2)})`
        : `เป้า $${targetBreakout.toFixed(2)} = จุดเข้า $${price.toFixed(2)} + ${targetMult}×ATR${useDaily ? 'รายวัน' : ''} ($${measuredMove.toFixed(2)}) — ทางโล่งเหนือแนวต้านที่แตกแล้ว`) +
      ` · เคลื่อนไหว ${rewardPctOfPrice.toFixed(2)}% · R:R ก่อนหักต้นทุน 1:${rrGross.toFixed(2)} → สุทธิ 1:${rr.toFixed(2)}`,
  };
}

// ═══════════════ Position Size ═══════════════
// จำนวนหุ้น = (เงินทุน × %ความเสี่ยง ÷ ความเสี่ยงต่อหุ้น) × ตัวคูณตามภาวะตลาด
// ★ lotSize: หุ้นไทยซื้อขายทีละ 100 หุ้น (1 board lot) → ปัดลงเป็นทวีคูณของ 100
export function positionSize({ accountSize, riskPct, riskPerShare, sizeMult = 1, price, lotSize = 1 }) {
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
    return { shares: 0, riskAmount: 0, cost: 0, note: 'คำนวณความเสี่ยงต่อหุ้นไม่ได้' };
  }

  const dollarRisk = accountSize * (riskPct / 100);
  const lot = Number.isFinite(lotSize) && lotSize > 1 ? Math.floor(lotSize) : 1;
  const rawShares = (dollarRisk / riskPerShare) * sizeMult;
  const shares = Math.floor(rawShares / lot) * lot;

  if (shares <= 0) {
    return {
      shares: 0, riskAmount: 0, cost: 0,
      note: lot > 1
        ? `ความเสี่ยงของไม้ขั้นต่ำ ${lot} หุ้น ($${(riskPerShare * lot).toFixed(2)}) สูงเกินงบความเสี่ยงที่ตั้งไว้ ($${(dollarRisk * sizeMult).toFixed(2)}) — ขนาดไม้ออกมาเป็น 0`
        : `ความเสี่ยงต่อหุ้น ($${riskPerShare.toFixed(2)}) สูงเกินงบความเสี่ยงที่ตั้งไว้ ($${dollarRisk.toFixed(2)}) — ขนาดไม้ออกมาเป็น 0`,
    };
  }

  return {
    shares,
    riskAmount: shares * riskPerShare,
    cost: Number.isFinite(price) ? shares * price : null,
    budgetRisk: dollarRisk,
    sizeMult,
    note: `เสี่ยง ${riskPct}% ของทุน $${accountSize.toLocaleString()} = $${dollarRisk.toFixed(2)}` +
          (sizeMult !== 1 ? ` × ตัวคูณภาวะตลาด ${sizeMult}` : '') +
          (lot > 1 ? ` · ปัดลงเป็นทวีคูณของ ${lot} หุ้น (1 lot)` : ''),
  };
}

// ═══════════════ ตัวหลัก: คำนวณคะแนนรวม ═══════════════
// ctx = ผลลัพธ์ที่ scanner เตรียมมาให้ (rvol, atrPct, resistance, momentum, news, liquidity)
// weights = น้ำหนักจากหน้า Settings
// renormalize = true → เกลี่ยน้ำหนักของปัจจัยที่ไม่มีข้อมูล ไปให้ปัจจัยที่มีข้อมูล
//               false → ปัจจัยที่ไม่มีข้อมูลได้ 50 คะแนนกลางๆ (default)
export function computeScore(ctx, weights, opts = {}) {
  const { renormalize = false, atrPctLow = 1.5, atrPctHigh = 3.0 } = opts;

  const factors = {
    rvol: { label: 'Relative Volume (RVOL)', weight: weights.rvol, ...scoreRvol(ctx.rvol) },
    // ใช้ ctx.dailyAtrPct (ATR% เทียบเท่ารายวัน) ไม่ใช่ ATR% ของแท่ง intraday — ดูเหตุผลที่ scoreVolatility
    volatility: { label: 'ATR% / ความผันผวน (ต่อวัน)', weight: weights.volatility, ...scoreVolatility(ctx.dailyAtrPct, atrPctLow, atrPctHigh) },
    resistance: { label: 'ระยะห่างจากแนวต้าน', weight: weights.resistance, ...scoreResistance(ctx.resistance) },
    momentum: { label: 'Momentum', weight: weights.momentum, ...scoreMomentum(ctx.momentum || {}) },
    sentiment: { label: 'News Sentiment', weight: weights.sentiment, ...scoreSentiment(ctx.news) },
    liquidity: { label: 'Spread / สภาพคล่อง', weight: weights.liquidity, ...scoreLiquidity(ctx.liquidity || {}) },
  };

  const keys = Object.keys(factors);

  // ปัจจัยที่ normalized เป็น null คือคำนวณไม่ได้เลย (ต่างจาก sentiment ที่ให้ 50 กลางๆ)
  const usable = keys.filter((k) => Number.isFinite(factors[k].normalized));
  const missing = keys.filter((k) => !Number.isFinite(factors[k].normalized));

  // น้ำหนักที่ใช้จริง
  let effectiveWeights = {};
  if (renormalize && usable.length > 0) {
    const totalUsable = usable.reduce((a, k) => a + (factors[k].weight || 0), 0);
    for (const k of keys) {
      effectiveWeights[k] = usable.includes(k) && totalUsable > 0
        ? ((factors[k].weight || 0) / totalUsable) * 100
        : 0;
    }
  } else {
    for (const k of keys) effectiveWeights[k] = factors[k].weight || 0;
  }

  // รวมคะแนน
  let score = 0;
  let weightUsed = 0;
  for (const k of keys) {
    const f = factors[k];
    const w = effectiveWeights[k];
    f.effectiveWeight = Math.round(w * 10) / 10;

    if (!Number.isFinite(f.normalized)) {
      f.contribution = 0;
      f.skipped = true;
      continue;
    }
    f.contribution = Math.round((f.normalized * w / 100) * 10) / 10;
    score += f.normalized * w / 100;
    weightUsed += w;
  }

  // ถ้าไม่ renormalize และมีปัจจัยที่คำนวณไม่ได้ คะแนนเต็มจะไม่ถึง 100
  // ต้องบอก user ให้ชัดว่าคะแนนนี้มาจากน้ำหนักเท่าไหร่ของทั้งหมด
  const finalScore = Math.round(clamp100(score) * 10) / 10;

  // เรียง breakdown จากปัจจัยที่มีผลมากไปน้อย (ให้ user เห็นทันทีว่าคะแนนมาจากไหน)
  const breakdown = keys
    .map((k) => ({ key: k, ...factors[k] }))
    .sort((a, b) => b.contribution - a.contribution);

  return {
    score: finalScore,
    breakdown,
    weightUsed: Math.round(weightUsed * 10) / 10,
    missingFactors: missing,
    unavailableData: keys.filter((k) => factors[k].available === false),
    renormalized: renormalize,
    // สรุปเหตุผลสั้นๆ 2-3 ข้อที่ส่งผลมากที่สุด — ใช้แสดงในคอลัมน์ "ทำไม" ของตาราง
    topReasons: breakdown
      .filter((f) => f.contribution > 0 && f.available !== false)
      .slice(0, 3)
      .map((f) => f.why),
  };
}
