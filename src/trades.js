// src/trades.js — ★ v2: สมุดคุมไม้ที่เปิดอยู่ + กฎการออก + การเติมไม้
//
// ═══════════════ นี่คือข้อ P1 ที่ค้างไว้ตั้งแต่ v1 ═══════════════
//
// CHECKLIST.md เขียนไว้ตรงๆ ว่า positions.js / checkExits / exitLoop ไม่เคยถูก import
// จาก src/, server.js หรือ public/ เลย แปลว่าทุกไม้ในระบบเดิมคือ "ตั้งเป้า ตั้ง stop แล้วหวัง"
//
// ผลที่ตามมาและเป็นสาเหตุอันดับสองของอาการ "กำไรต่อไม้น้อย":
//   ถ้าไม่มีวิธีถือไม้ที่กำลังกำไรต่อ ก็ไม่มีทางมีไม้ที่กำไรใหญ่
//   ค่าเฉลี่ยกำไรต่อไม้จะถูกตรึงไว้ที่ขนาดของเป้าที่ตั้งไว้ตายตัวเสมอ
//
// ═══════════════ สิ่งที่ไฟล์นี้ทำและไม่ทำ ═══════════════
//
//   ทำ:    จดว่าเปิดไม้อะไรไว้ · คำนวณกำไร/ขาดทุนเป็น R ตามราคาล่าสุดทุกรอบสแกน
//          · บอกว่าถึงจังหวะทำอะไรตามกฎที่ตั้งไว้ · ลาก stop ให้ · นับ R สะสมรายวัน
//   ไม่ทำ: ส่งคำสั่งซื้อขาย ไม่เชื่อมโบรกเกอร์ ไม่แตะเงินจริง
//          คุณเป็นคนกดเอง ไฟล์นี้เป็นสมุดบันทึกที่คิดเลขให้
//
// ═══════════════ กฎการออก 7 แบบ ═══════════════
//   STOP        ราคาแตะจุดตัดขาดทุน (รวมที่ถูกลากขึ้นมาแล้ว)
//   TP1         ถึง +N R → ขายบางส่วน แล้วเลื่อน stop มาที่จุดคุ้มทุน
//   TRAIL       หลัง TP1 ลาก stop ตามจุดสูงสุด − (ตัวคูณ × ATR)
//   TARGET      ถึงราคาเป้า (ค่าเริ่มต้นคือ "ไม่ออก" — ดูหมายเหตุ Livermore ด้านล่าง)
//   EMA_LOST    ปิดแท่งต่ำกว่า EMA5 (ก่อน TP1) หรือ EMA15 (หลัง TP1)
//   VWAP_LOST   ราคาหลุด VWAP ของวัน
//   TIME_STOP   ผ่านไป N นาทีแล้วยังไม่ไปไหน — เงินจมโดยไม่มีอะไรเกิดขึ้น
//
// หมายเหตุเรื่องเป้า (Livermore): ค่าเริ่มต้น exitAtTarget = false
// เพราะ "เป้า" ในระบบนี้มีไว้ตอบคำถามว่า *ไม้นี้คุ้มจะเข้าไหม* (ใช้กรอง R:R)
// ไม่ใช่คำสั่งให้ออก การออกจริงใช้การลาก stop — ไม้ที่วิ่งแรงจึงมีโอกาสโตเกินเป้าได้
// ถ้าอยากได้พฤติกรรมแบบเดิม (ถึงเป้าแล้วออกหมด) เปิด exitAtTarget ในหน้า Settings

import { EventEmitter } from 'node:events';
import { readJsonSync, writeJson } from './store.js';
import { settings } from './settings.js';
import { log } from './logbus.js';
import { MARKETS, marketOf, localizeText } from './markets.js'; // ★ หุ้นไทย: ฿ + ทีละ 100 หุ้น

const TRADES_FILE = 'trades.json';

const EXIT_LABELS = {
  STOP: 'ตัดขาดทุน',
  TP1: 'ขายบางส่วน (TP1)',
  TRAIL: 'ลาก stop ชน',
  TARGET: 'ถึงเป้า',
  EMA_LOST: 'หลุด EMA',
  VWAP_LOST: 'หลุด VWAP',
  TIME_STOP: 'หมดเวลารอ',
  MANUAL: 'ปิดเอง',
};

// ★ ตลาดของไม้ — หุ้นไทยแสดงเงินเป็น ฿ และซื้อขายทีละ 100 หุ้น (1 board lot)
const mktOf = (t) => MARKETS[t.market] || MARKETS[marketOf(t.symbol)];
const L = (t, s) => localizeText(s, mktOf(t).cur);
const lotOf = (t) => mktOf(t).lotSize;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyBook() {
  return { open: [], closed: [], day: { date: todayKey(), realizedR: 0, wins: 0, losses: 0, halted: false } };
}

export class TradeBook extends EventEmitter {
  constructor() {
    super();
    const saved = readJsonSync(TRADES_FILE, null);
    this._book = saved && Array.isArray(saved.open) ? saved : emptyBook();
    this._migrate();
    this._rollDayIfNeeded();
  }

  // ★ ไม้ที่บันทึกไว้ด้วยโครงสร้างเก่า (ก่อนเปลี่ยนมาคิด R เป็นเงิน) ต้องเติมฟิลด์ให้ครบ
  // ไม่งั้นการคำนวณรอบถัดไปจะหารด้วย undefined แล้วได้ NaN ทั้งแถว
  _migrate() {
    for (const t of [...(this._book.open || []), ...(this._book.closed || [])]) {
      if (!Number.isFinite(t.initialShares)) t.initialShares = t.shares;
      if (!Number.isFinite(t.riskNetPerShare)) t.riskNetPerShare = t.riskPerShare + (t.costPerShare || 0);
      if (!Number.isFinite(t.initialRiskAmount)) t.initialRiskAmount = t.riskNetPerShare * t.initialShares;
      if (!Number.isFinite(t.realizedPnl)) t.realizedPnl = (t.realizedR || 0) * t.initialRiskAmount;
    }
  }

  // สถิติรายวันต้องรีเซ็ตเมื่อข้ามวัน ไม่งั้นลิมิตขาดทุนของเมื่อวานจะล็อกวันนี้ไว้
  _rollDayIfNeeded() {
    const t = todayKey();
    if (this._book.day?.date !== t) {
      this._book.day = { date: t, realizedR: 0, wins: 0, losses: 0, halted: false };
    }
  }

  async _save() {
    await writeJson(TRADES_FILE, this._book);
    this.emit('change', this.getState());
  }

  getState() {
    this._rollDayIfNeeded();
    const st = settings.all;
    return {
      open: this._book.open,
      closed: this._book.closed.slice(-50).reverse(),
      day: this._book.day,
      limits: {
        maxOpenTrades: st.maxOpenTrades,
        dailyLossLimitR: st.dailyLossLimitR,
        remainingR: st.dailyLossLimitR + this._book.day.realizedR, // realizedR ติดลบเมื่อขาดทุน
      },
      openCount: this._book.open.length,
    };
  }

  get open() { return this._book.open; }
  get halted() { this._rollDayIfNeeded(); return !!this._book.day.halted; }

  // ---------- เปิดไม้จากแถวสัญญาณ ----------
  async openFromRow(row, { shares = null, entry = null } = {}) {
    this._rollDayIfNeeded();
    const st = settings.all;

    if (this._book.day.halted) {
      return { ok: false, error: `หยุดเทรดวันนี้แล้ว (ขาดทุนสะสมถึงลิมิต ${st.dailyLossLimitR}R)` };
    }
    if (this._book.open.length >= st.maxOpenTrades) {
      return { ok: false, error: `เปิดไม้พร้อมกันได้สูงสุด ${st.maxOpenTrades} ไม้` };
    }
    if (this._book.open.some((t) => t.symbol === row.symbol)) {
      return { ok: false, error: `${row.symbol} มีไม้เปิดอยู่แล้ว` };
    }
    if (!row.rr?.ok) {
      return { ok: false, error: `${row.symbol} ไม่มีแผนความเสี่ยงที่ใช้ได้: ${row.rr?.reason || 'ไม่ทราบ'}` };
    }

    const entryPx = Number.isFinite(entry) ? entry : (row.planEntry ?? row.price);
    const stop = row.rr.stop;
    const riskPerShare = entryPx - stop;
    if (!(riskPerShare > 0)) return { ok: false, error: 'ระยะ stop คำนวณไม่ได้' };

    const mk = MARKETS[row.market] || MARKETS[marketOf(row.symbol)];
    const qty = Number.isFinite(shares) && shares > 0
      ? Math.floor(shares / mk.lotSize) * mk.lotSize // ★ หุ้นไทย: ปัดลงเป็นทวีคูณของ 100
      : (row.position?.shares || 0);
    if (qty <= 0) return { ok: false, error: 'ขนาดไม้เป็น 0 — แผนนี้ไม่ผ่านเกณฑ์ความเสี่ยง' };

    // ต้นทุนไป-กลับต่อหุ้น (spread + คอมมิชชัน + slippage) ที่ scoring คำนวณไว้แล้ว
    const costPerShareVal = Number.isFinite(row.rr.costPerShare) ? row.rr.costPerShare : 0;

    const trade = {
      id: `${row.symbol}-${Date.now()}`,
      symbol: row.symbol,
      market: mk.id, // ★
      tf: row.tf,
      entryMode: row.entryMode || 'anticipate',
      openedAt: new Date().toISOString(),
      entry: entryPx,
      initialStop: stop,
      stop,
      target: row.rr.targetBreakout,
      riskPerShare,                  // 1R เป็นเงินต่อหุ้น ณ ตอนเปิด (ไม่เปลี่ยนอีก)
      // ★ แก้บั๊ก 1: 1R เป็น "เงิน" ที่ตรึงไว้ตั้งแต่เปิดไม้ ไม่เปลี่ยนแม้จะเติมไม้
      // เดิมคิด R จากสัดส่วน (sharesOpen / shares) ซึ่งพังทันทีที่เติมไม้
      // เพราะ shares โตขึ้นและ entry กลายเป็นราคาเฉลี่ย → ตัวหารเปลี่ยน R ที่รายงานจึงผิด
      //
      // ★ แก้บั๊ก 2: 1R ต้องรวมต้นทุนด้วย ให้ตรงกับที่ใช้คำนวณขนาดไม้
      // scanner คำนวณจำนวนหุ้นจาก riskNet (ระยะ stop + ต้นทุน) เพื่อให้ "เสี่ยง 1%" เป็นจริง
      // แต่เดิมนิยาม 1R จากระยะ stop เฉยๆ → ไม้ที่เสี่ยงเงินจริง $100 ถูกเรียกว่า 1R = $76
      // ผลคือลิมิตขาดทุน 3R ที่ตั้งไว้ จะปล่อยให้เสียเงินจริงเกือบ 4R ก่อนหยุด
      initialShares: qty,
      riskNetPerShare: riskPerShare + costPerShareVal,
      initialRiskAmount: (riskPerShare + costPerShareVal) * qty,
      costPerShare: costPerShareVal,
      shares: qty,
      sharesOpen: qty,
      highWater: entryPx,
      tp1Done: false,
      adds: [],
      realizedR: 0,
      realizedPnl: 0, // ★ กำไร/ขาดทุนที่ปิดไปแล้ว เป็นเงิน
      score: row.score,
      trendPass: row.trend?.unavailable ? null : `${row.trend?.passCount}/${row.trend?.totalChecks}`,
      rsScore: row.trend?.rsScore ?? null,
      plannedRR: row.rr.rr,
      status: 'open',
      events: [{
        ts: new Date().toISOString(), type: 'OPEN', price: entryPx,
        note: localizeText(`เปิด ${qty} หุ้น · ระยะ stop $${riskPerShare.toFixed(3)}/หุ้น + ต้นทุน $${costPerShareVal.toFixed(3)}/หุ้น ` +
              `→ 1R = $${((riskPerShare + costPerShareVal) * qty).toFixed(2)} (เงินที่เสียจริงถ้าโดน stop)`, mk.cur),
      }],
    };

    this._book.open.push(trade);
    await this._save();
    log.success(L(trade, `📗 เปิดไม้ ${trade.symbol} ${qty} หุ้น @ $${entryPx.toFixed(2)} · stop $${stop.toFixed(2)} · เป้า $${trade.target.toFixed(2)}`));
    this.emit('opened', trade);
    return { ok: true, trade };
  }

  // ---------- ตรวจไม้ทั้งหมดด้วยแถวล่าสุดจากรอบสแกน ----------
  // rowsBySymbol: Map<symbol, row>
  async evaluate(rowsBySymbol) {
    this._rollDayIfNeeded();
    const st = settings.all;
    if (!st.trackTrades || this._book.open.length === 0) return [];

    const actions = [];
    const stillOpen = [];

    for (const t of this._book.open) {
      const row = rowsBySymbol.get(t.symbol);
      if (!row || !Number.isFinite(row.price) || row.dataError) {
        t.note = 'ไม่มีราคาล่าสุดรอบนี้ — ยังไม่ประเมิน';
        stillOpen.push(t);
        continue;
      }
      delete t.note;

      const px = row.price;
      if (px > t.highWater) t.highWater = px;

      // ★ R = เงินจริง ÷ งบความเสี่ยงตอนเปิดไม้ — นิยามเดียวที่ยังถูกต้องหลังเติมไม้
      // กำไรที่ยังไม่ปิดต้องหักต้นทุนขาออกที่ยังต้องจ่ายด้วย ไม่งั้นตัวเลขสวยเกินจริง
      const unrealPnl = (px - t.entry) * t.sharesOpen - (t.costPerShare || 0) * t.sharesOpen;
      t.currentPrice = px;
      t.unrealizedR = unrealPnl / t.initialRiskAmount;
      t.pnl = t.realizedPnl + unrealPnl;
      t.totalR = t.pnl / t.initialRiskAmount;

      let closed = false;

      // ---- 1) STOP (ตรวจก่อนเสมอ) ----
      if (px <= t.stop) {
        this._closeTrade(t, t.tp1Done && t.stop >= t.entry ? 'TRAIL' : 'STOP', t.stop);
        actions.push({ trade: t, type: t.exitReason, price: t.stop });
        closed = true;
      }

      // ---- 2) TP1 + เลื่อนมาคุ้มทุน ----
      if (!closed && !t.tp1Done && px >= t.entry + st.tp1R * t.riskPerShare) {
        const lot = lotOf(t); // ★ หุ้นไทยขายได้ทีละ 100 หุ้น (หุ้นอเมริกา lot = 1 → เหมือนเดิม)
        const sellQty = Math.max(lot, Math.floor((t.initialShares * (st.tp1Pct / 100)) / lot) * lot);
        const qty = Math.min(sellQty, t.sharesOpen);
        // ★ คิดจากราคาที่เห็นจริง ไม่ใช่ราคา TP1 ตามทฤษฎี — ราคามักกระโดดข้ามไป
        const bankedPnl = (px - t.entry) * qty - (t.costPerShare || 0) * qty;
        t.realizedPnl += bankedPnl;
        t.realizedR = t.realizedPnl / t.initialRiskAmount;
        const bankedR = bankedPnl / t.initialRiskAmount;
        t.sharesOpen -= qty;
        t.tp1Done = true;
        // จุดคุ้มทุนต้องเผื่อต้นทุน ไม่งั้น "เท่าทุน" ที่แท้จริงยังขาดทุนอยู่
        if (st.breakevenAfterTp1) t.stop = Math.max(t.stop, t.entry + t.costPerShare);
        t.events.push({
          ts: new Date().toISOString(), type: 'TP1', price: px, r: bankedR,
          note: L(t, `ถึง +${st.tp1R}R → ขาย ${qty} หุ้น (เก็บ ${bankedR.toFixed(2)}R) · เลื่อน stop มาที่ $${t.stop.toFixed(2)} (คุ้มทุนบวกต้นทุน)`),
        });
        actions.push({ trade: t, type: 'TP1', price: px });
        if (t.sharesOpen <= 0) { this._closeTrade(t, 'TP1', px); closed = true; }
      }

      // ---- 3) TRAIL (หลัง TP1 เท่านั้น) ----
      if (!closed && t.tp1Done && Number.isFinite(row.atr) && row.atr > 0) {
        const trail = t.highWater - st.trailAtrMult * row.atr;
        if (trail > t.stop) {
          const prev = t.stop;
          t.stop = trail;
          t.events.push({
            ts: new Date().toISOString(), type: 'TRAIL', price: px,
            note: L(t, `ลาก stop $${prev.toFixed(2)} → $${trail.toFixed(2)} (จุดสูงสุด $${t.highWater.toFixed(2)} − ${st.trailAtrMult}×ATR)`),
          });
        }
      }

      // ---- 4) TARGET (ปิดไว้เป็นค่าเริ่มต้น — ดูหมายเหตุหัวไฟล์) ----
      if (!closed && st.exitAtTarget && Number.isFinite(t.target) && px >= t.target) {
        this._closeTrade(t, 'TARGET', t.target);
        actions.push({ trade: t, type: 'TARGET', price: t.target });
        closed = true;
      }

      // ---- 5) EMA_LOST ----
      if (!closed && st.exitOnEmaLost) {
        const ref = t.tp1Done ? row.ema15 : row.ema5;
        const refName = t.tp1Done ? 'EMA15' : 'EMA5';
        if (Number.isFinite(ref) && px < ref) {
          this._closeTrade(t, 'EMA_LOST', px, L(t, `หลุด ${refName} ($${ref.toFixed(2)})`));
          actions.push({ trade: t, type: 'EMA_LOST', price: px });
          closed = true;
        }
      }

      // ---- 6) VWAP_LOST ----
      if (!closed && st.exitOnVwapLost && Number.isFinite(row.vwap) && px < row.vwap) {
        this._closeTrade(t, 'VWAP_LOST', px, L(t, `หลุด VWAP ($${row.vwap.toFixed(2)})`));
        actions.push({ trade: t, type: 'VWAP_LOST', price: px });
        closed = true;
      }

      // ---- 7) TIME_STOP ----
      if (!closed) {
        const minsOpen = (Date.now() - new Date(t.openedAt).getTime()) / 60000;
        if (minsOpen > st.timeStopMin && t.totalR < 0.5) {
          this._closeTrade(t, 'TIME_STOP', px, `ผ่านไป ${minsOpen.toFixed(0)} นาทีแล้วยังอยู่ที่ ${t.totalR.toFixed(2)}R`);
          actions.push({ trade: t, type: 'TIME_STOP', price: px });
          closed = true;
        }
      }

      // ---- ข้อเสนอเติมไม้ (Livermore) — เป็นคำแนะนำ ไม่ทำอัตโนมัติ ----
      if (!closed && st.pyramidEnabled && t.tp1Done
          && t.totalR >= st.pyramidMinR
          && t.adds.length < st.pyramidMaxAdds
          && Number.isFinite(row.breakoutVolRatio) && row.breakoutVolRatio >= st.breakoutRvolMin
          && px >= t.highWater * 0.999) {
        // ★ แก้บั๊ก: เดิมคำนวณให้ "ไม้ที่เติม" เสี่ยงเท่ากับ 1R เต็ม
        // โดยลืมว่าไม้เดิมที่ยังถืออยู่ก็มีความเสี่ยงค้างอยู่แล้ว → รวมกันกลายเป็น 1.5R
        // (พิสูจน์แล้ว: 50 หุ้นเดิมเสี่ยง $50 + เติม 100 หุ้นเสี่ยง $100 = $150 บนงบ $100)
        //
        // ที่ถูกคือ: งบความเสี่ยงทั้งไม้คือ 1R ตอนเปิด ไม้เดิมกินไปเท่าไหร่แล้ว
        // ที่เหลือเท่านั้นคือที่เติมได้
        const addRisk = px - t.stop;                              // ระยะเสี่ยงต่อหุ้น ณ stop ปัจจุบัน
        const openRisk = Math.max(0, addRisk * t.sharesOpen);     // ไม้เดิมยังเสี่ยงอยู่เท่านี้
        const budgetLeft = t.initialRiskAmount - openRisk;
        const lotA = lotOf(t); // ★ หุ้นไทย: ทวีคูณของ 100
        const addShares = addRisk > 0 && budgetLeft > 0 ? Math.floor(budgetLeft / addRisk / lotA) * lotA : 0;
        if (addShares > 0 && t.pyramidSuggestedAt !== t.adds.length) {
          t.pyramidSuggestedAt = t.adds.length;
          t.pyramidSuggestion = {
            shares: addShares,
            price: px,
            addRisk,
            totalRiskAfter: addRisk * (t.sharesOpen + addShares),
            note: L(t, `ทำจุดสูงสุดใหม่พร้อมวอลุ่ม ${row.breakoutVolRatio.toFixed(2)}× และกำไรแล้ว ${t.totalR.toFixed(2)}R — ` +
                  `เติมได้อีก ${addShares} หุ้น · ไม้เดิมเสี่ยงอยู่ $${openRisk.toFixed(2)} ` +
                  `เหลืองบอีก $${budgetLeft.toFixed(2)} จาก 1R เดิม $${t.initialRiskAmount.toFixed(2)} (stop $${t.stop.toFixed(2)})`),
          };
          actions.push({ trade: t, type: 'PYRAMID', price: px });
        }
      } else if (!closed) {
        delete t.pyramidSuggestion;
      }

      if (!closed) stillOpen.push(t);
    }

    this._book.open = stillOpen;

    // ---- ลิมิตขาดทุนรายวัน ----
    if (!this._book.day.halted && this._book.day.realizedR <= -Math.abs(st.dailyLossLimitR)) {
      this._book.day.halted = true;
      log.error(`🛑 ขาดทุนสะสมวันนี้ ${this._book.day.realizedR.toFixed(2)}R ถึงลิมิต ${st.dailyLossLimitR}R — หยุดเปิดไม้ใหม่`);
      this.emit('halt', this._book.day);
    }

    if (actions.length > 0) {
      await this._save();
      for (const a of actions) this.emit('exit', a);
    } else {
      this.emit('change', this.getState());
    }
    return actions;
  }

  _closeTrade(t, reason, price, extraNote = '') {
    // ★ ปิดส่วนที่เหลือด้วยราคานี้ แล้วสรุปทุกอย่างจาก "เงินจริง"
    const exitPnl = (price - t.entry) * t.sharesOpen - (t.costPerShare || 0) * t.sharesOpen;
    t.realizedPnl += exitPnl;
    const r = exitPnl / t.initialRiskAmount;

    t.status = 'closed';
    t.exitReason = reason;
    t.exitLabel = EXIT_LABELS[reason] || reason;
    t.exitPrice = price;
    t.closedAt = new Date().toISOString();
    t.realizedR = t.realizedPnl / t.initialRiskAmount;
    t.totalR = t.realizedR;
    t.pnl = t.realizedPnl;
    t.sharesOpen = 0;
    t.events.push({
      ts: t.closedAt, type: reason, price, r,
      note: L(t, `${t.exitLabel}${extraNote ? ' — ' + extraNote : ''} · ผลรวม ${t.totalR.toFixed(2)}R ($${t.pnl.toFixed(2)})`),
    });

    this._book.day.realizedR += t.totalR;
    if (t.totalR > 0) this._book.day.wins += 1; else this._book.day.losses += 1;
    this._book.closed.push(t);
    if (this._book.closed.length > 500) this._book.closed = this._book.closed.slice(-500);

    log[t.totalR > 0 ? 'success' : 'warn'](
        L(t, `📕 ปิดไม้ ${t.symbol} — ${t.exitLabel} @ $${price.toFixed(2)} · ${t.totalR >= 0 ? '+' : ''}${t.totalR.toFixed(2)}R ($${t.pnl.toFixed(2)})`));
  }

  // ---------- ปิดเอง ----------
  async closeManual(id, price) {
    const i = this._book.open.findIndex((t) => t.id === id);
    if (i < 0) return { ok: false, error: 'ไม่พบไม้นี้' };
    const t = this._book.open[i];
    const px = Number.isFinite(price) ? price : (t.currentPrice ?? t.entry);
    this._closeTrade(t, 'MANUAL', px);
    this._book.open.splice(i, 1);
    await this._save();
    return { ok: true, trade: t };
  }

  // ---------- รับข้อเสนอเติมไม้ ----------
  async acceptPyramid(id) {
    const t = this._book.open.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'ไม่พบไม้นี้' };
    if (!t.pyramidSuggestion) return { ok: false, error: 'ตอนนี้ไม่มีข้อเสนอเติมไม้' };
    const s = t.pyramidSuggestion;
    // ราคาเฉลี่ยใหม่ แต่ 1R เดิมไม่เปลี่ยน (ใช้วัดผลเทียบกับความเสี่ยงตอนเปิดไม้แรก)
    const newTotal = t.sharesOpen + s.shares;
    t.entry = ((t.entry * t.sharesOpen) + (s.price * s.shares)) / newTotal;
    t.sharesOpen = newTotal;
    t.shares += s.shares;
    // ★ initialShares / initialRiskAmount ห้ามเปลี่ยน — เป็นตัวหารของ R ตลอดอายุไม้
    t.adds.push({ ts: new Date().toISOString(), price: s.price, shares: s.shares });
    t.events.push({ ts: new Date().toISOString(), type: 'PYRAMID', price: s.price, note: L(t, `เติม ${s.shares} หุ้น @ $${s.price.toFixed(2)} · ราคาเฉลี่ยใหม่ $${t.entry.toFixed(2)}`) });
    delete t.pyramidSuggestion;
    await this._save();
    log.info(L(t, `➕ เติมไม้ ${t.symbol} อีก ${s.shares} หุ้น @ $${s.price.toFixed(2)}`));
    return { ok: true, trade: t };
  }

  async resumeAfterHalt() {
    this._rollDayIfNeeded();
    this._book.day.halted = false;
    await this._save();
    log.warn('▶️ ยกเลิกการหยุดเทรดวันนี้ด้วยตนเอง — ลิมิตขาดทุนถูกข้ามไปแล้ว');
    return this.getState();
  }

  async clearClosed() {
    this._book.closed = [];
    await this._save();
    return this.getState();
  }
}

export const trades = new TradeBook();
export { EXIT_LABELS };
