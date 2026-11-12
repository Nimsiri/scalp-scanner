// src/providers/mock.js — แหล่งข้อมูลจำลอง (ไม่ต่ออินเทอร์เน็ต)
//
// ทำไมต้องมี:
//   1) ให้ `npm test` รันได้เสมอ ไม่ต้องมี API key ไม่ต้องรออินเทอร์เน็ต ผลเหมือนกันทุกครั้ง
//   2) ให้ทดลองหน้าเว็บ/ปุ่ม/เสียงเตือน ได้ตอนตลาดปิด (กลางคืนเวลาไทย)
//   3) ผู้พัฒนาทดสอบ pipeline ได้โดยไม่เผาโควตา API ฟรี
//
// เปิดใช้: ตั้ง MOCK_DATA=true ใน .env หรือรัน `npm run demo`
// เมื่อเปิด mock จะถูกใส่ไว้ "หน้าสุด" ของทุก fallback chain
//
// ⚠️ ข้อมูลจำลองไม่ใช่ราคาจริง ห้ามใช้ตัดสินใจเทรด — UI จะขึ้นแบนเนอร์เตือนตลอดเวลาที่เปิดโหมดนี้

import { QuotaTracker, TF_MINUTES } from './_shared.js';

const quota = new QuotaTracker({ perMinute: null, perDay: null });

// ---------- ตัวสุ่มแบบมี seed (ผลเหมือนกันทุกครั้งที่รัน = test ไม่ flaky) ----------
function makeRng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function rng() {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

// ราคาฐานของแต่ละ symbol — คงที่ตามชื่อ เพื่อให้ผลลัพธ์ซ้ำได้
function basePrice(symbol) {
  const rng = makeRng(`base:${symbol}`);
  return 20 + rng() * 280; // $20-$300
}

// ---------- สร้างแท่งเทียนจำลอง ----------
// ออกแบบให้มีลักษณะที่ระบบต้องเจอในชีวิตจริง:
//   - มี "แนวต้าน" ชัดเจน (ราคาชนแล้วเด้งกลับหลายครั้ง) เพื่อทดสอบ levels.js
//   - วอลุ่มสูงช่วงเปิด-ปิดตลาด (U-shape) เพื่อทดสอบ RVOL time-of-day
//   - ปิดท้ายให้ราคาอยู่ "ใกล้แต่ยังไม่ถึง" แนวต้าน เพื่อทดสอบการแจ้งเตือน
function genBars(symbol, tf, days) {
  const tfMin = TF_MINUTES[tf] || (tf === '1d' ? 1440 : 5);
  const rng = makeRng(`bars:${symbol}:${tf}`);
  const base = basePrice(symbol);

  const isDaily = tfMin >= 1440;
  const barsPerDay = isDaily ? 1 : Math.floor((6.5 * 60) / tfMin); // regular session 6.5 ชม.
  const nDays = Math.max(1, Math.min(days, isDaily ? 300 : 12)); // v2: ขยายจาก 60 เป็น 300 เพื่อให้ทดสอบ Trend Template (ต้องใช้ SMA200) ได้ในโหมดจำลอง
  const total = barsPerDay * nDays;

  // แนวต้านตั้งไว้ที่ +2.5% จากราคาฐาน — ราคาจะพยายามชนแต่ผ่านไม่ได้
  const resistance = base * 1.025;

  // ความผันผวนต่อแท่งต่างกันตามสัญลักษณ์ (0.15%-0.55%) เพื่อให้ได้หุ้นหลากหลายแบบ
  const volRng = makeRng(`vol:${symbol}`);
  const atrTarget = base * (0.0015 + volRng() * 0.004);

  // ราคาจบที่ไหน — ต่างกันตามสัญลักษณ์ เพื่อให้ทดสอบได้ทั้งกรณี R:R ผ่านและไม่ผ่าน
  //   pinned  = ติดแนวต้าน (R:R จะต่ำ → ถูกกรองออก ทดสอบตัวกรอง)
  //   midway  = อยู่กลางทาง (R:R ดี → เป็นสัญญาณได้ ทดสอบการแจ้งเตือน)
  //   broken  = ทะลุแนวต้านไปแล้ว (ทดสอบ path 'projected')
  const shapeRng = makeRng(`shape:${symbol}`);
  const shapeRoll = shapeRng();

  // ★ v2: แท่งรายวันของเดิมเป็น random walk แบนราบ (ATR รายวัน ≈ ATR ของแท่ง 5 นาที)
  // ซึ่งไม่เหมือนหุ้นจริงเลย และทำให้ทดสอบ Trend Template / เป้าที่วัดจาก ATR รายวันไม่ได้
  //
  // แท่งรายวันจึงสร้างแบบ "เส้นแนวโน้ม + การแกว่งที่ดึงกลับเข้าหาเส้น"
  // ไม่ใช่ random walk อิสระ เพราะ random walk ที่มี drift จะทบต้นจนราคาหลุดโลกเมื่อสร้าง 300 แท่ง
  const trendRng = makeRng(`dtrend:${symbol}`);
  const totalTrend = -0.30 + trendRng() * 1.20;   // ผลตอบแทนรวมตลอดช่วง: −30% ถึง +90%
  const dailyVolPct = 0.010 + trendRng() * 0.012; // ความผันผวนต่อวัน 1.0%-2.2%
  const dailyEndPx = resistance * (0.994 + trendRng() * 0.012);
  const dailyStartPx = dailyEndPx / (1 + totalTrend);
  let wander = 0;
  const shape = shapeRoll < 0.45 ? 'midway' : (shapeRoll < 0.85 ? 'pinned' : 'broken');
  const endFactor = shape === 'midway' ? 0.978 + shapeRng() * 0.008   // 97.8%-98.6% ของแนวต้าน
                  : shape === 'pinned' ? 0.994 + shapeRng() * 0.004   // 99.4%-99.8%
                  : 1.004 + shapeRng() * 0.006;                       // ทะลุไปแล้ว

  const out = [];
  let price = base;
  const now = Date.now();

  for (let i = 0; i < total; i++) {
    // ไล่เวลาจากอดีตมาปัจจุบัน
    const barsFromEnd = total - 1 - i;
    const date = new Date(now - barsFromEnd * tfMin * 60_000);

    // แรงดึงกลับเมื่อชนแนวต้าน (mean reversion แรงขึ้นเมื่อใกล้/เกินแนวต้าน)
    const distToRes = (resistance - price) / resistance;
    const pull = distToRes < 0.002 ? -0.6 : 0.05; // ใกล้แนวต้าน = ถูกกดลง

    const open = price;
    let close;
    let unit;

    if (isDaily) {
      // เส้นแนวโน้มแบบทบต้นจาก start → end (ทำให้ 52w high/low และความชัน SMA สมเหตุสมผล)
      const t = total <= 1 ? 1 : i / (total - 1);
      const trendPx = dailyStartPx * Math.pow(dailyEndPx / dailyStartPx, t);
      // การแกว่งรอบเส้น แบบดึงกลับ (ตัวคูณ 0.85) → ความผันผวนไม่ระเบิดเมื่อสร้างหลายร้อยแท่ง
      wander = wander * 0.85 + (rng() - 0.5) * 2 * dailyVolPct;
      close = trendPx * (1 + wander);
      unit = close * dailyVolPct;
    } else {
      unit = atrTarget;
      const drift = pull * atrTarget;
      const shock = (rng() - 0.5) * 2 * atrTarget;
      close = Math.max(base * 0.35, open + drift + shock);
    }

    // ช่วงท้ายสุด ดันราคาไปยังตำแหน่งที่ shape กำหนด
    if (barsFromEnd < 3 && !isDaily) {
      close = resistance * endFactor;
    }
    // ★ v2: แท่งรายวันแท่งสุดท้ายปิดที่ราคาเดียวกับกรอบ intraday (ไม่งั้นสองกรอบเวลาขัดกัน)
    if (barsFromEnd === 0 && isDaily) close = dailyEndPx;

    const wick = unit * (0.3 + rng() * 0.7); // ★ v2
    const high = Math.max(open, close) + wick * rng();
    const low = Math.min(open, close) - wick * rng();

    // วอลุ่มรูป U: เปิดตลาดและปิดตลาดคึกคัก กลางวันเงียบ
    const slot = isDaily ? 0.5 : (i % barsPerDay) / Math.max(1, barsPerDay - 1);
    const uShape = 1 + 2.2 * (Math.pow(slot - 0.5, 2) * 4);
    // แท่งท้ายสุดวอลุ่มพุ่ง เพื่อให้ RVOL สูง (ทดสอบคะแนน RVOL)
    const spike = barsFromEnd < 2 ? 2.6 : 1;
    const volume = Math.round(400_000 * uShape * spike * (0.7 + rng() * 0.6));

    out.push({ date, open, high, low, close, volume });
    price = close;
  }

  return { bars: out, resistance, base, shape, atrTarget };
}

const enabled = () => String(process.env.MOCK_DATA || '').toLowerCase() === 'true' || process.env.MOCK_DATA === '1';

export default {
  id: 'mock',
  name: 'ข้อมูลจำลอง (Mock)',
  capabilities: ['quote', 'bars', 'earnings', 'news', 'screener', 'fundamentals', 'fx'], // ★ v2.1
  requiresKey: null,
  limits: { perMinute: null, perDay: null },
  notes: '⚠️ ข้อมูลจำลองสำหรับทดสอบเท่านั้น ไม่ใช่ราคาจริง — เปิดด้วย MOCK_DATA=true',

  isConfigured() { return enabled(); },
  setKey() {},
  getQuota() { return quota.snapshot(); },
  _quota: quota,

  async quote(symbol) {
    quota.countCall();
    // สัญลักษณ์ที่จงใจให้ "ไม่พบ" เพื่อทดสอบ validate ของ watchlist
    if (/^(ZZ|XXX|INVALID)/i.test(symbol)) {
      quota.countError(new Error('not found'));
      throw new Error(`Mock: ไม่พบสัญลักษณ์ ${symbol}`);
    }
    const { bars } = genBars(symbol, '5m', 3);
    const last = bars[bars.length - 1];
    const prevDayClose = bars[Math.max(0, bars.length - 79)]?.close ?? last.close;
    quota.countSuccess();
    return {
      symbol,
      price: Number(last.close.toFixed(2)),
      // ให้ bid/ask ห่างกัน ~0.08% เพื่อให้ปัจจัย spread คำนวณได้
      bid: Number((last.close * 0.9996).toFixed(2)),
      ask: Number((last.close * 1.0004).toFixed(2)),
      prevClose: Number(prevDayClose.toFixed(2)),
      changePct: ((last.close - prevDayClose) / prevDayClose) * 100,
      volume: last.volume * 78,
      avgVolume: 30_000_000,
      ts: Date.now(),
      source: 'mock',
    };
  },

  // ---------- ★ v2.1: อัตราแลกเปลี่ยนจำลอง ----------
  // สร้างเป็น "แนวโน้มช้า + การแกว่งที่ดึงกลับ" แบบเดียวกับแท่งรายวัน
  // ตั้งใจให้ช่วงของ USD/THB อยู่ราว 31-37 บาท ซึ่งเป็นกรอบที่สมจริง
  // และให้เรตล่าสุดอยู่ค่อนไปทางต่ำของกรอบ เพื่อให้ทดสอบเส้นทาง "ควรแลกบาทเป็นดอลลาร์" ได้
  async fx(pair, days = 400) {
    quota.countCall();
    const rng = makeRng(`fx:${pair}`);
    const n = Math.max(60, Math.min(days, 400));
    const mid = 34.0;
    const history = [];
    let wander = 0;
    const now = Date.now();
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // แนวโน้มรูปโค้ง: ขึ้นไปสูงกลางช่วงแล้วย่อลงมาช่วงท้าย
      const trend = mid * (1 + 0.045 * Math.sin(Math.PI * t) - 0.02 * t);
      wander = wander * 0.9 + (rng() - 0.5) * 2 * 0.004;
      history.push({
        date: new Date(now - (n - 1 - i) * 86_400_000),
        rate: Number((trend * (1 + wander)).toFixed(4)),
      });
    }
    quota.countSuccess();
    const last = history[history.length - 1];
    return { pair: String(pair).toUpperCase(), symbol: `MOCK:${pair}`, rate: last.rate, ts: last.date.getTime(), history, source: 'mock' };
  },

  async bars(symbol, tf, days = 30) {
    quota.countCall();
    if (/^(ZZ|XXX|INVALID)/i.test(symbol)) {
      quota.countError(new Error('not found'));
      throw new Error(`Mock: ไม่พบสัญลักษณ์ ${symbol}`);
    }
    const { bars } = genBars(symbol, tf, days);
    quota.countSuccess();
    return {
      symbol,
      tf,
      bars,
      meta: {
        previousClose: Number((bars[Math.max(0, bars.length - 79)]?.close ?? bars[0].close).toFixed(2)),
        tfMinutes: TF_MINUTES[tf] || null,
      },
      source: 'mock',
    };
  },

  async earnings(symbol) {
    quota.countCall();
    quota.countSuccess();
    // ให้บางตัวมีงบใกล้ๆ เพื่อทดสอบการเตือน event risk
    const rng = makeRng(`earn:${symbol}`);
    const d = Math.floor(rng() * 30) - 2;
    if (d < 0) return { symbol, earningsDate: null, daysUntil: null, source: 'mock' };
    return {
      symbol,
      earningsDate: new Date(Date.now() + d * 86_400_000).toISOString(),
      daysUntil: d,
      source: 'mock',
    };
  },

  async news(symbol) {
    quota.countCall();
    quota.countSuccess();
    const rng = makeRng(`news:${symbol}`);
    const s = (rng() - 0.4) * 1.2; // เอียงบวกเล็กน้อย ช่วง −0.48..+0.72
    const sentiment = Math.max(-1, Math.min(1, s));
    return {
      symbol,
      sentiment,
      articleCount: 1 + Math.floor(rng() * 8),
      headlines: [
        { title: `[ข้อมูลจำลอง] ข่าวทดสอบเกี่ยวกับ ${symbol}`, url: null, ts: Date.now() - 3_600_000 },
      ],
      estimated: false,
      source: 'mock',
    };
  },

  async screener(scrId, count = 30) {
    quota.countCall();
    quota.countSuccess();
    const pool = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'META', 'AMZN', 'GOOGL', 'NFLX', 'INTC',
                  'COIN', 'PLTR', 'SOFI', 'RIVN', 'MARA', 'RIOT', 'SMCI', 'ARM', 'AVGO', 'MU'];
    const rng = makeRng(`scr:${scrId}`);
    return pool.slice(0, Math.min(count, pool.length)).map((symbol) => ({
      symbol,
      price: Number(basePrice(symbol).toFixed(2)),
      changePct: (rng() - 0.3) * 12,
      volume: Math.round(5_000_000 + rng() * 50_000_000),
      avgVolume: 30_000_000,
      scrId,
    }));
  },

  async fundamentals(symbol) {
    quota.countCall();
    quota.countSuccess();
    const rng = makeRng(`fund:${symbol}`);
    return {
      symbol,
      floatShares: Math.round(10_000_000 + rng() * 500_000_000),
      floatPct: 60 + rng() * 39,
      sharesOutstanding: Math.round(500_000_000 + rng() * 1_000_000_000),
      shortPct: rng() * 25,
      shortRatio: rng() * 6,
      source: 'mock',
    };
  },

  // export ไว้ให้ test ใช้ตรวจว่า levels.js หาแนวต้านได้ตรงกับที่จำลองไว้
  _debugResistance(symbol, tf = '5m') {
    return genBars(symbol, tf, 3).resistance;
  },

  // สำหรับ test: ดูว่า symbol นี้ถูกจำลองเป็นแบบไหน (midway / pinned / broken)
  _debugShape(symbol, tf = '5m') {
    return genBars(symbol, tf, 3).shape;
  },
};

export { enabled as mockEnabled };
