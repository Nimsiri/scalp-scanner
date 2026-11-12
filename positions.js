// positions.js — จัดการไม้ที่เปิดอยู่ เช็คเงื่อนไขออกไม้ และควบคุมความเสี่ยงรายวัน
import { CFG, nyDateKey, nyNow } from './config.js';
import { getQuote, getBars } from './datafeed.js';
import { ema, sessionVwap } from './indicators.js';
import { logEvent } from './journal.js';

// เก็บไม้ที่เปิดอยู่ key = "SYMBOL:TF"
const positions = new Map();

// สถิติรายวัน — reset อัตโนมัติเมื่อวันที่ (ตามเขตเวลา New York) เปลี่ยน
let dayState = { key: nyDateKey(), realizedR: 0, alerts: 0, losses: 0 };

function ensureDay() {
  const key = nyDateKey();
  if (dayState.key !== key) {
    dayState = { key, realizedR: 0, alerts: 0, losses: 0 };
  }
}

// เช็คว่าอนุญาตให้เปิดไม้ใหม่/ส่งสัญญาณใหม่ได้หรือไม่ คืน {ok, why} (why เป็นภาษาไทย)
export function guard() {
  ensureDay();

  if (dayState.realizedR <= -CFG.dailyLossLimitR) {
    return { ok: false, why: `ขาดทุนสะสมวันนี้เกินลิมิตที่ตั้งไว้ (${CFG.dailyLossLimitR}R) หยุดส่งสัญญาณเพื่อป้องกันความเสียหายเพิ่ม` };
  }
  if (dayState.alerts >= CFG.maxAlertsPerDay) {
    return { ok: false, why: `ส่งแจ้งเตือนครบโควตาวันนี้แล้ว (${CFG.maxAlertsPerDay} ครั้ง)` };
  }
  if (positions.size >= CFG.maxOpenPositions) {
    return { ok: false, why: `มีไม้เปิดอยู่ครบจำนวนสูงสุดแล้ว (${CFG.maxOpenPositions} ไม้)` };
  }
  if (CFG.session === 'regular' && nyNow().minutes >= 930) {
    return { ok: false, why: 'เลยเวลา 15:30 น. (ET) แล้ว งดเปิดไม้ใหม่ในโหมด regular session' };
  }
  return { ok: true, why: null };
}

// เพิ่มไม้ใหม่จากสัญญาณที่ผ่านการคัดกรองแล้ว
export function track(signal) {
  ensureDay();
  const key = `${signal.symbol}:${signal.tf}`;
  positions.set(key, {
    symbol: signal.symbol,
    tf: signal.tf,
    entry: signal.price,
    stop: signal.stop,
    tp1: signal.tp1,
    tp2: signal.tp2,
    shares: signal.shares,
    atr: signal.atr,
    enteredAboveVwap: !!signal.aboveVwap,
    openedAt: Date.now(),
    hitTp1: false,
    peak: signal.price,
    trough: signal.price,
  });
  dayState.alerts += 1;
}

function computeR(pos, price) {
  const riskPerShare = pos.entry - pos.stop;
  if (!riskPerShare || riskPerShare <= 0) return 0;
  return (price - pos.entry) / riskPerShare;
}

// วนเช็คทุกไม้ที่เปิดอยู่ตามลำดับความสำคัญของเงื่อนไขออกไม้ คืน array ของ event ที่เกิดขึ้นรอบนี้
export async function checkExits() {
  ensureDay();
  const events = [];

  for (const [key, pos] of positions) {
    try {
      const quote = await getQuote(pos.symbol);
      if (!quote) continue; // ดึงราคาไม่ได้รอบนี้ ข้ามไปก่อน ไม่ถือเป็น error ร้ายแรง

      const price = quote.price;
      pos.peak = Math.max(pos.peak, price);
      pos.trough = Math.min(pos.trough, price);
      const heldMin = (Date.now() - pos.openedAt) / 60_000;

      let event = null;

      if (price <= pos.stop) {
        event = { type: 'STOP', emoji: '🛑', r: -1, close: true };
      } else if (!pos.hitTp1 && price >= pos.tp1) {
        pos.hitTp1 = true;
        event = { type: 'TP1', emoji: '🎯', r: CFG.atrTp1, close: false };
      } else if (pos.hitTp1 && price >= pos.tp2) {
        event = { type: 'TP2', emoji: '🏁', r: CFG.atrTp2, close: true };
      } else if (pos.hitTp1 && price <= pos.entry) {
        event = { type: 'BREAKEVEN', emoji: '⚖️', r: 0, close: true };
      } else {
        // เงื่อนไขที่เหลือต้องดูแท่งเทียนล่าสุดประกอบ (EMA5 / VWAP)
        const bars = await getBars(pos.symbol, pos.tf, 2);
        if (bars && bars.length >= 6) {
          const closes = bars.map((b) => b.close);
          const e5 = ema(closes, 5);
          const lastCloses = closes.slice(-2);
          const lastE5 = e5.slice(-2);

          if (
            lastE5[0] != null &&
            lastE5[1] != null &&
            lastCloses[0] < lastE5[0] &&
            lastCloses[1] < lastE5[1]
          ) {
            event = { type: 'EMA5_LOST', emoji: '⚠️', r: computeR(pos, price), close: true };
          } else if (pos.enteredAboveVwap) {
            const vwapSeries = sessionVwap(bars);
            const lastVwap = vwapSeries[vwapSeries.length - 1];
            if (lastVwap != null && price < lastVwap) {
              event = { type: 'VWAP_LOST', emoji: '🔻', r: computeR(pos, price), close: true };
            }
          }
        }

        if (!event && heldMin > CFG.timeStopMin) {
          const rNow = computeR(pos, price);
          if (rNow < 0.5) {
            event = { type: 'TIME_STOP', emoji: '⏱️', r: rNow, close: true };
          }
        }
      }

      if (event) {
        const mfeR = computeR(pos, pos.peak);
        const maeR = computeR(pos, pos.trough);

        if (event.close) {
          dayState.realizedR += event.r;
          if (event.r < 0) dayState.losses += 1;
          positions.delete(key);
        }

        const payload = {
          symbol: pos.symbol,
          tf: pos.tf,
          type: event.type,
          emoji: event.emoji,
          r: event.r,
          price,
          entry: pos.entry,
          stop: pos.stop,
          tp1: pos.tp1,
          tp2: pos.tp2,
          shares: pos.shares,
          mfeR,
          maeR,
          heldMin,
          dayR: dayState.realizedR,
          closed: event.close,
        };

        logEvent('exit', payload);
        events.push(payload);
      }
    } catch (err) {
      console.error(`⚠️  เช็คไม้ ${key} ผิดพลาด: ${err.message}`);
    }
  }

  return events;
}

// คืนสถิติรวมของวันปัจจุบัน
export function dayStats() {
  ensureDay();
  return {
    key: dayState.key,
    realizedR: dayState.realizedR,
    alerts: dayState.alerts,
    losses: dayState.losses,
    open: positions.size,
  };
}
