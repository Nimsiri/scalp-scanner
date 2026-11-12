// src/scanner.js — เครื่องยนต์สแกน (ScannerEngine)
//
// ═══ จุดสำคัญที่ต่างจาก monitor.js เดิม ═══
// เดิม: for(;;) { ... await sleep() } — ลูปอมตะ หยุดได้ทางเดียวคือ Ctrl+C ปิดโปรแกรม
// ใหม่: class + EventEmitter ที่ start()/stop()/scanOnce() ได้จากภายนอก
//
// การ "หยุดจริง" (สเปกข้อ 2: "หยุดจริง ไม่ค้าง interval") ทำ 3 ชั้น:
//   1) เก็บ handle ของ setTimeout ไว้ แล้ว clearTimeout ตอน stop()
//   2) ใช้ธง _abort ที่ถูกเช็คหลังทุก await ในลูป → รอบที่กำลังวิ่งอยู่หยุดกลางทางได้
//   3) ใช้ setTimeout แบบ recursive ไม่ใช่ setInterval
//      เพราะ setInterval จะยิงรอบใหม่ทับรอบเก่าที่ยังไม่เสร็จ (สแกน 60 ตัวอาจใช้ >60 วินาที)

import { EventEmitter } from 'node:events';
import { settings } from './settings.js';
import { log } from './logbus.js';
import { marketStatusFor } from './market-hours.js';
import {
  MARKETS, MARKET_IDS, marketOf, marketSettings, tickSize, localizeCurrency, toThSymbol,
} from './markets.js'; // ★ หุ้นไทย
import {
  getQuote, getBars, getDailyBars, getEarnings, getNews,
  getScreener, getLastFailure, isMockMode, getFundamentals,
} from './providers/index.js';
import { ema, rsi, atr, sessionVwap, rvolByTimeOfDay, sma } from '../indicators.js';
import { findResistance, findSupport, resolveAlertTarget } from './levels.js';
import { computeScore, expectedMove, riskReward, positionSize } from './scoring.js';
import { getWatchlist } from './watchlist.js';
import { checkAlert } from './alerts.js';
import { checkScoreAlerts } from './score-alerts.js'; // ★ กฎแจ้งเตือนคะแนนจากหน้าเว็บ
import { appendToArray } from './store.js';
import { getRegime } from './regime.js';
import { getTrendContext } from './trend.js'; // ★ v2
import { trades } from './trades.js';           // ★ v2

const SIGNALS_FILE = 'signals-history.json';

export class ScannerEngine extends EventEmitter {
  constructor() {
    super();
    this._running = false;      // ลูปเปิดอยู่หรือไม่
    this._scanning = false;     // กำลังสแกนอยู่หรือไม่ (กันกดซ้อน)
    this._abort = false;        // ธงบอกให้รอบที่กำลังวิ่งหยุด
    this._timer = null;         // handle ของ setTimeout
    this._rows = [];            // ผลสแกนรอบล่าสุด (★ รวมทุกตลาด)
    // ★ ผลของแต่ละตลาดเก็บแยก — ตลาดไทยกับอเมริกาเปิดคนละเวลา (ไม่ทับกันเลย)
    // รอบที่สแกนแค่ตลาดเดียว ผลของอีกตลาดยังอยู่ให้ดูได้ (คือผลรอบล่าสุดก่อนตลาดนั้นปิด)
    this._rowsByMarket = { US: [], TH: [] };
    this._lastRegimes = {};
    this._summary = emptySummary();
    this._lastScanAt = null;
    this._nextScanAt = null;
    this._scanCount = 0;
    this._lastError = null;
  }

  // ---------- สถานะที่ส่งไปให้หน้าเว็บ ----------
  getState() {
    const st = settings.all;
    const markets = this._marketStatuses(st);
    return {
      running: this._running,
      scanning: this._scanning,
      scanCount: this._scanCount,
      lastScanAt: this._lastScanAt,
      nextScanAt: this._nextScanAt,
      scanIntervalSec: st.scanIntervalSec,
      market: markets.US, // ช่องเดิมของหน้าเว็บ = หุ้นอเมริกา
      markets,            // ★ ทุกตลาด { US, TH }
      mockMode: isMockMode(),
      // ★ v2: เปิดเผยสถานะ timer ของ hot-poll ออกมา เพื่อให้ smoke test พิสูจน์ได้จริงว่า
      // การเพิ่ม timer ตัวที่สองไม่ได้ทำลายข้อกำหนด "กด Stop แล้วต้องหยุดจริง ไม่ค้าง interval"
      hotPolling: this._hotTimer !== null && this._hotTimer !== undefined,
      hotPollSec: st.hotPollSec,
      scanConcurrency: st.scanConcurrency,
      lastError: this._lastError,
      summary: this._summary,
    };
  }

  getRows() { return this._rows; }

  _emitState() { this.emit('state', this.getState()); }

  // ★ สถานะของทุกตลาด + เปิดใช้อยู่หรือไม่
  _marketStatuses(st) {
    const out = {};
    for (const m of MARKET_IDS) {
      const s = marketStatusFor(m, m === 'US' ? st.session : 'regular', new Date(), {
        dataDelayMin: st.thDataDelayMin ?? 30,
      });
      out[m] = { ...s, enabled: m === 'US' ? st.usEnabled !== false : st.thEnabled !== false, label: MARKETS[m].label };
    }
    return out;
  }

  // ★ ผลรวมทุกตลาด เรียงคะแนนมากไปน้อย
  _combinedRows() {
    return MARKET_IDS.flatMap((m) => this._rowsByMarket[m] || [])
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  // ═══════════════ start ═══════════════
  start() {
    if (this._running) return { ok: false, reason: 'ลูปสแกนกำลังทำงานอยู่แล้ว', state: this.getState() };

    this._running = true;
    this._abort = false;
    this._lastError = null;
    log.success(`▶ เริ่มลูปสแกน — รอบละ ${settings.get('scanIntervalSec')} วินาที`);
    this._emitState();

    // ⚠️ สำคัญ: ถ้ามีรอบสแกนกำลังวิ่งอยู่ (เช่น user กด Scan Now แล้วกด Start ตามทันที)
    // ห้ามเริ่มรอบใหม่ทับ ไม่งั้นจะมี 2 รอบวิ่งพร้อมกันและเกิด timer กำพร้า
    // ให้รอบที่วิ่งอยู่จบเองแล้วค่อยตั้ง timer รอบถัดไปใน finally ของ scanNow()
    if (this._scanning) {
      log.info('มีรอบสแกนกำลังทำงานอยู่ — จะเริ่มนับรอบถัดไปหลังรอบนี้เสร็จ');
      return { ok: true, state: this.getState() };
    }

    // เริ่มรอบแรกทันที ไม่ต้องรอ interval
    this._scheduleHot(); // ★ v2
    this._loop();
    return { ok: true, state: this.getState() };
  }

  // ═══════════════ stop ═══════════════
  // หยุดทั้ง timer ที่รออยู่ และรอบที่กำลังวิ่ง
  stop() {
    if (!this._running) return { ok: false, reason: 'ลูปสแกนหยุดอยู่แล้ว', state: this.getState() };

    this._running = false;
    this._abort = true;         // รอบที่กำลังวิ่งจะเห็นธงนี้แล้วหยุดกลางทาง
    this._clearTimer();         // ยกเลิก timer ที่ตั้งรอไว้ → ไม่มี interval ค้าง
    this._nextScanAt = null;

    log.warn('⏸ หยุดลูปสแกนแล้ว (server ยังทำงานอยู่ กด Start ได้ตลอด)');
    this._emitState();
    return { ok: true, state: this.getState() };
  }

  // ═══════════════ scanNow — บังคับสแกนรอบเดียวทันที ═══════════════
  // ทำงานได้ทั้งตอนลูปเปิดและปิด
  // ถ้าลูปเปิดอยู่ จะเลื่อน timer รอบถัดไปออกไป (ไม่ให้สแกนซ้อนกันติดๆ)
  async scanNow() {
    if (this._scanning) {
      return { ok: false, reason: 'กำลังสแกนอยู่ รอรอบนี้เสร็จก่อน', state: this.getState() };
    }

    this._clearTimer();
    log.info('🔄 บังคับสแกนรอบเดียวทันที');
    this._abort = false; // ให้รอบนี้วิ่งได้แม้ลูปจะหยุดอยู่

    try {
      await this._runScan();
    } finally {
      // ถ้าลูปยังเปิดอยู่ ให้ตั้ง timer รอบถัดไปต่อ
      // ถ้า user กด Stop ระหว่างที่รอบนี้วิ่ง → _running=false แล้ว จึงไม่ตั้ง timer
      // และตั้ง _abort กลับเป็น true เพื่อไม่ให้รอบที่ค้างอยู่ (ถ้ามี) วิ่งต่อ
      if (this._running) this._schedule();
      else this._abort = true;
    }

    return { ok: true, state: this.getState(), rows: this._rows };
  }

  // ยกเลิก timer ที่รออยู่ (ที่เดียวที่แตะ this._timer เพื่อไม่ให้เกิด timer กำพร้า)
  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    // ★ v2: timer ของ hot-poll ต้องถูกเก็บที่เดียวกัน
    // ไม่งั้น "หยุดจริง ไม่ค้าง interval" ที่ v1 อุตส่าห์ทำไว้จะพังทันทีที่เพิ่ม timer ตัวที่สอง
    if (this._hotTimer) {
      clearTimeout(this._hotTimer);
      this._hotTimer = null;
    }
  }

  // ═══════════════ ★ v2: hot-poll — ยิงราคาถี่เฉพาะตัวที่สำคัญ ═══════════════
  //
  // ปัญหา: รอบสแกนเต็มกินเวลาหลายสิบวินาที (ดึงแท่งเทียน + แท่งรายวัน + คำนวณทุกอย่าง)
  // จะให้สแกนเต็มทุก 10 วินาทีก็โดน rate limit และไม่จำเป็น
  //
  // แต่มีอยู่ 2 อย่างที่รอ 60 วินาทีไม่ได้จริงๆ:
  //   1) ไม้ที่เปิดอยู่ — stop ที่เช็คช้า 60 วินาทีคือ stop ที่กว้างกว่าที่ตั้งไว้จริง
  //   2) หุ้นที่ราคาจ่อระดับเบรกอยู่แล้ว — ช้า 60 วินาทีคือพลาดจุดเข้า
  //
  // hot-poll จึงยิงเฉพาะ "ราคา" (เบาที่สุด) ของเฉพาะตัวที่เข้าข่าย 2 ข้อนี้
  // แล้วเอาไปเช็คการแจ้งเตือนและกฎการออกจากไม้ทันที โดยไม่คำนวณอะไรใหม่
  //
  // หมายเหตุ: cache ของราคาคือ 20 วินาที การตั้ง hotPollSec ต่ำกว่านั้นจะได้ค่าเดิมจาก cache
  // ค่าเริ่มต้นจึงตั้งไว้ที่ 20 ให้ตรงกัน
  _scheduleHot() {
    if (this._hotTimer) { clearTimeout(this._hotTimer); this._hotTimer = null; }
    if (!this._running || this._abort) return;
    const sec = settings.get('hotPollSec');
    if (!sec || sec <= 0) return;
    this._hotTimer = setTimeout(async () => {
      this._hotTimer = null;
      try { await this._hotTick(); } catch (err) { log.warn(`hot-poll ผิดพลาด: ${err.message}`); }
      this._scheduleHot();
    }, sec * 1000);
  }

  async _hotTick() {
    if (!this._running || this._abort || this._scanning) return;
    const st = settings.all;

    // ★ ยิงเฉพาะหุ้นของตลาดที่กำลังเปิดอยู่ — ผลของตลาดที่ปิดแล้วเป็นแค่ผลรอบล่าสุด ราคาไม่ขยับ
    const statuses = this._marketStatuses(st);
    const live = (sym) => !!(statuses[marketOf(sym)]?.scanOpen || st.scanWhenClosed);

    // ---- เลือกตัวที่ต้องจับตา ----
    const hot = new Set();
    for (const t of trades.open) if (live(t.symbol)) hot.add(t.symbol); // ไม้ที่ถืออยู่ — สำคัญที่สุด
    for (const r of this._rows) {
      if (!live(r.symbol)) continue;
      if (r.dataError || !Number.isFinite(r.price) || r.alertTriggered) continue;
      const tgt = r.alertTarget;
      if (!Number.isFinite(tgt) || !Number.isFinite(r.atr) || r.atr <= 0) continue;
      if ((tgt - r.price) / r.atr <= st.hotDistanceAtr) hot.add(r.symbol); // จ่อระดับเบรกแล้ว
    }
    if (hot.size === 0) return;

    // จำกัดจำนวนไม่ให้เผาโควตา — เรียงให้ไม้ที่เปิดอยู่มาก่อนเสมอ
    const openSyms = new Set(trades.open.map((t) => t.symbol));
    const list = [...hot].sort((a, b) => (openSyms.has(b) ? 1 : 0) - (openSyms.has(a) ? 1 : 0)).slice(0, 12);

    const touched = [];
    await Promise.all(list.map(async (sym) => {
      try {
        const q = await getQuote(sym);
        if (!Number.isFinite(q?.price)) return;
        for (const r of this._rows) {
          if (r.symbol !== sym || r.dataError) continue;
          r.price = q.price;
          r.dataSource = q.source;
          r.dataAgeSec = q.ageSec;
          r.dataStale = q.stale;
          r.hotUpdatedAt = new Date().toISOString();
          if (Number.isFinite(r.alertTarget)) {
            r.alertDistancePct = ((r.alertTarget - q.price) / q.price) * 100;
          }
          touched.push(r);
        }
      } catch {
        // เงียบไว้ — รอบสแกนเต็มจะรายงานปัญหา provider เอง ไม่ต้องสแปม log ทุก 20 วินาที
      }
    }));

    if (touched.length === 0) return;

    // ---- เช็คการแจ้งเตือนด้วยราคาใหม่ ----
    for (const row of touched) {
      if (row.from !== 'watchlist' || row.alertTriggered) continue;
      try {
        const res = await checkAlert({
          symbol: row.symbol, price: row.price, target: row.alertTarget,
          mode: row.alertMode, label: row.alertLabel,
          resistanceLevel: row.resistance?.level ?? null,
        });
        row.alertTriggered = res.triggered || res.alreadyTriggered;
        row.alertTriggeredAt = res.triggeredAt;
        row.alertJustTriggered = res.triggered;
        if (res.triggered) this.emit('alert', { ...res.entry, row });
      } catch { /* เงียบเช่นกัน */ }
    }

    // ---- เช็คกฎการออกจากไม้ด้วยราคาใหม่ ----
    if (st.trackTrades && trades.open.length > 0) {
      const bySymbol = new Map();
      for (const r of this._rows) if (live(r.symbol) && !bySymbol.has(r.symbol)) bySymbol.set(r.symbol, r);
      try {
        const acts = await trades.evaluate(bySymbol);
        for (const a of acts) this.emit('trade', a);
      } catch (err) {
        log.error(`ประเมินไม้ระหว่าง hot-poll ไม่สำเร็จ: ${err.message}`);
      }
    }

    for (const r of touched) this.emit('row', r);
  }

  // ---------- ลูปหลัก ----------
  async _loop() {
    if (!this._running || this._abort) return;

    try {
      await this._runScan();
    } catch (err) {
      this._lastError = err.message;
      log.error(`รอบสแกนผิดพลาด (ทำงานต่อรอบถัดไป): ${err.message}`);
    }

    // เช็คอีกครั้งหลัง await — user อาจกด Stop ระหว่างที่สแกน
    if (this._running && !this._abort) this._schedule();
  }

  _schedule() {
    // เคลียร์ timer เดิมก่อนตั้งใหม่เสมอ — กัน timer กำพร้าที่ stop() ตามเก็บไม่ได้
    this._clearTimer();
    if (!this._running || this._abort) return;

    const ms = Math.max(5, settings.get('scanIntervalSec')) * 1000;
    this._nextScanAt = Date.now() + ms;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._loop();
    }, ms);
    this._scheduleHot(); // ★ v2 — hot-poll เดินคู่ขนานกับรอบสแกนเต็ม
    this._emitState();
  }

  // ═══════════════ หนึ่งรอบสแกน ═══════════════
  async _runScan() {
    // กันรอบซ้อน: ถ้ามีรอบวิ่งอยู่แล้วให้ออกทันที
    // (ป้องกันกรณี start() / scanNow() / timer ยิงมาชนกันพอดี)
    if (this._scanning) {
      log.warn('มีรอบสแกนกำลังทำงานอยู่แล้ว — ข้ามการเริ่มรอบซ้อน');
      return;
    }

    this._scanning = true;
    this._emitState();
    const t0 = Date.now();

    try {
      const st = settings.all;
      const statuses = this._marketStatuses(st);
      const market = statuses.US; // ช่องสถานะเดิม (หุ้นอเมริกา)

      // ★ ตลาดที่จะสแกนรอบนี้ = เปิดใช้อยู่ และ (อยู่ในเวลาสแกน หรือตั้งให้สแกนตอนตลาดปิด)
      // หุ้นไทยกับหุ้นอเมริกาเปิดคนละช่วงเวลา ปกติจึงสแกนทีละตลาดตามเวลาจริง
      const enabled = MARKET_IDS.filter((m) => statuses[m].enabled);
      for (const m of MARKET_IDS) if (!statuses[m].enabled) this._rowsByMarket[m] = []; // ปิดใช้ = ไม่แสดง
      const active = enabled.filter((m) => statuses[m].scanOpen || st.scanWhenClosed);
      const mst = Object.fromEntries(active.map((m) => [m, marketSettings(st, m)]));

      // ---------- ตลาดปิดทุกตลาด: ข้ามรอบ (ประหยัดโควตา API — ตรงกับคำอธิบายในหน้า Settings) ----------
      if (active.length === 0) {
        const why = enabled.length === 0
          ? 'ปิดการสแกนทั้งหุ้นอเมริกาและหุ้นไทยไว้ในหน้า Settings'
          : enabled.map((m) => {
            const s = statuses[m];
            return (enabled.length > 1 ? `${MARKETS[m].label}: ` : '') + s.reason + (s.nextChangeLabel ? ` · ${s.nextChangeLabel}` : '');
          }).join(' | ');
        this._rows = this._combinedRows();
        this._summary = { ...this._summary, marketOpen: false, note: `ข้ามรอบนี้ — ${why}` };
        log.info(`⏸ ข้ามรอบสแกน: ${why}`);
        this.emit('summary', this._summary);
        return;
      }

      // ---------- 1) รวบรวมรายชื่อหุ้นที่จะสแกน ----------
      const watchItems = await getWatchlist();
      const watchSymbols = watchItems.map((w) => w.symbol);
      const targetMap = new Map(watchItems.map((w) => [w.symbol, w.targetPrice]));
      const watchIn = (m) => watchSymbols.filter((s) => marketOf(s) === m);

      let screenerSymbols = [];
      this._screenerFailures = [];
      if (active.includes('US') && st.useAutoScreener) {
        screenerSymbols = await this._buildScreenerUniverse(st, watchSymbols);
      }

      // ★ หุ้นไทย: รายชื่อตั้งต้น (ใกล้เคียง SET100 — แก้ได้ในหน้า Settings) ไม่ซ้ำกับรายการเฝ้าดู
      let thList = [];
      if (active.includes('TH') && st.thUseUniverse !== false) {
        const watchSet = new Set(watchSymbols);
        thList = [...new Set((st.thUniverse || []).map(toThSymbol).filter(Boolean))].filter((s) => !watchSet.has(s));
      }

      const all = [];
      if (active.includes('US')) {
        all.push(
          ...watchIn('US').map((s) => ({ symbol: s, from: 'watchlist' })),
          ...screenerSymbols.map((s) => ({ symbol: s, from: 'screener' })),
        );
      }
      if (active.includes('TH')) {
        all.push(
          ...watchIn('TH').map((s) => ({ symbol: s, from: 'watchlist' })),
          ...thList.map((s) => ({ symbol: s, from: 'universe' })),
        );
      }

      if (all.length === 0) {
        // ★ บอกสาเหตุที่แท้จริง ไม่ใช่เดาว่า user ลืมตั้งค่า
        const broken = (this._screenerFailures || []).filter((f) => f.failed);
        let why;
        if (!active.includes('US')) {
          why = 'ยังไม่มีหุ้นไทยให้สแกน — รายชื่อหุ้นไทยปิดอยู่หรือว่าง และไม่มีหุ้นไทย (.BK) ในรายการเฝ้าดู (ตั้งได้ในหน้า Settings)';
        } else if (!st.useAutoScreener) {
          why = 'ยังไม่มีหุ้นให้สแกน — รายการเฝ้าดูว่าง และ auto screener ปิดอยู่ (เปิดได้ในหน้า Settings)';
        } else if (broken.length > 0) {
          why = `⚠️ auto screener เปิดอยู่แต่ดึงข้อมูลไม่สำเร็จ (${broken.map((f) => f.scrId).join(', ')}) ` +
                `— ${broken[0].reason.slice(0, 180)} · ระหว่างนี้เพิ่มหุ้นในรายการเฝ้าดูเองได้`;
          log.error(why);
        } else {
          why = 'auto screener ทำงานปกติแต่ไม่มีหุ้นตัวไหนผ่านเกณฑ์ราคา/วอลุ่มที่ตั้งไว้ — ' +
                'ลองผ่อนเกณฑ์ในหน้า Settings หรือเพิ่มหุ้นในรายการเฝ้าดูเอง';
        }
        for (const m of active) this._rowsByMarket[m] = [];
        this._rows = this._combinedRows();
        this._summary = {
          ...emptySummary(),
          note: why,
          screenerFailures: this._screenerFailures || [],
        };
        // log.error ถูกเรียกไปแล้วในสาขา screener ล้ม — อย่าพิมพ์ซ้ำ
        if (broken.length === 0) log.warn(why);
        this.emit('rows', this._rows);
        this.emit('summary', this._summary);
        return;
      }

      // ---------- ตลาดที่ปิดอยู่แต่ตั้งให้สแกนต่อ (scanWhenClosed) ----------
      for (const m of active) {
        if (!statuses[m].scanOpen) {
          log.info(`${enabled.length > 1 ? MARKETS[m].label + ' — ' : ''}ตลาดปิดอยู่ (${statuses[m].reason}) — ข้อมูลที่เห็นเป็นราคาล่าสุดก่อนปิด`);
        }
      }

      // ---------- 2) ภาวะตลาด (อเมริกา: SPY/QQQ · ★ ไทย: SET/SET50) — แยกตามตลาด ----------
      const regimes = {};
      for (const m of active) {
        regimes[m] = { market: m, regime: 'UNKNOWN', sizeMult: 1, scoreAdj: 0 };
        try {
          regimes[m] = await getRegime({ market: m });
        } catch (err) {
          log.warn(`ประเมินภาวะตลาด${active.length > 1 ? ` (${MARKETS[m].label})` : ''}ไม่สำเร็จ: ${err.message} — ใช้ตัวคูณขนาดไม้ 1.0`);
        }
      }
      // ภาวะตลาดหลักของรอบนี้ (ช่องเดิมในหน้าเว็บ) — หุ้นอเมริกาถ้าสแกนอยู่ ไม่งั้นตลาดแรกที่สแกน
      const regime = regimes[active.includes('US') ? 'US' : active[0]];
      if (this._abort) return;

      // ---------- 3) วิเคราะห์ (★ v2: ขนานกันหลายตัว ไม่ใช่ทีละตัว) ----------
      //
      // v1 วิเคราะห์เรียงทีละตัว ทีละ timeframe ด้วย await
      // หุ้น 30 ตัว × 2 timeframe × ราวๆ 0.3-1 วินาทีต่องาน = 20-60 วินาทีต่อรอบ
      // ซึ่งมักยาวกว่าช่วงสแกน 60 วินาทีที่ตั้งไว้ → ข้อมูลที่เห็นเก่ากว่าที่คิดเสมอ
      // และเป็นคำตอบของอาการ "ตอบรับช้า"
      //
      // v2 ใช้สระว่ายน้ำขนาด scanConcurrency (ค่าเริ่มต้น 5)
      // ตัวจำกัดอัตราของแต่ละ provider (token bucket ใน providers/_shared.js) ยังทำงานอยู่
      // จึงไม่ทำให้โดน rate limit เพิ่ม — แค่ไม่ปล่อยให้คิวว่างระหว่างรอ network
      const rows = [];
      const rejects = new Map();

      const jobs = [];
      for (const { symbol, from } of all) {
        for (const tf of st.timeframes) jobs.push({ symbol, tf, from, market: marketOf(symbol) });
      }

      let cursor = 0;
      const worker = async () => {
        while (!this._abort) {
          const idx = cursor++;
          if (idx >= jobs.length) return;
          const { symbol, tf, from, market: mkt } = jobs[idx];
          try {
            // ★ แต่ละตลาดใช้ค่าตั้งค่าและภาวะตลาดของตัวเอง (หุ้นอเมริกา = ค่าเดิมทุกตัว)
            const row = await this._analyse({
              symbol, tf, from, st: mst[mkt], regime: regimes[mkt], market: mkt,
              manualTarget: targetMap.get(symbol) ?? null,
            });
            if (row) {
              rows.push(row);
              // เก็บสถิติ "ตกด่านเพราะอะไร" จาก failReasons ของแถวจริง
              // ⚠️ บั๊กเดิม: rejects ถูกเขียนแค่ใน catch (ข้อความ crash) เท่านั้น
              //    ทำให้ topRejects และ filteredByRR รายงานแต่ error ไม่เคยรายงานเหตุผลตกด่านจริง
              if (!row.passed) {
                for (const why of row.failReasons || []) {
                  // ตัดตัวเลขในวงเล็บออก เพื่อให้เหตุผลเดียวกันถูกนับรวมกัน
                  const key = String(why).replace(/\s*\([^)]*\)/g, '').trim();
                  rejects.set(key, (rejects.get(key) || 0) + 1);
                }
              }
              this.emit('row', row); // ส่งทีละแถวให้หน้าเว็บอัปเดตแบบไหลๆ
            }
          } catch (err) {
            // หุ้นตัวเดียวพังต้องไม่ทำให้ทั้งรอบพัง (สเปกข้อ 9)
            const why = `วิเคราะห์ผิดพลาด: ${err.message}`;
            rejects.set(why, (rejects.get(why) || 0) + 1);
            log.error(`${symbol} (${tf}) ${why}`);
          }
        }
      };

      const poolSize = Math.max(1, Math.min(st.scanConcurrency || 1, jobs.length));
      await Promise.all(Array.from({ length: poolSize }, worker));
      if (this._abort) {
        log.warn(`หยุดกลางรอบตามคำสั่ง (วิเคราะห์ไปแล้ว ${rows.length}/${jobs.length} งาน)`);
      }

      // ---------- 4) เรียงคะแนนมากไปน้อย + ดึงข้อมูลแพงให้ top N ----------
      rows.sort((a, b) => b.score - a.score);
      await this._enrichTopCandidates(rows, st);
      rows.sort((a, b) => b.score - a.score);

      // ซ่อนแถวที่คะแนนต่ำกว่า hideBelowScore (default 0 = แสดงทุกตัว)
      // แถวที่ดึงข้อมูลไม่ได้จะไม่ถูกซ่อน เพราะต้องให้ user เห็นว่า "ข้อมูลไม่อัปเดต"
      const hideBelow = st.hideBelowScore || 0;
      const hiddenByScore = hideBelow > 0
        ? rows.filter((r) => !r.dataError && r.score < hideBelow).length
        : 0;
      const visibleRows = hideBelow > 0
        ? rows.filter((r) => r.dataError || r.score >= hideBelow)
        : rows;

      // ---------- ★ v2: ประเมินไม้ที่เปิดอยู่ด้วยราคาล่าสุดของรอบนี้ ----------
      // ทำก่อนเช็คการแจ้งเตือน เพราะการออกจากไม้ที่ถืออยู่สำคัญกว่าการหาไม้ใหม่เสมอ
      if (st.trackTrades && !this._abort) {
        try {
          // ถ้ามีหลาย timeframe ให้ใช้ timeframe แรกเป็นตัวอ้างอิงของแต่ละหุ้น (กันข้อมูลสองชุดตีกัน)
          const bySymbol = new Map();
          for (const r of rows) if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, r);
          const acts = await trades.evaluate(bySymbol);
          for (const a of acts) this.emit('trade', a);
        } catch (err) {
          log.error(`ประเมินไม้ที่เปิดอยู่ไม่สำเร็จ: ${err.message}`);
        }
      }

      // ---------- 5) เช็คการแจ้งเตือนราคา ----------
      for (const row of rows) {
        if (this._abort) break;
        if (row.from !== 'watchlist') continue; // แจ้งเตือนราคาใช้เฉพาะ watchlist

        try {
          const res = await checkAlert({
            symbol: row.symbol,
            price: row.price,
            target: row.alertTarget,
            mode: row.alertMode,
            label: row.alertLabel,
            resistanceLevel: row.resistance?.level ?? null,
          });
          row.alertTriggered = res.triggered || res.alreadyTriggered;
          row.alertTriggeredAt = res.triggeredAt;
          row.alertJustTriggered = res.triggered;

          if (res.triggered) {
            // ส่ง event ให้หน้าเว็บทำเสียง + notification + ไฮไลต์
            this.emit('alert', { ...res.entry, row });
          }
        } catch (err) {
          log.error(`เช็คการแจ้งเตือน ${row.symbol} ผิดพลาด: ${err.message}`);
        }
      }

      // ---------- 5.5) ★ แจ้งเตือนเมื่อคะแนนถึงเกณฑ์ (ตั้งจากหน้าเว็บ) ----------
      // ทำเฉพาะรอบสแกนเต็ม — hot-poll อัปเดตแค่ราคา ไม่ได้คำนวณคะแนนใหม่
      if (!this._abort) {
        try {
          const hits = await checkScoreAlerts(rows, st);
          if (hits.length > 0) {
            this.emit('score-alert', { ts: new Date().toISOString(), min: st.scoreAlertMin, hits });
          }
        } catch (err) {
          log.error(`เช็คการแจ้งเตือนคะแนนผิดพลาด: ${err.message}`);
        }
      }

      // ---------- 6) บันทึกสัญญาณลงประวัติ (สำหรับ backtest — สเปกข้อ 7) ----------
      const signals = rows.filter((r) => r.isSignal);
      for (const s of signals) {
        await appendToArray(SIGNALS_FILE, toSignalRecord(s), 10_000);
      }

      // ---------- 7) สรุป ----------
      // ★ แทนที่เฉพาะผลของตลาดที่สแกนรอบนี้ — ผลของอีกตลาด (ที่ปิดอยู่) ยังอยู่ให้ดูได้
      for (const m of active) this._rowsByMarket[m] = visibleRows.filter((r) => (r.market || 'US') === m);
      this._rows = this._combinedRows();
      this._scanCount += 1;
      this._lastScanAt = new Date().toISOString();
      this._lastError = null;
      for (const m of active) {
        this._lastRegimes[m] = {
          regime: regimes[m].regime, label: regimes[m].label ?? null, sizeMult: regimes[m].sizeMult, at: this._lastScanAt,
        };
      }

      const staleCount = visibleRows.filter((r) => r.dataStale).length;
      this._summary = {
        scanned: all.length,
        rowsProduced: visibleRows.length,
        hiddenByScore,
        signals: signals.length,
        // จำนวนแถวที่ถูกกรองด้วยเกณฑ์ R:R (นับจาก failReasons จริง ไม่ใช่จากข้อความ error)
        filteredByRR: rows.filter((r) => (r.failReasons || []).some((x) => x.includes('R:R'))).length,
        regime: regime.regime,
        regimeSizeMult: regime.sizeMult,
        regimes: { ...this._lastRegimes }, // ★ ภาวะตลาดล่าสุดของแต่ละตลาด
        marketsScanned: active,           // ★ ตลาดที่สแกนรอบนี้
        marketOpen: market.open,
        staleCount,
        durationMs: Date.now() - t0,
        topRejects: [...rejects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([why, count]) => ({ why, count })),
        screenerFailures: (this._screenerFailures || []).filter((f) => f.failed), // ★
        note: trades.halted
          ? `🛑 หยุดเปิดไม้ใหม่วันนี้ — ขาดทุนสะสมถึงลิมิต ${st.dailyLossLimitR}R (ยกเลิกได้ในตารางไม้ที่เปิดอยู่)`
          : null,
        openTrades: trades.open.length,        // ★ v2
        dayR: trades.getState().day.realizedR, // ★ v2
        tradingHalted: trades.halted,          // ★ v2
      };

      const onlyUs = active.length === 1 && active[0] === 'US';
      log.info(
        `🔎 สแกน${onlyUs ? '' : ` ${active.map((m) => MARKETS[m].label).join(' + ')}`} ${all.length} ตัว → แสดงผล ${visibleRows.length} แถว` +
        (hiddenByScore > 0 ? ` (ซ่อน ${hiddenByScore} แถวที่คะแนน <${hideBelow})` : '') +
        ` | สัญญาณคะแนน ≥${st.signalScore}: ${signals.length} | ` +
        `ภาวะตลาด: ${active.length > 1 ? active.map((m) => `${m} ${regimes[m].regime}`).join(', ') : regime.regime} | ใช้เวลา ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (staleCount > 0 ? ` | ⚠️ ข้อมูลไม่อัปเดต ${staleCount} ตัว` : '')
      );
      if (this._summary.topRejects.length > 0) {
        log.info(`ตกรอบเยอะสุด: ${this._summary.topRejects.map((r) => `${r.why} (${r.count})`).join(', ')}`);
      }

      this.emit('rows', this._rows);
      this.emit('summary', this._summary);
    } finally {
      this._scanning = false;
      this._emitState();
    }
  }

  // ---------- สร้าง universe จาก screener ----------
  async _buildScreenerUniverse(st, excludeSymbols) {
    const exclude = new Set(excludeSymbols);
    const bySymbol = new Map();
    // ★ แก้บั๊ก: getScreener กลืน error แล้วคืน [] เงียบๆ
    // ทำให้ "screener ล้ม" กับ "screener ปิดอยู่" ดูเหมือนกันหมดจากข้างนอก
    // แล้วข้อความที่ user เห็นคือ "เปิด auto screener ในหน้า Settings" ทั้งที่เปิดอยู่แล้ว
    this._screenerFailures = [];

    for (const scrId of st.screeners) {
      if (this._abort) break;
      const quotes = await getScreener(scrId, st.screenerSize);
      if (quotes.length === 0) {
        const fail = getLastFailure('screener', scrId);
        this._screenerFailures.push({
          scrId,
          reason: fail?.message || 'ไม่มีหุ้นตรงเงื่อนไข (ไม่ใช่ข้อผิดพลาด)',
          failed: !!fail,
        });
      }
      for (const q of quotes) {
        if (!q?.symbol || exclude.has(q.symbol)) continue;
        // กรองด้วยเกณฑ์พื้นฐาน (ราคา/วอลุ่มเฉลี่ย) เพื่อไม่เอาหุ้นที่เทรดไม่ได้จริงมาเปลืองโควตา
        if (Number.isFinite(q.price) && (q.price < st.minPrice || q.price > st.maxPrice)) continue;
        if (Number.isFinite(q.avgVolume) && q.avgVolume < st.minAvgVolume) continue;
        bySymbol.set(q.symbol, q);
      }
    }

    return [...bySymbol.keys()].slice(0, st.screenerSize);
  }

  // ═══════════════ วิเคราะห์หุ้น 1 ตัว 1 timeframe ═══════════════
  // ตามที่ตกลงไว้: "ด่านแข็ง" เหลือแค่คุณภาพข้อมูล + R:R
  // ส่วน EMA/RSI/VWAP/RVOL กลายเป็นคะแนน ไม่ใช่ด่านคัดออก
  // → เห็นหุ้นครบทุกตัวพร้อมคะแนน ไม่หายไปเงียบๆ
  async _analyse({ symbol, tf, from, st, regime, manualTarget, market = 'US' }) {
    // ★ ตลาดของหุ้นตัวนี้ — กำหนดเขตเวลา (VWAP/RVOL) ช่วงราคา ขนาด lot และสกุลเงิน
    const mk = MARKETS[market] || MARKETS.US;
    const isTh = mk.id === 'TH';

    // ---------- ดึงแท่งเทียน ----------
    let barsRes;
    try {
      barsRes = await getBars(symbol, tf, 30);
    } catch (err) {
      // ดึงไม่ได้เลย → คืนแถวที่บอกชัดว่า "ข้อมูลไม่อัปเดต" (สเปกข้อ 5) ไม่ใช่หายเงียบ
      return this._errorRow({ symbol, tf, from, reason: err.message, manualTarget });
    }

    const bars = barsRes.bars;
    if (!bars || bars.length < st.minBars) {
      return this._errorRow({
        symbol, tf, from, manualTarget,
        reason: `แท่งเทียนไม่พอ (มี ${bars?.length || 0} ต้องมี ${st.minBars})`,
      });
    }

    // ---------- ราคาปัจจุบัน ----------
    let quote = barsRes.quote;
    if (!quote) {
      try {
        quote = await getQuote(symbol);
      } catch (err) {
        return this._errorRow({ symbol, tf, from, manualTarget, reason: `ดึงราคาไม่ได้: ${err.message}` });
      }
    }

    const price = quote.price;
    const n = bars.length;
    const closes = bars.map((b) => b.close);
    const lastBar = bars[n - 1];

    // ---------- อินดิเคเตอร์ ----------
    const atrSeries = atr(bars, 14);
    const atrValue = atrSeries[n - 1];
    const atrPct = Number.isFinite(atrValue) && price > 0 ? (atrValue / price) * 100 : null;

    const e5 = ema(closes, 5);
    const e15 = ema(closes, 15);
    const rsiSeries = rsi(closes, 14);
    const vwapSeries = sessionVwap(bars, mk.tz); // ★ reset ตามวันของตลาดนั้น

    // RVOL เทียบช่วงเวลาเดียวกันของวันก่อนๆ (แม่นกว่าเทียบค่าเฉลี่ยรวม) — ★ เวลาท้องถิ่นของตลาด
    let rvol = rvolByTimeOfDay(bars, st.rvolDays ?? 10, mk.tz).rvol;
    if (!Number.isFinite(rvol)) {
      // สำรอง: เทียบกับ SMA20 ของ volume
      const vols = bars.map((b) => b.volume);
      const smaVol = sma(vols.slice(0, -1), 20);
      rvol = smaVol > 0 ? vols[n - 1] / smaVol : null;
    }

    // มูลค่าซื้อขายเทียบเป็นต่อ 5 นาที (ให้เทียบกันได้ข้าม timeframe)
    const tfMin = barsRes.meta?.tfMinutes || (tf === '15m' ? 15 : 5);
    const dollarVolume5m = (lastBar.volume / tfMin) * 5 * price;

    // ★ v2: อัตราส่วนวอลุ่มของ "แท่งล่าสุด" เทียบค่าเฉลี่ย 20 แท่งก่อนหน้า
    // ต่างจาก RVOL ซึ่งเทียบกับช่วงเวลาเดียวกันของวันก่อนๆ (บอกว่าวันนี้คึกคักผิดปกติไหม)
    // ตัวนี้ตอบคำถามของเสี่ยยักษ์: "ตอนที่มันทะลุ มีเงินเข้าจริงหรือแค่ลอยขึ้นไปเอง"
    let breakoutVolRatio = null;
    if (n >= 21) {
      const prev20 = bars.slice(-21, -1).map((b) => b.volume).filter(Number.isFinite);
      const avg20 = prev20.length ? prev20.reduce((a, b) => a + b, 0) / prev20.length : 0;
      if (avg20 > 0) breakoutVolRatio = lastBar.volume / avg20;
    }

    // %เปลี่ยนแปลงจากราคาปิดเมื่อวาน
    const prevClose = quote.prevClose ?? barsRes.meta?.previousClose ?? closes[0];
    const changePct = Number.isFinite(quote.changePct)
      ? quote.changePct
      : (prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null);

    // ═══ ★ หุ้นไทย: ระยะเผื่อต้องไม่น้อยกว่า 1 ช่องราคา ═══
    // ระยะยืนยันเบรก 0.05% / ระยะแจ้งเตือน 0.1% เล็กกว่าช่องราคาของ SET เกือบทุกระดับราคา
    // (PTT 41.25 บาท ขยับทีละ 0.25 = 0.6%) — "เหนือแนวต้าน 0.05%" จึงเป็นราคาที่ซื้อขายจริงไม่ได้
    // หุ้นอเมริกาใช้ค่าเดิมทุกอย่าง
    const tick = tickSize(price, market);
    const tickPct = isTh && price > 0 ? Math.ceil((tick / price) * 100 * 100) / 100 : 0;
    const alertOffsetPct = isTh ? Math.max(st.alertOffsetPct, tickPct) : st.alertOffsetPct;
    const confirmOffsetPct = isTh ? Math.max(st.confirmOffsetPct, tickPct) : st.confirmOffsetPct;

    // ★ spread เป็นจำนวนช่องราคา (หุ้นไทย) — 1 ช่องคือแคบที่สุดที่เป็นไปได้
    const spreadTicks = isTh && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.ask > quote.bid
      ? Math.max(1, Math.round((quote.ask - quote.bid) / tickSize(quote.bid, market)))
      : null;

    // ---------- แนวต้าน (สเปกข้อ 4) ----------
    // ส่ง minDistancePct = alertOffsetPct เพื่อกันเป้าหมายตกใต้ราคาปัจจุบัน
    const resistance = findResistance(bars, price, atrValue, {
      pivotK: st.pivotK,
      clusterAtrMult: st.clusterAtrMult,
      lookback: st.lookback,
      minDistancePct: alertOffsetPct,
    });
    const support = findSupport(bars, price, atrValue, {
      pivotK: st.pivotK, clusterAtrMult: st.clusterAtrMult,
    });

    // ---------- ราคาเป้าหมายแจ้งเตือน ----------
    const alert = resolveAlertTarget({
      manualTarget,
      resistance,
      alertOffsetPct,                        // ★ หุ้นไทย: อย่างน้อย 1 ช่องราคา
      price,
      entryMode: st.entryMode,               // ★ v2
      confirmOffsetPct,                      // ★ v2 · หุ้นไทย: อย่างน้อย 1 ช่องราคา
    });

    // ---------- ★ v2: แนวโน้มระยะกลาง + ATR รายวัน (ยิงข้อมูลรายวันครั้งเดียวได้ทั้งสองอย่าง) ----------
    // เดิมเรียก getDailyBars(60) เพื่อเอา ATR รายวันอย่างเดียว
    // v2 เรียก getTrendContext ซึ่งใช้ getDailyBars(400 วัน) (แคช 12 ชม.) แล้วคืนทั้ง
    // ATR รายวัน + Trend Template + RS ในคราวเดียว → ไม่ได้เพิ่มจำนวน request
    const trend = await getTrendContext(symbol, {
      rsBenchmark: st.rsBenchmark,
      minRsScore: st.minRsScore,
    });
    const dailyAtrPct = Number.isFinite(trend?.dailyAtrPct) ? trend.dailyAtrPct : null;
    const expMove = expectedMove({ dailyAtrPct, intradayAtrPct: atrPct, tfMinutes: tfMin, sessionHours: mk.sessionHours });

    // ---------- R:R (สเปกข้อ 6) ----------
    const swingLow6 = Math.min(...bars.slice(-6).map((b) => b.low));

    // ═══ ★ v2: แผนการเข้าไม้ต่างกันตามโหมด ═══
    //
    // anticipate (เดิม): เข้าที่ราคาปัจจุบัน ก่อนแนวต้าน · stop ใต้แนวรับ · เป้า = แนวต้าน + ส่วนขยาย
    // confirm (ใหม่):    เข้าเหนือแนวต้าน หลังทะลุจริง · stop ใต้แนวต้านที่กลายเป็นแนวรับ
    //                    เป้าวัดจากจุดเข้า ไม่ใช่จากแนวต้าน (เพราะผ่านแนวต้านไปแล้ว)
    const isConfirm = st.entryMode === 'confirm' && Number.isFinite(resistance.level);
    const confirmLevel = isConfirm ? resistance.level * (1 + confirmOffsetPct / 100) : null;
    const planEntry = isConfirm ? Math.max(price, confirmLevel) : price;

    // ATR รายวันจริงของหุ้นตัวนี้ — เป็น "หน่วยของไม้" ใน v2 (ดูคำอธิบายใน scoring.riskReward)
    const dailyAtrValue = Number.isFinite(trend?.dailyAtr) ? trend.dailyAtr
      : (Number.isFinite(dailyAtrPct) ? (dailyAtrPct / 100) * price : null);

    const rr = riskReward({
      price: planEntry,
      atrValue,
      swingLow: swingLow6,
      // โหมด confirm: แนวต้านที่แตกแล้วคือแนวรับใหม่ → stop ไปอยู่ใต้ระดับนั้น
      support: isConfirm ? resistance.level : (support.confirmed ? support.level : null),
      // ส่งแนวต้านเป็น "ตัวอ้างอิง" — riskReward จะรู้เองว่ามันขวางอยู่เหนือจุดเข้าหรือถูกทะลุไปแล้ว
      target: resistance.level,
      atrStopMult: st.atrStopMult,
      minStopAtr: st.minStopAtr,
      minStopPct: st.minStopPct,           // ★ v2
      targetExtAtr: st.targetExtAtr,
      costPct: st.costPct,                 // ★ v2
      spreadPct: quote.spreadPct,          // ★ v2
      dailyAtrValue,                       // ★ v2
      tradeAtrBasis: st.tradeAtrBasis,     // ★ v2
      stopAtrDaily: st.stopAtrDaily,       // ★ v2
      targetAtrDaily: st.targetAtrDaily,   // ★ v2
    });

    // ---------- Position size ----------
    // ⚠️ คำนวณขนาดไม้เฉพาะเมื่อ R:R ผ่านเกณฑ์
    //    ไม่งั้นแถวที่ถูกกรองออกจะยังโชว์จำนวนหุ้นและเงินที่เสี่ยง เหมือนเทรดได้จริง
    const rrPasses = rr.ok && rr.rr >= st.minRR;
    const pos = rrPasses
      ? positionSize({
          accountSize: st.accountSize, riskPct: st.riskPct,
          riskPerShare: rr.riskNet ?? rr.risk, sizeMult: regime.sizeMult ?? 1, price, // ★ v2: ใช้ความเสี่ยงสุทธิ (รวมต้นทุน) เพื่อให้ %ความเสี่ยงที่ตั้งไว้เป็นจริง
          lotSize: mk.lotSize, // ★ หุ้นไทย: ทวีคูณของ 100 หุ้น
        })
      : {
          shares: 0, riskAmount: 0, cost: 0,
          note: rr.ok
            ? `ไม่คำนวณขนาดไม้ เพราะ R:R (${rr.label}) ต่ำกว่าเกณฑ์ 1:${st.minRR}`
            : rr.reason,
        };

    // ---------- ข่าว (ดึงเฉพาะ top N ในขั้นตอน _enrichSentiment) ----------
    const news = { sentiment: null, articleCount: 0, headlines: [], unavailable: true, source: null, pending: true };

    // ---------- คะแนน ----------
    const scored = computeScore({
      rvol,
      // ให้คะแนนความผันผวนด้วย ATR% "เทียบเท่ารายวัน" ไม่ใช่ ATR% ของแท่ง intraday
      // (ATR% ของแท่ง 5 นาทีอยู่ราว 0.1-0.5% เทียบกับช่วงที่เหมาะของรายวัน 1.5-3% ไม่ได้)
      dailyAtrPct: expMove.pct,
      resistance,
      momentum: {
        changePct,
        ema5: e5[n - 1], ema15: e15[n - 1], ema5Prev: e5[n - 2], price,
      },
      news,
      liquidity: {
        spreadPct: quote.spreadPct, dollarVolume5m,
        spreadTicks,                              // ★ หุ้นไทย: ให้คะแนน spread เป็นจำนวนช่องราคา
        valueCurve: isTh ? mk.valueCurve : null,  // ★ หุ้นไทย: เกณฑ์มูลค่าซื้อขายเป็นล้านบาท
      },
    }, st.weights, {
      renormalize: st.renormalizeWeights,
      atrPctLow: st.atrPctLow,
      atrPctHigh: st.atrPctHigh,
    });

    // ---------- ด่านแข็ง: คุณภาพข้อมูล + R:R ----------
    // ส่ง dollarVolume5m ที่คำนวณด้วย tfMinutes จริงเข้าไป
    // (เดิม _checkQuality คำนวณเองด้วย tfMin=5 ตายตัว ทำให้แถว 15m ได้ค่าเกินจริง 3 เท่า)
    const quality = this._checkQuality({ quote, bars, st, rr, atrValue, dollarVolume5m, trend, breakoutVolRatio, price, confirmLevel, isConfirm, spreadTicks, aboveVwap: Number.isFinite(vwapSeries[n - 1]) ? price > vwapSeries[n - 1] : null });

    // ---------- ประกอบแถว ----------
    const vwapNow = vwapSeries[n - 1];
    const row = {
      symbol, tf, from,
      market: mk.id,          // ★ 'US' | 'TH'
      currency: mk.currency,  // ★ 'USD' | 'THB'
      cur: mk.cur,            // ★ '$' | '฿'
      tick,                   // ★ ช่องราคาขั้นต่ำ ณ ราคานี้
      spreadTicks,            // ★ หุ้นไทย: spread กี่ช่องราคา
      price,
      changePct,
      volume: lastBar.volume,
      dollarVolume5m,
      rvol,
      atr: atrValue,
      atrPct,
      rsi: rsiSeries[n - 1],
      ema5: e5[n - 1],
      ema5Prev: e5[n - 2],
      ema15: e15[n - 1],
      vwap: vwapNow,
      aboveVwap: Number.isFinite(vwapNow) ? price > vwapNow : null,
      spreadPct: quote.spreadPct,

      resistance,
      support,

      // ราคาเป้าหมายแจ้งเตือน
      alertTarget: alert.target,
      alertMode: alert.mode,
      alertLabel: alert.label,
      alertNote: alert.note,
      alertDistancePct: Number.isFinite(alert.target) ? ((alert.target - price) / price) * 100 : null,
      alertTriggered: false,
      alertTriggeredAt: null,
      alertJustTriggered: false,

      // คะแนน + breakdown (กดดูได้ ไม่เป็น black box)
      score: scored.score,
      breakdown: scored.breakdown,
      weightUsed: scored.weightUsed,
      missingFactors: scored.missingFactors,
      unavailableData: scored.unavailableData,
      topReasons: scored.topReasons,

      expectedMove: expMove,
      rr,
      position: pos,

      // ★ v2
      trend,                 // ผล Trend Template + RS (หรือ unavailable)
      breakoutVolRatio,      // วอลุ่มแท่งล่าสุด ÷ ค่าเฉลี่ย 20 แท่ง
      entryMode: st.entryMode,
      planEntry,             // ราคาที่แผนนี้ตั้งใจเข้า (โหมด confirm จะสูงกว่าราคาปัจจุบัน)
      dailyAtr: dailyAtrValue,
      confirmLevel,          // ระดับที่ถือว่าทะลุจริง (null ในโหมด anticipate)

      // สถานะข้อมูล
      dataSource: quote.source,
      barsSource: barsRes.source,
      dataAgeSec: quote.ageSec,
      dataStale: quote.stale,
      stitched: barsRes.stitched,

      // ด่านแข็ง
      passed: quality.passed,
      failReasons: quality.reasons,
      warnings: quality.warnings,

      // เป็น "สัญญาณ" เมื่อ: ผ่านด่านแข็ง + คะแนนถึงเกณฑ์
      isSignal: false,

      news: null,
      earnings: null,
      ts: new Date().toISOString(),
    };

    // เป็นสัญญาณหรือไม่ (ปรับเกณฑ์ตามภาวะตลาด เหมือนโค้ดเดิม)
    const threshold = st.signalScore + (regime.scoreAdj || 0);
    row.signalThreshold = threshold;
    row.isSignal = quality.passed && row.score >= threshold;

    // ---------- ความเสี่ยงจากวันประกาศงบ ----------
    // ไม่คัดออก แต่ติดป้ายเตือน (หุ้นใกล้ประกาศงบ = ผันผวนสูง อาจเป็นทั้งโอกาสและกับดัก)
    try {
      const earn = await getEarnings(symbol);
      row.earnings = earn;
      if (Number.isFinite(earn.daysUntil) && earn.daysUntil >= 0 && earn.daysUntil <= 3) {
        row.warnings.push(`ประกาศงบในอีก ${earn.daysUntil.toFixed(0)} วัน — ความผันผวนสูงผิดปกติ ระวังราคากระโดดข้าม stop`);
      }
    } catch {
      // เช็คไม่ได้ก็ไม่เป็นไร
    }

    // ★ หุ้นไทย: ข้อความอธิบายทั้งหมดถูกเขียนด้วย "$" → เปลี่ยนเป็น "฿" ที่เดียวตรงนี้
    return isTh ? localizeCurrency(row, mk.cur) : row;
  }

  // ---------- ด่านแข็ง: เฉพาะคุณภาพข้อมูล + R:R ----------
  _checkQuality({ quote, bars, st, rr, atrValue, dollarVolume5m, trend, breakoutVolRatio, price, confirmLevel, isConfirm, aboveVwap, spreadTicks = null }) {
    const reasons = [];
    const warnings = [];

    // 1) ราคาเก่าเกินไป
    if (quote.stale) {
      reasons.push(`ข้อมูลไม่อัปเดต (เก่า ${Math.round(quote.ageSec)} วินาที เกินเกณฑ์ ${st.maxQuoteStaleSec} วินาที)`);
    }

    // 2) สงสัยว่าหยุดพักการซื้อขาย (halt)
    const last = bars[bars.length - 1];
    const barAgeSec = (Date.now() - new Date(last.date).getTime()) / 1000;
    if (barAgeSec > st.haltGapSec) {
      warnings.push(`แท่งเทียนล่าสุดเก่า ${Math.round(barAgeSec / 60)} นาที — อาจหยุดพักการซื้อขาย หรือตลาดปิด`);
    }
    if (bars.length >= 3 && bars.slice(-3).every((b) => b.volume === 0)) {
      reasons.push('3 แท่งล่าสุดไม่มีการซื้อขายเลย (สงสัยว่า halt)');
    }

    // 3) spread กว้างเกิน
    // ★ หุ้นไทย: ผ่านถ้า spread ไม่เกิน N ช่องราคา แม้ % จะเกินเกณฑ์ (1 ช่องของ SET อาจกว้างถึง 1% ของราคา)
    const thTicksOk = st.market === 'TH' && Number.isFinite(spreadTicks) && spreadTicks <= (st.maxSpreadTicks ?? 2);
    if (Number.isFinite(quote.spreadPct) && quote.spreadPct > st.maxSpreadPct && !thTicksOk) {
      reasons.push(st.market === 'TH' && Number.isFinite(spreadTicks)
        ? `ส่วนต่าง bid/ask กว้างเกินไป (${spreadTicks} ช่องราคา = ${quote.spreadPct.toFixed(2)}% · เกณฑ์ไม่เกิน ${st.maxSpreadTicks} ช่อง)`
        : `ส่วนต่าง bid/ask กว้างเกินไป (${quote.spreadPct.toFixed(3)}% > ${st.maxSpreadPct}%)`);
    } else if (!Number.isFinite(quote.spreadPct)) {
      warnings.push('ไม่มีข้อมูล bid/ask — ไม่สามารถตรวจ spread ได้ (provider ฟรีบางเจ้าไม่ให้)');
    }

    // 4) มูลค่าซื้อขายต่ำเกิน
    // ใช้ค่าที่ _analyse คำนวณมาให้ (เทียบเป็นต่อ 5 นาทีด้วย tfMinutes จริงของ timeframe นั้น)
    // ⚠️ เดิมคำนวณเองด้วย tfMin=5 ตายตัว → แถว 15m ได้ค่าเกินจริง 3 เท่า
    //    ทำให้หุ้นตัวเดียวกันผ่านด่านบน 15m แต่ตกบน 5m ซึ่งขัดแย้งกันเอง
    if (Number.isFinite(dollarVolume5m) && dollarVolume5m < st.minDollarVolume5m) {
      reasons.push(`มูลค่าซื้อขายต่ำเกินไป ($${(dollarVolume5m / 1e6).toFixed(2)}M < $${(st.minDollarVolume5m / 1e6).toFixed(2)}M เทียบต่อ 5 นาที)`);
    }

    // 5) ATR คำนวณไม่ได้
    if (!Number.isFinite(atrValue) || atrValue <= 0) {
      reasons.push('คำนวณ ATR ไม่ได้ — ประเมินความเสี่ยงไม่ได้');
    }

    // 6) R:R ต่ำกว่าเกณฑ์ (สเปกข้อ 6: "กรองตัวที่ R:R ต่ำกว่า 1:1.5 ออก")
    //    ★ v2: rr.rr ตอนนี้เป็นค่า "สุทธิ" แล้ว (หักต้นทุน spread/คอม/slippage ออกจากกำไร
    //    และบวกต้นทุนเข้าไปในขาขาดทุน) ไม้ที่เป้าใกล้จนต้นทุนกินหมดจึงตกด่านนี้เอง
    if (!rr.ok) {
      reasons.push(`คำนวณ R:R ไม่ได้: ${rr.reason}`);
    } else {
      if (rr.rr < st.minRR) {
        reasons.push(
          `R:R สุทธิต่ำกว่าเกณฑ์ (${rr.label} < 1:${st.minRR})` +
          (Number.isFinite(rr.rrGross) ? ` — ก่อนหักต้นทุนคือ 1:${rr.rrGross.toFixed(2)} ต้นทุนกินไป ${rr.costShareOfReward.toFixed(0)}%` : '')
        );
      }

      // ★ v2 — 7) ไม้เล็กเกินคุ้ม
      // ถึง R:R จะสวย ถ้าเป้าห่างแค่ 0.3% ก็คือเล่นอยู่ในสัญญาณรบกวน
      // การถูกเติมคำสั่งช้าไปครึ่งช่อง (half-tick) ก็เปลี่ยนผลลัพธ์ของไม้ได้ทั้งไม้
      if (Number.isFinite(rr.rewardPctOfPrice) && rr.rewardPctOfPrice < st.minTargetMovePct) {
        reasons.push(
          `ระยะถึงเป้าเล็กเกินไป (${rr.rewardPctOfPrice.toFixed(2)}% < ${st.minTargetMovePct}%) — ` +
          `กำไรที่เป็นไปได้อยู่ในระดับเดียวกับสัญญาณรบกวนและต้นทุน`
        );
      }
    }

    // ═══ ★ v2 — 8) ด่านแนวโน้มระยะกลาง (Trend Template) ═══
    //
    // ทำไมเป็น "ด่านแข็ง" ไม่ใช่ "ปัจจัยคะแนน":
    // ถ้าเป็นคะแนน หุ้นที่แนวโน้มแย่แต่ RVOL พุ่งแรงก็ยังผ่านได้ด้วยคะแนนรวม
    // ซึ่งเป็นสิ่งที่เกิดขึ้นจริงกับ AAPL ใน signals-history.json (score 66.7 ทั้งที่ลง 1.2% และอยู่ใต้ VWAP)
    // Minervini ไม่ให้คะแนนเกณฑ์พวกนี้ เขา "ต้องการ" มัน — ถ้าไม่เข้าก็ไม่ดู
    //
    // ข้อยกเว้น: ไม่มีข้อมูลรายวัน ≠ ข้อมูลแย่ → เป็นคำเตือน ไม่ใช่การตกด่าน
    if (st.requireTrendTemplate) {
      if (!trend || trend.unavailable) {
        warnings.push(`ตรวจแนวโน้มระยะกลางไม่ได้ (${trend?.reason || 'ไม่มีข้อมูล'}) — ข้ามด่านนี้ไป ไม่ได้แปลว่าแนวโน้มดี`);
      } else if (trend.passCount < st.minTrendChecks) {
        const failed = trend.checks.filter((c) => !c.pass).map((c) => c.label);
        reasons.push(
          `แนวโน้มระยะกลางไม่เข้าเกณฑ์ (ผ่าน ${trend.passCount}/${trend.totalChecks} ต้องผ่าน ${st.minTrendChecks}) — ` +
          `ตกข้อ: ${failed.join(', ')}`
        );
      } else if (Number.isFinite(trend.rsScore) && trend.rsScore < st.minRsScore) {
        reasons.push(`อ่อนกว่าตลาด (RS ${trend.rsScore.toFixed(0)} < ${st.minRsScore} เทียบ ${trend.rsBenchmark})`);
      }
    }

    // ═══ ★ v2 — 9) ห้ามซื้อใต้ VWAP ของวัน ═══
    // VWAP คือราคาเฉลี่ยที่เงินจริงเข้าซื้อขายกันวันนี้ อยู่ใต้มันแปลว่าคนที่ซื้อวันนี้ส่วนใหญ่ติดดอย
    // ทุกการเด้งขึ้นจะเจอแรงขายของคนที่รอเท่าทุน — เป็นเหตุผลตรงๆ ที่ไม้กำไรน้อย
    if (st.requireAboveVwap && aboveVwap === false) {
      reasons.push('ราคาอยู่ใต้ VWAP ของวัน — แรงขายของคนที่ติดอยู่ด้านบนจะกดทุกการเด้ง');
    }

    // ═══ ★ v2 — 10) ยืนยันการเบรกด้วยวอลุ่ม (เสี่ยยักษ์) ═══
    // ใช้เฉพาะโหมด confirm และเฉพาะเมื่อ "ทะลุไปแล้วจริง"
    // ถ้ายังไม่ทะลุ ถือเป็นแผนที่รออยู่ ยังไม่ต้องมีวอลุ่ม — แค่ติดคำเตือนไว้
    if (isConfirm && Number.isFinite(confirmLevel) && Number.isFinite(price)) {
      const broken = price >= confirmLevel;
      if (broken) {
        if (!Number.isFinite(breakoutVolRatio)) {
          warnings.push('ทะลุแนวต้านแล้วแต่ตรวจวอลุ่มแท่งเบรกไม่ได้ (แท่งเทียนไม่พอ)');
        } else if (breakoutVolRatio < st.breakoutRvolMin) {
          reasons.push(
            `ทะลุแนวต้านแล้วแต่ไม่มีวอลุ่มยืนยัน (แท่งล่าสุด ${breakoutVolRatio.toFixed(2)}× ` +
            `ของค่าเฉลี่ย 20 แท่ง ต้อง ≥ ${st.breakoutRvolMin}×) — การเบรกที่ไม่มีเงินตามมักย้อนกลับ`
          );
        }
      } else {
        warnings.push(
          `ยังไม่ทะลุ — รอราคาขึ้นเหนือ $${confirmLevel.toFixed(2)} พร้อมวอลุ่ม ≥ ${st.breakoutRvolMin}× จึงจะนับเป็นสัญญาณ`
        );
      }
    }

    return { passed: reasons.length === 0, reasons, warnings };
  }

  // ---------- แถวสำหรับหุ้นที่ดึงข้อมูลไม่ได้ ----------
  // สเปกข้อ 5: "ถ้าดึงข้อมูลไม่ได้ ให้ขึ้นเตือนใน UI ชัดๆ ว่าข้อมูลไม่อัปเดต แทนที่จะเงียบ"
  _errorRow({ symbol, tf, from, reason, manualTarget }) {
    const fail = getLastFailure('bars', symbol) || getLastFailure('quote', symbol);
    const mk = MARKETS[marketOf(symbol)];
    return {
      symbol, tf, from,
      market: mk.id, currency: mk.currency, cur: mk.cur, // ★
      price: null, changePct: null, score: 0,
      dataError: true,
      dataStale: true,
      dataSource: null,
      failReasons: [reason],
      warnings: [],
      passed: false,
      isSignal: false,
      breakdown: [],
      topReasons: [`⚠️ ข้อมูลไม่อัปเดต — ${reason}`],
      alertTarget: Number.isFinite(Number(manualTarget)) ? Number(manualTarget) : null,
      alertMode: Number.isFinite(Number(manualTarget)) ? 'manual' : 'none',
      alertLabel: Number.isFinite(Number(manualTarget)) ? 'ตั้งเอง' : 'ยังคำนวณไม่ได้',
      alertNote: 'ไม่สามารถตรวจราคาได้รอบนี้',
      resistance: null,
      rr: { ok: false, reason },
      position: { shares: 0 },
      expectedMove: { pct: null, label: '—' },
      providerDetail: fail?.message || null,
      ts: new Date().toISOString(),
    };
  }

  // ---------- ดึงข้อมูลที่ "แพง" เฉพาะ top N (ประหยัดโควตา) ----------
  // สเปกข้อ 5.5: "เรียกเฉพาะหุ้นที่ผ่านเกณฑ์คัดกรองชั้นแรกแล้วเท่านั้น"
  // ข้อมูลที่ดึงตรงนี้:
  //   - ข่าว + sentiment (Alpha Vantage ฟรีแค่ 25 ครั้ง/วัน)
  //   - float + short interest (FMP ฟรี 250 ครั้ง/วัน) → ใช้ประเมินโอกาส squeeze
  async _enrichTopCandidates(rows, st) {
    const topN = st.sentimentTopN;
    if (!topN || topN <= 0) return;

    // ★ หุ้นไทยไม่มีแหล่งข่าว/float ฟรี — ข้าม (และไม่คิดคะแนนใหม่ด้วยสูตรของหุ้นอเมริกา)
    const candidates = rows
      .filter((r) => r.passed && !r.dataError && (r.market || 'US') === 'US')
      .slice(0, topN);

    for (const row of candidates) {
      if (this._abort) break;
      try {
        const news = await getNews(row.symbol);
        row.news = news;

        // ---------- float + short interest (สเปกข้อ 5.5 ข้อ 5) ----------
        // best-effort: ถ้า free tier ไม่ให้ จะได้ unavailable กลับมา ไม่ throw
        const fund = await getFundamentals(row.symbol);
        row.fundamentals = fund;

        // float น้อย + short สูง = โอกาสเคลื่อนไหวแรง (short squeeze)
        // ⚠️ เป็นข้อสังเกตประกอบ ไม่ได้เอาไปบวกคะแนน เพราะข้อมูลมักไม่ครบ
        //    ถ้าเอาไปบวกคะแนน หุ้นที่ไม่มีข้อมูลจะเสียเปรียบโดยไม่มีเหตุผล
        if (Number.isFinite(fund?.floatShares) && fund.floatShares < 50_000_000) {
          row.warnings.push(`float ต่ำ (${(fund.floatShares / 1e6).toFixed(1)} ล้านหุ้น) — ราคาขยับง่ายทั้งขึ้นและลง`);
        }
        if (Number.isFinite(fund?.shortPct) && fund.shortPct > 15) {
          row.warnings.push(`short interest สูง (${fund.shortPct.toFixed(1)}% ของ float) — มีโอกาสเกิด short squeeze แต่ก็เสี่ยงผันผวนรุนแรง`);
        }

        // คำนวณคะแนนใหม่พร้อม sentiment จริง
        const rescored = computeScore({
          rvol: row.rvol,
          dailyAtrPct: row.expectedMove?.pct ?? null,
          resistance: row.resistance,
          // ⚠️ ต้องส่ง ema5Prev ด้วย ไม่งั้นปัจจัยความชัน EMA จะหายไปเฉพาะแถว top N
          // ทำให้แถวเหล่านั้นคิดคะแนนด้วยสูตรที่ต่างจากแถวอื่น
          momentum: {
            changePct: row.changePct, ema5: row.ema5, ema15: row.ema15,
            ema5Prev: row.ema5Prev, price: row.price,
          },
          news,
          liquidity: { spreadPct: row.spreadPct, dollarVolume5m: row.dollarVolume5m },
        }, st.weights, {
          renormalize: st.renormalizeWeights,
          atrPctLow: st.atrPctLow,
          atrPctHigh: st.atrPctHigh,
        });

        row.score = rescored.score;
        row.breakdown = rescored.breakdown;
        row.weightUsed = rescored.weightUsed;
        row.missingFactors = rescored.missingFactors;
        row.unavailableData = rescored.unavailableData;
        row.topReasons = rescored.topReasons;
        row.isSignal = row.passed && row.score >= (row.signalThreshold ?? st.signalScore);
      } catch (err) {
        log.warn(`ดึงข่าว ${row.symbol} ไม่สำเร็จ: ${err.message}`);
      }
    }
  }
}

function emptySummary() {
  return {
    scanned: 0, rowsProduced: 0, hiddenByScore: 0, signals: 0, filteredByRR: 0,
    regime: '—', regimeSizeMult: 1, marketOpen: false, staleCount: 0,
    durationMs: 0, topRejects: [], note: null,
    openTrades: 0, dayR: 0, tradingHalted: false, screenerFailures: [], // ★ v2
  };
}

// ---------- แปลงแถวเป็นบันทึกสัญญาณสำหรับ backtest ----------
// เก็บทุกอย่างที่ backtest ต้องใช้ + breakdown เต็ม (เพื่อวิเคราะห์ย้อนหลังได้ว่าปัจจัยไหนได้ผลจริง)
function toSignalRecord(row) {
  return {
    ts: row.ts,
    symbol: row.symbol,
    tf: row.tf,
    market: row.market || 'US', // ★ หุ้นไทย
    // ★ v2
    entryMode: row.entryMode,
    planEntry: row.planEntry,
    rrNet: row.rr?.rr ?? null,
    rrGross: row.rr?.rrGross ?? null,
    costPerShare: row.rr?.costPerShare ?? null,
    rewardPctOfPrice: row.rr?.rewardPctOfPrice ?? null,
    riskUnitBasis: row.rr?.riskUnitBasis ?? null,
    dailyAtr: row.dailyAtr ?? null,
    trendPassCount: row.trend?.unavailable ? null : (row.trend?.passCount ?? null),
    rsScore: row.trend?.rsScore ?? null,
    breakoutVolRatio: row.breakoutVolRatio ?? null,
    from: row.from,
    score: row.score,
    signalThreshold: row.signalThreshold,
    // ★ v2: entry ของแผนคือ planEntry (โหมด confirm เข้าเหนือแนวต้าน ไม่ใช่ที่ราคาปัจจุบัน)
    // เก็บ marketPrice ไว้คู่กันเพื่อให้ backtest รู้ว่าตอนให้สัญญาณราคาอยู่ตรงไหน
    entry: row.planEntry ?? row.price,
    marketPrice: row.price,
    stop: row.rr?.stop ?? null,
    // target = แนวต้าน (เป้าอนุรักษ์นิยม) · targetBreakout = เป้าที่ใช้คำนวณ R:R จริง
    // ⚠️ ต้องบันทึกทั้งคู่ ไม่งั้น backtest จะประเมินด้วยเป้าที่ต่างจากที่ R:R ใช้
    //    (บั๊กเดิม: backtest อ่าน sig.targetBreakout ที่ไม่เคยถูกเขียน จึงตกไปใช้ target แทน
    //     ทำให้ win rate / expectancy คลาดจากสัญญาณที่ระบบให้ไว้จริง)
    target: row.resistance?.level ?? null,
    targetBreakout: row.rr?.targetBreakout ?? null,
    rrConservative: row.rr?.rrConservative ?? null,
    alertTarget: row.alertTarget,
    alertMode: row.alertMode,
    rr: row.rr?.rr ?? null,
    risk: row.rr?.risk ?? null,
    shares: row.position?.shares ?? 0,
    rvol: row.rvol,
    atr: row.atr,
    atrPct: row.atrPct,
    rsi: row.rsi,
    changePct: row.changePct,
    aboveVwap: row.aboveVwap,
    expectedMovePct: row.expectedMove?.pct ?? null,
    resistanceMethod: row.resistance?.method ?? null,
    resistanceTouches: row.resistance?.touches ?? null,
    newsSentiment: row.news?.sentiment ?? null,
    // breakdown ย่อ (เก็บแค่คะแนนต่อปัจจัย ไม่เก็บข้อความ เพื่อไม่ให้ไฟล์โต)
    factors: Object.fromEntries((row.breakdown || []).map((f) => [f.key, f.normalized])),
    reasons: row.topReasons || [],
    dataSource: row.dataSource,
  };
}

export const scanner = new ScannerEngine();
