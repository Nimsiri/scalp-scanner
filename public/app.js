/* app.js — ฝั่งเบราว์เซอร์: รับข้อมูลจาก Socket.IO แล้ววาดหน้าเว็บ
 *
 * ไม่ใช้ localStorage (ตามข้อกำหนดของสภาพแวดล้อม) — เก็บสถานะไว้ในตัวแปรในหน่วยความจำ
 * สถานะปุ่มทั้งหมดมาจาก server ("state" event) ไม่ใช่การเดาฝั่ง client
 * → กด Start จากอีกแท็บ แท็บนี้ก็เห็นสถานะถูกต้องทันที
 */

const socket = io();

// ---------- สถานะในหน่วยความจำ ----------
let state = { running: false, scanning: false, market: {}, summary: {} };
let rows = [];
let watchlist = [];
let alertStates = {};
let tradeState = { open: [], closed: [], day: {}, limits: {} }; // ★ v2
// ★ v2.1 + หลายคู่เงิน: byPair[pair] = { data, error } · pairs = ลำดับที่แสดง
let fxState = { pairs: [], byPair: {}, currencies: [], alertState: {}, maxPairs: 8 };
let fxActive = null; // คู่ที่กำลังดูอยู่ในการ์ด (จำในหน่วยความจำ เปิดหน้าใหม่กลับไปคู่หลัก)
let appSettings = {}; // ★ ค่าตั้งค่าล่าสุดจาก server — ใช้กับแผง "กฎแจ้งเตือน"
let soundOn = true;
let autoScroll = true;
let filterOnlyPassed = false;
let filterOnlyWatch = false;
let marketTab = null; // ★ ตลาดที่เลือกดูในตาราง (null = อัตโนมัติตามตลาดที่เปิดอยู่)
const expanded = new Set();     // แถวที่กางดู breakdown อยู่
const alertedThisSession = new Set(); // กันเล่นเสียงซ้ำในหน้าเดียวกัน

const $ = (id) => document.getElementById(id);

// ═══════════════ ตัวช่วยจัดรูปแบบ ═══════════════
const fmtMoney = (v, d = 2, cur = '$') => (Number.isFinite(v) ? `${cur}${v.toFixed(d)}` : '—');
// ★ หุ้นไทย (.BK) — แสดงเงินเป็น ฿ และตัด .BK ออกตอนแสดงชื่อในตาราง
const mktOf = (sym) => (/\.BK$/i.test(sym || '') || /^\^SET/i.test(sym || '') ? 'TH' : 'US');
const curOf = (x) => (x && typeof x === 'object' && x.cur) || (mktOf(typeof x === 'string' ? x : x?.symbol) === 'TH' ? '฿' : '$');
const dispSym = (sym) => String(sym || '').replace(/\.BK$/i, '');
const setTag = (sym) => (mktOf(sym) === 'TH'
  ? '<span class="px-1.5 py-px rounded bg-slate-800 text-slate-400 text-[9px] font-semibold tracking-wide" title="หุ้นไทย (ตลาดหลักทรัพย์ฯ)">SET</span>' : '');
const fmtNum = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const fmtPct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : '—');
// เรตค่าเงิน: ทศนิยมตามขนาด — 33.5800 · 0.21120 · 0.024704 (ตรงกับ fmtRate ใน src/fx.js)
const fmtRate = (v) => {
  if (!Number.isFinite(v)) return '—';
  const d = v > 0 ? Math.min(8, Math.max(4, 4 - Math.floor(Math.log10(v)))) : 4;
  return v.toFixed(d);
};

function fmtVol(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// สีตามคะแนน
function scoreColor(s) {
  if (!Number.isFinite(s)) return 'text-slate-500';
  if (s >= 80) return 'text-emerald-400';
  if (s >= 70) return 'text-green-400';
  if (s >= 55) return 'text-yellow-400';
  if (s >= 40) return 'text-orange-400';
  return 'text-slate-400';
}

// ═══════════════ เสียงเตือน (Web Audio API — ไม่ต้องมีไฟล์ mp3) ═══════════════
let audioCtx = null;
function playAlertSound() {
  if (!soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // บี๊บสองครั้ง 880Hz แล้ว 1180Hz — สั้น ไม่รบกวน แต่ได้ยินชัด
    const beep = (freq, startAt, dur) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // ทำ envelope กัน pop เวลาเริ่ม/หยุดเสียง
      gain.gain.setValueAtTime(0, audioCtx.currentTime + startAt);
      gain.gain.linearRampToValueAtTime(0.22, audioCtx.currentTime + startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + startAt + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + startAt);
      osc.stop(audioCtx.currentTime + startAt + dur + 0.02);
    };
    beep(880, 0, 0.16);
    beep(1180, 0.19, 0.20);
  } catch (err) {
    console.warn('เล่นเสียงไม่ได้:', err.message);
  }
}

// ═══════════════ Browser Notification ═══════════════
function requestNotifyPermission(explicit = false) {
  if (!('Notification' in window)) {
    if (explicit) toast('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน', 'error');
    return;
  }
  if (Notification.permission === 'granted') {
    if (explicit) toast('เปิดการแจ้งเตือนอยู่แล้ว ✓', 'ok');
    updateNotifyButton();
    return;
  }
  if (Notification.permission === 'denied') {
    if (explicit) toast('การแจ้งเตือนถูกปิดไว้ — ต้องเปิดในการตั้งค่าเบราว์เซอร์ (ไอคอนรูปกุญแจข้าง URL)', 'error');
    return;
  }
  Notification.requestPermission().then(() => updateNotifyButton());
}

function updateNotifyButton() {
  const btn = $('btnNotify');
  if (!('Notification' in window)) { btn.textContent = '🔔 เบราว์เซอร์ไม่รองรับ'; btn.disabled = true; return; }
  const p = Notification.permission;
  btn.textContent = p === 'granted' ? '🔔 การแจ้งเตือน: เปิดอยู่'
                  : p === 'denied' ? '🔕 การแจ้งเตือน: ถูกปิด'
                  : '🔔 เปิดการแจ้งเตือนเบราว์เซอร์';
  btn.className = p === 'granted' ? 'btn btn-sm btn-ok' : 'btn btn-sm btn-ghost';
}

function showNotification(payload) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`🔔 ${payload.symbol} แตะจุดแจ้งเตือน`, {
      body: `ราคา ${fmtMoney(payload.price, 2, curOf(payload.symbol))} · เป้า ${fmtMoney(payload.target, 2, curOf(payload.symbol))} (${payload.label})\n` +
            'เครื่องมือช่วยคัดกรอง ไม่ใช่คำแนะนำการลงทุน',
      tag: `alert-${payload.symbol}`, // tag เดียวกันจะทับกัน ไม่กองเป็นพะเนิน
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (err) {
    console.warn('แจ้งเตือนไม่ได้:', err.message);
  }
}

// ═══════════════ toast ═══════════════
function toast(msg, kind = 'ok') {
  const box = $('addResult');
  const cls = kind === 'error' ? 'bg-red-950/60 border-red-700 text-red-200'
            : kind === 'warn' ? 'bg-amber-950/60 border-amber-700 text-amber-200'
            : 'bg-emerald-950/60 border-emerald-700 text-emerald-200';
  box.className = `mb-3 text-sm rounded-xl px-4 py-2.5 border ${cls}`;
  box.innerHTML = msg;
  box.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => box.classList.add('hidden'), 9000);
}

// ★ ตลาดที่เปิดอยู่ตอนนี้ (ถ้าเปิดอยู่ตลาดเดียว) — ใช้เลือกว่าจะแสดงอะไรก่อน
function openMarketNow() {
  const ms = state.markets || {};
  const open = ['US', 'TH'].filter((k) => ms[k] && ms[k].enabled !== false && ms[k].scanOpen);
  return open.length === 1 ? open[0] : null;
}
const MKT_SHORT = { US: 'US', TH: 'ไทย' };

// ★ ภาวะตลาด: ถ้ามีผลของทั้งสองตลาด แสดงคู่กัน โดยตลาดที่เปิดอยู่ขึ้นก่อน
function regimeLabel(s) {
  const rg = s?.regimes || {};
  const open = openMarketNow();
  const keys = ['US', 'TH'].filter((k) => rg[k]?.regime).sort((a, b) => (b === open) - (a === open));
  if (keys.length > 1) return keys.map((k) => `${MKT_SHORT[k]} ${rg[k].regime}`).join(' · ');
  return s?.regime || '—';
}

// ═══════════════ วาดแถบสถานะ + ปุ่ม ═══════════════
function renderState() {
  const m = state.market || {};

  $('runDot').className = `w-2.5 h-2.5 rounded-full ${
    state.scanning ? 'bg-blue-400 animate-pulse'
    : state.running ? 'bg-emerald-400 animate-pulse'
    : 'bg-slate-600'}`;
  $('runText').textContent = state.scanning ? 'กำลังสแกน…' : state.running ? 'กำลังทำงาน' : 'หยุดอยู่';
  $('runText').className = state.running || state.scanning ? 'text-emerald-400' : 'text-slate-400';

  const usOn = m.enabled !== false;
  $('marketText').textContent = !usOn ? 'ปิดใช้' : m.open ? '● เปิด' : '● ปิด';
  $('marketText').className = !usOn ? 'text-slate-500' : m.open ? 'text-emerald-400' : 'text-red-400';
  $('sessionText').textContent = `${m.session || '—'} (${m.actualPhaseLabel || '—'})`;
  $('nyTime').textContent = m.nyTime || '—';
  $('lastScan').textContent = fmtTime(state.lastScanAt);
  $('regimeText').textContent = regimeLabel(state.summary);

  // ★ หุ้นไทย
  const th = state.markets?.TH;
  const thOn = !!th && th.enabled !== false;
  if (th) {
    $('thMarketText').textContent = !thOn ? 'ปิดใช้' : th.open ? `● เปิด · ${th.actualPhaseLabel}` : `● ${th.actualPhaseLabel}`;
    $('thMarketText').className = !thOn ? 'text-slate-500' : th.open ? 'text-emerald-400' : th.inDelayTail ? 'text-amber-400' : 'text-red-400';
    $('thTime').textContent = th.localTime || '';
  }

  const reasons = [];
  if (usOn && m.reason) reasons.push(`${thOn ? 'หุ้นอเมริกา: ' : ''}${m.reason}` + (m.nextChangeLabel ? ` — ${m.nextChangeLabel}` : ''));
  if (thOn && th.reason) reasons.push(`หุ้นไทย: ${th.reason}` + (th.nextChangeLabel ? ` — ${th.nextChangeLabel}` : ''));
  if (reasons.length) {
    $('marketReason').textContent = `ℹ️ ${reasons.join('  ·  ')}`;
    $('marketReason').classList.remove('hidden');
  } else {
    $('marketReason').classList.add('hidden');
  }

  // ---------- ปุ่มเปลี่ยนสี/สถานะตามที่ scanner ทำงานอยู่จริง (สเปกข้อ 2) ----------
  const bStart = $('btnStart');
  const bStop = $('btnStop');
  const bNow = $('btnScanNow');

  bStart.disabled = state.running;
  bStop.disabled = !state.running;
  bNow.disabled = state.scanning;

  bStart.className = 'btn btn-lg ' + (state.running ? 'btn-idle' : 'btn-primary');
  bStop.className = 'btn btn-lg ' + (state.running ? 'btn-danger' : 'btn-idle');
  bNow.className = 'btn btn-lg ' + (state.scanning ? 'btn-idle' : 'btn-plum');
  const icon = window.themeIcon || (() => '');
  bNow.innerHTML = state.scanning
    ? `<span class="animate-spin inline-flex">${icon('loader')}</span>กำลังสแกน…`
    : `${icon('refresh')}Scan Now`;

  if (state.mockMode) $('mockBanner').classList.remove('hidden');
}

// นับถอยหลังรอบถัดไป
setInterval(() => {
  if (!state.running || !state.nextScanAt) { $('nextScan').textContent = state.running ? 'กำลังสแกน…' : '—'; return; }
  const s = Math.max(0, Math.round((state.nextScanAt - Date.now()) / 1000));
  $('nextScan').textContent = `${s} วินาที`;
}, 500);

// ═══════════════ วาดการ์ดสรุป ═══════════════
function renderSummary() {
  const s = state.summary || {};
  $('sumScanned').textContent = s.scanned ?? 0;
  $('sumSignals').textContent = s.signals ?? 0;
  $('sumPassed').textContent = rows.filter((r) => r.passed).length;
  $('sumAlerts').textContent = rows.filter((r) => r.alertTriggered).length;
  $('sumStale').textContent = rows.filter((r) => r.dataStale || r.dataError).length;
  // ★ การ์ดภาวะตลาด: ตลาดที่เปิดอยู่เป็นตัวหลัก อีกตลาดอยู่ในบรรทัดเล็ก
  {
    const rg = s.regimes || {};
    const open = openMarketNow();
    const main = open && rg[open] ? rg[open] : { regime: s.regime, sizeMult: s.regimeSizeMult };
    const others = ['US', 'TH'].filter((k) => k !== open && rg[k]?.regime && open);
    $('sumRegime').textContent = main.regime || '—';
    $('sumRegimeNote').textContent = [
      open && rg[open] ? (open === 'TH' ? 'หุ้นไทย' : 'หุ้นอเมริกา') : null,
      Number.isFinite(main.sizeMult) ? `ตัวคูณขนาดไม้ ×${main.sizeMult}` : null,
      ...others.map((k) => `${MKT_SHORT[k]} ${rg[k].regime}`),
    ].filter(Boolean).join(' · ');
  }

  // ★ v2
  const day = tradeState.day || {};
  const lim = tradeState.limits || {};
  $('sumOpenTrades').textContent = (tradeState.open || []).length;
  $('sumOpenLimit').textContent = lim.maxOpenTrades ? `สูงสุด ${lim.maxOpenTrades} ไม้` : '';
  const dayR = Number.isFinite(day.realizedR) ? day.realizedR : 0;
  const dayEl = $('sumDayR');
  dayEl.textContent = `${dayR >= 0 ? '+' : ''}${dayR.toFixed(2)}R`;
  dayEl.className = `stat-value num ${dayR > 0 ? 'text-emerald-400' : dayR < 0 ? 'text-red-400' : 'text-slate-300'}`;
  $('sumDayNote').textContent = `ชนะ ${day.wins || 0} · แพ้ ${day.losses || 0}` +
    (Number.isFinite(lim.dailyLossLimitR) ? ` · เหลือได้อีก ${Math.max(0, lim.remainingR ?? 0).toFixed(2)}R` : '');

  // แบนเนอร์ข้อมูลไม่อัปเดต (สเปกข้อ 5) + ★ screener ล้ม
  const stale = rows.filter((r) => r.dataStale || r.dataError);
  const brokenScr = s.screenerFailures || [];
  const banner = $('staleBanner');
  if (stale.length === 0 && brokenScr.length > 0) {
    banner.innerHTML = `⚠️ <b>auto screener ดึงข้อมูลไม่สำเร็จ</b> (${esc(brokenScr.map((f) => f.scrId).join(', '))}) — ` +
      esc(String(brokenScr[0].reason).slice(0, 200)) +
      ' · หุ้นที่เห็นอยู่มาจากรายการเฝ้าดูเท่านั้น';
    banner.classList.remove('hidden');
  } else if (stale.length > 0) {
    banner.innerHTML = `⚠️ <b>ข้อมูลไม่อัปเดต ${stale.length} รายการ</b> — ` +
      esc(stale.slice(0, 6).map((r) => r.symbol).join(', ')) +
      (stale.length > 6 ? ` และอีก ${stale.length - 6} ตัว` : '') +
      ' · ตัวเลขของรายการเหล่านี้อาจไม่ใช่ราคาปัจจุบัน (ดูรายละเอียดในตาราง)';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ═══════════════ วาด Watchlist ═══════════════
function renderWatchlist() {
  $('wlCount').textContent = watchlist.length ? `(${watchlist.length} ตัว)` : '(ยังไม่มี)';
  const box = $('wlChips');

  if (watchlist.length === 0) {
    box.innerHTML = '<p class="text-sm text-slate-500">ยังไม่มีหุ้นในรายการ — พิมพ์ Ticker ด้านบนแล้วกดเพิ่ม</p>';
    return;
  }

  box.innerHTML = watchlist.map((w) => {
    const row = rows.find((r) => r.symbol === w.symbol);
    const a = alertStates[w.symbol];
    const triggered = !!a?.triggeredAt;
    const manual = Number.isFinite(w.targetPrice);

    return `
      <div class="flex items-center gap-2 rounded-full border pl-4 pr-1.5 py-1.5 shadow-sm ${
        triggered ? 'bg-amber-950 border-amber-700' : 'bg-slate-900 border-slate-700'}">
        <b class="text-sm" title="${esc(w.symbol)}">${esc(dispSym(w.symbol))}</b>${setTag(w.symbol)}
        <span class="text-xs text-slate-400 num">${row?.price != null ? fmtMoney(row.price, 2, curOf(w.symbol)) : '—'}</span>
        <input type="number" step="0.01" min="0" value="${manual ? w.targetPrice : ''}"
               placeholder="${row?.alertTarget != null && !manual ? row.alertTarget.toFixed(2) : 'auto'}"
               title="${manual ? 'ราคาเป้าหมายที่ตั้งเอง' : 'เว้นว่าง = ใช้แนวต้าน −0.1% อัตโนมัติ'}"
               class="w-24 px-2.5 py-1 rounded-full bg-slate-950 border ${manual ? 'border-sky-500' : 'border-slate-700'} text-xs num focus:outline-none focus:border-sky-500"
               onchange="setTarget('${esc(w.symbol)}', this.value)">
        ${triggered ? `<button onclick="resetAlert('${esc(w.symbol)}')" title="รีเซ็ตการเตือน — เตือนใหม่ได้เมื่อราคาแตะเป้าอีกครั้ง"
            class="text-[10px] px-2 py-1 rounded-full bg-amber-900 text-amber-300 hover:bg-amber-600 hover:text-white">↺ reset</button>` : ''}
        <button onclick="removeTicker('${esc(w.symbol)}')" title="ลบออกจากรายการ"
          class="w-6 h-6 rounded-full text-slate-500 hover:text-red-400 hover:bg-red-950 text-xs leading-none">✕</button>
      </div>`;
  }).join('');
}

// ═══════════════ วาดตารางหุ้น ═══════════════
// ★ ตลาดที่แสดงในตาราง: ที่ผู้ใช้เลือก หรือ (อัตโนมัติ) ตลาดที่เปิดอยู่ตลาดเดียว ไม่งั้นแสดงทั้งหมด
function effectiveMarketTab() {
  if (marketTab) return marketTab;
  const ms = state.markets || {};
  const open = ['US', 'TH'].filter((k) => ms[k] && ms[k].enabled !== false && ms[k].scanOpen);
  return open.length === 1 ? open[0] : 'all';
}

function renderRows() {
  const tbody = $('tbody');
  let list = rows;

  // ★ แท็บตลาด + จำนวนแถวของแต่ละตลาด
  const tab = effectiveMarketTab();
  const radio = document.querySelector(`input[name="mktTab"][value="${tab}"]`);
  if (radio && !radio.checked) radio.checked = true;
  const cnt = { all: rows.length, US: 0, TH: 0 };
  for (const r of rows) cnt[r.market || mktOf(r.symbol)] += 1;
  document.querySelectorAll('[data-mkt-count]').forEach((el) => { el.textContent = cnt[el.dataset.mktCount] || ''; });
  if (tab !== 'all') list = list.filter((r) => (r.market || mktOf(r.symbol)) === tab);

  if (filterOnlyPassed) list = list.filter((r) => r.passed);
  if (filterOnlyWatch) list = list.filter((r) => r.from === 'watchlist');

  $('emptyState').classList.toggle('hidden', list.length > 0);
  if (list.length === 0) { tbody.innerHTML = ''; return; }

  tbody.innerHTML = list.map((r) => {
    const key = `${r.symbol}:${r.tf}`;
    const isOpen = expanded.has(key);
    const c = curOf(r); // ★ $ | ฿

    let rowCls = 'border-b border-slate-800/70 hover:bg-sky-950 cursor-pointer transition-colors';
    if (r.alertTriggered) rowCls += ' row-alert';
    else if (r.dataStale || r.dataError) rowCls += ' row-stale';
    else if (!r.passed) rowCls += ' row-failed';

    // ---------- สถานะ ----------
    const badges = [];
    if (r.dataError) badges.push('<span class="px-2 py-0.5 rounded-full bg-red-900/70 text-red-200 text-[10px]">⚠ ข้อมูลไม่อัปเดต</span>');
    else if (r.dataStale) badges.push(`<span class="px-2 py-0.5 rounded-full bg-red-900/70 text-red-200 text-[10px]">⚠ ราคาเก่า ${Math.round(r.dataAgeSec)}s</span>`);
    if (r.alertTriggered) badges.push('<span class="px-2 py-0.5 rounded-full bg-amber-600 text-white text-[10px] font-bold">🔔 แตะเป้าแล้ว</span>');
    if (r.isSignal) badges.push('<span class="px-2 py-0.5 rounded-full bg-emerald-600 text-white text-[10px] font-bold">✓ สัญญาณ</span>');
    else if (r.passed) badges.push('<span class="px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 text-[10px]">ผ่านด่าน</span>');
    else if (!r.dataError) badges.push('<span class="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[10px]">ตกด่าน</span>');
    if (r.warnings?.length) badges.push(`<span class="px-2 py-0.5 rounded-full bg-orange-900/60 text-orange-200 text-[10px]" title="${esc(r.warnings.join(' | '))}">⚠ ${r.warnings.length}</span>`);
    if (r.from === 'screener') badges.push('<span class="px-2 py-0.5 rounded-full bg-indigo-900/60 text-indigo-200 text-[10px]">screener</span>');
    if (r.from === 'universe') badges.push('<span class="px-2 py-0.5 rounded-full bg-indigo-900/60 text-indigo-200 text-[10px]" title="จากรายชื่อหุ้นไทยตั้งต้น (แก้ได้ในหน้า Settings)">กลุ่มหุ้นไทย</span>');

    // ---------- ที่มาของเป้า (สเปกข้อ 4: บอกชัดว่า "ตั้งเอง" หรือ "auto") ----------
    const modeBadge = r.alertMode === 'manual'
      ? '<span class="px-2 py-0.5 rounded-full bg-sky-800 text-sky-100 text-[10px] font-semibold">ตั้งเอง</span>'
      : r.alertMode === 'auto'
      ? `<span class="px-2 py-0.5 rounded-full bg-slate-700 text-slate-200 text-[10px]" title="${esc(r.alertNote || '')}">${esc(r.alertLabel || 'auto')}</span>`
      : r.alertMode === 'confirm'
      ? `<span class="px-2 py-0.5 rounded-full bg-slate-700 text-slate-200 text-[10px]" title="${esc(r.alertNote || '')}">${esc(r.alertLabel || 'ยืนยันเบรก')}</span>`
      : `<span class="px-2 py-0.5 rounded-full bg-slate-800 text-slate-500 text-[10px]" title="${esc(r.alertNote || '')}">คำนวณไม่ได้</span>`;

    // ---------- แนวต้าน ----------
    const resCell = r.resistance?.level != null
      ? `<div class="num">${fmtMoney(r.resistance.level, 2, c)}</div>
         <div class="text-[10px] ${r.resistance.confirmed ? 'text-emerald-500' : 'text-amber-500'}"
              title="${esc(r.resistance.note || '')}">
           ${r.resistance.confirmed ? `ยืนยัน ·ชน ${r.resistance.touches}×` : (r.resistance.method === 'projected' ? 'ประมาณ' : 'ไม่ยืนยัน')}
         </div>`
      : '<span class="text-slate-600">—</span>';

    const rrCell = r.rr?.ok
      ? `<span class="${r.rr.rr >= 2 ? 'text-emerald-400' : r.rr.rr >= 1.5 ? 'text-green-400' : 'text-orange-400'}"
              title="${esc(r.rr.note || '')}">${esc(r.rr.label)}</span>`
      : '<span class="text-slate-600" title="' + esc(r.rr?.reason || '') + '">—</span>';

    // ★ v2 — ปุ่มเปิดไม้: กดได้เฉพาะแผนที่ผ่านด่านและมีขนาดไม้จริง
    const canOpen = r.passed && (r.position?.shares || 0) > 0 && !r.dataError;
    const alreadyOpen = (tradeState.open || []).some((t) => t.symbol === r.symbol);
    const openTradeBtn = alreadyOpen
      ? '<span class="text-[10px] text-violet-400">ถืออยู่</span>'
      : canOpen
        ? `<button onclick="event.stopPropagation();openTrade('${esc(r.symbol)}','${esc(r.tf)}')"
             class="px-3 py-1 rounded-full bg-violet-900 text-violet-300 border border-violet-700 hover:bg-violet-600 hover:text-white hover:border-violet-600 text-[11px] font-medium whitespace-nowrap transition-colors"
             title="จดไม้นี้ลงสมุด — ไม่ได้ส่งคำสั่งซื้อจริง">เปิดไม้</button>`
        : '<span class="text-[10px] text-slate-700">—</span>';

    const main = `
      <tr class="${rowCls}" onclick="toggleRow('${esc(key)}')">
        <td class="px-3 py-2.5">
          <div class="flex items-center gap-1.5">
            <span class="text-slate-500 text-xs">${isOpen ? '▾' : '▸'}</span>
            <b title="${esc(r.symbol)}">${esc(dispSym(r.symbol))}</b>${setTag(r.symbol)}
            <span class="text-[10px] text-slate-500">${esc(r.tf)}</span>
          </div>
        </td>
        <td class="px-2 py-2.5 text-right num">${fmtMoney(r.price, 2, c)}</td>
        <td class="px-2 py-2.5 text-right num ${r.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}">${fmtPct(r.changePct)}</td>
        <td class="px-2 py-2.5 text-right num text-slate-400">${fmtVol(r.volume)}</td>
        <td class="px-2 py-2.5 text-right num ${r.rvol >= 2 ? 'text-emerald-400 font-semibold' : r.rvol >= 1.5 ? 'text-yellow-400' : 'text-slate-400'}">${Number.isFinite(r.rvol) ? r.rvol.toFixed(2) + 'x' : '—'}</td>
        <td class="px-2 py-2.5 text-right">${resCell}</td>
        <td class="px-2 py-2.5 text-right num ${r.alertTriggered ? 'text-amber-300 font-bold' : ''}">
          ${fmtMoney(r.alertTarget, 2, c)}
          ${Number.isFinite(r.alertDistancePct) ? `<div class="text-[10px] text-slate-500">อีก ${r.alertDistancePct.toFixed(2)}%</div>` : ''}
        </td>
        <td class="px-2 py-2.5">${modeBadge}</td>
        <td class="px-2 py-2.5 text-right num">${rrCell}</td>
        <td class="px-2 py-2.5 text-right num text-slate-300" title="${esc(r.expectedMove?.note || '')}">${esc(r.expectedMove?.label || '—')}</td>
        <td class="px-2 py-2.5 text-right num text-slate-300" title="${esc(r.position?.note || '')}">${r.position?.shares || 0}</td>
        <td class="px-2 py-2.5 text-right"><b class="text-lg num ${scoreColor(r.score)}">${Number.isFinite(r.score) ? r.score.toFixed(0) : '—'}</b></td>
        <td class="px-3 py-2.5"><div class="flex flex-wrap gap-1">${badges.join(' ')}</div></td>
        <td class="px-2 py-2.5 text-right">${openTradeBtn}</td>
      </tr>`;

    return main + (isOpen ? detailRow(r) : '');
  }).join('');
}

// ═══════════════ แถวรายละเอียด: breakdown คะแนน (สเปกข้อ 6 — ห้ามเป็น black box) ═══════════════
function detailRow(r) {
  const c = curOf(r); // ★ $ | ฿
  if (r.dataError) {
    return `<tr class="bg-slate-950/80 border-b border-slate-800">
      <td colspan="14" class="px-6 py-4">
        <div class="text-red-300 text-sm font-semibold mb-1">⚠️ ดึงข้อมูลไม่สำเร็จ — ตัวเลขในแถวนี้ใช้ไม่ได้</div>
        <div class="text-xs text-slate-400">${esc((r.failReasons || []).join(' · '))}</div>
        ${r.providerDetail ? `<div class="text-[11px] text-slate-500 mt-1.5">รายละเอียดจากแหล่งข้อมูล: ${esc(r.providerDetail)}</div>` : ''}
      </td></tr>`;
  }

  const bars = (r.breakdown || []).map((f) => {
    const pct = Number.isFinite(f.normalized) ? f.normalized : 0;
    const barColor = pct >= 70 ? 'bg-emerald-500' : pct >= 45 ? 'bg-yellow-500' : 'bg-orange-600';
    const na = f.available === false;
    return `
      <div class="py-1.5 border-b border-slate-800/60 last:border-0">
        <div class="flex items-center justify-between gap-3 text-xs mb-1">
          <span class="font-semibold ${na ? 'text-slate-500' : 'text-slate-200'}">
            ${esc(f.label)}${na ? ' <span class="text-[10px] text-amber-600">(ไม่มีข้อมูล)</span>' : ''}
          </span>
          <span class="text-slate-400 num whitespace-nowrap">
            ค่าดิบ <b class="text-slate-200">${esc(f.rawLabel)}</b>
            → <b class="text-slate-200">${Number.isFinite(f.normalized) ? f.normalized.toFixed(0) : '—'}</b>/100
            × น้ำหนัก <b class="text-slate-200">${f.effectiveWeight}%</b>
            = <b class="text-sky-300">+${f.contribution}</b>
          </span>
        </div>
        <div class="h-1.5 rounded bg-slate-800 overflow-hidden mb-1">
          <div class="h-full ${barColor}" style="width:${Math.max(0, Math.min(100, pct))}%"></div>
        </div>
        <div class="text-[11px] text-slate-400 leading-snug">↳ ${esc(f.why)}</div>
      </div>`;
  }).join('');

  const failBox = (r.failReasons?.length)
    ? `<div class="mt-3 p-2.5 rounded bg-red-950/40 border border-red-800/60">
         <div class="text-xs font-semibold text-red-300 mb-1">✗ ตกด่านคุณภาพ (ไม่นับเป็นสัญญาณ)</div>
         <ul class="text-[11px] text-red-200/80 list-disc pl-4 space-y-0.5">
           ${r.failReasons.map((x) => `<li>${esc(x)}</li>`).join('')}
         </ul>
       </div>` : '';

  const warnBox = (r.warnings?.length)
    ? `<div class="mt-2 p-2.5 rounded bg-orange-950/40 border border-orange-800/60">
         <div class="text-xs font-semibold text-orange-300 mb-1">⚠ ข้อควรระวัง</div>
         <ul class="text-[11px] text-orange-200/80 list-disc pl-4 space-y-0.5">
           ${r.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}
         </ul>
       </div>` : '';

  const news = r.news;
  const newsBox = news && Array.isArray(news.headlines) && news.headlines.length > 0
    ? `<div class="mt-2">
         <div class="text-xs font-semibold text-slate-300 mb-1">
           📰 ข่าว (sentiment ${Number.isFinite(news.sentiment) ? news.sentiment.toFixed(2) : '—'} · แหล่ง ${esc(news.source || '—')}${news.estimated ? ' · ประมาณจากหัวข้อข่าว' : ''})
         </div>
         <ul class="text-[11px] text-slate-400 space-y-0.5">
           ${news.headlines.slice(0, 4).map((h) => `<li>• ${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener" class="hover:text-sky-400 underline">${esc(h.title)}</a>` : esc(h.title)}</li>`).join('')}
         </ul>
       </div>` : '';

  return `<tr class="bg-slate-950/80 border-b border-slate-800">
    <td colspan="14" class="px-6 py-4">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold">🧮 คะแนนมาจากไหน (${esc(r.symbol)} · ${esc(r.tf)})</h3>
            <span class="text-xs text-slate-400">รวม <b class="${scoreColor(r.score)}">${fmtNum(r.score, 1)}</b>/100
              ${r.weightUsed < 99.5 ? `<span class="text-amber-500" title="มีปัจจัยที่คำนวณไม่ได้ จึงใช้น้ำหนักรวมแค่ ${r.weightUsed}%">(จากน้ำหนัก ${r.weightUsed}%)</span>` : ''}
            </span>
          </div>
          ${bars}
          ${r.unavailableData?.length ? `<div class="mt-2 text-[11px] text-amber-500/90">ℹ️ ปัจจัยที่ไม่มีข้อมูล: ${esc(r.unavailableData.join(', '))} — ได้คะแนนกลางๆ 50 ไม่ได้แปลว่าดีหรือแย่</div>` : ''}
        </div>

        <div class="space-y-3">
          <div>
            <h3 class="text-sm font-bold mb-2">📐 แผนความเสี่ยง (คำนวณจากค่าสถิติ ไม่ใช่คำแนะนำ)</h3>
            <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              ${Number.isFinite(r.planEntry) && Number.isFinite(r.price) && r.planEntry > r.price * 1.00001
                ? `<div class="text-slate-400">ราคาปัจจุบัน</div><div class="num text-right">${fmtMoney(r.price, 2, c)}</div>
                   <div class="text-slate-400">จุดเข้า (เมื่อทะลุแนวต้าน)</div><div class="num text-right font-semibold">${fmtMoney(r.planEntry, 2, c)}</div>`
                : `<div class="text-slate-400">ราคาปัจจุบัน (entry)</div><div class="num text-right">${fmtMoney(r.price, 2, c)}</div>`}
              <div class="text-slate-400">จุดตัดขาดทุน (stop)</div><div class="num text-right text-red-400">${fmtMoney(r.rr?.stop, 2, c)}</div>
              <div class="text-slate-400">ที่มาของ stop</div><div class="text-right text-slate-300">${esc(r.rr?.stopBasis || '—')}</div>
              <div class="text-slate-400">แนวต้าน</div><div class="num text-right">${fmtMoney(r.resistance?.level, 2, c)}</div>
              <div class="text-slate-400">เป้ากำไร (เลยแนวต้าน)</div><div class="num text-right text-emerald-400">${fmtMoney(r.rr?.targetBreakout, 2, c)}</div>
              <div class="text-slate-400">R:R (เป้าเลยแนวต้าน)</div><div class="num text-right font-bold">${esc(r.rr?.label || '—')}</div>
              <div class="text-slate-400">R:R (ออกที่แนวต้านพอดี)</div><div class="num text-right">${esc(r.rr?.labelConservative || '—')}</div>
              ${r.rr?.ok && Number.isFinite(r.rr.rrConservative) && r.rr.rrConservative < 1.5
                ? `<div class="col-span-2 text-[10px] text-amber-500/90 leading-snug mt-0.5">⚠️ ตัวกรอง R:R ใช้เป้าที่ขยายเลยแนวต้าน (${esc(r.rr.label)}) ซึ่งผ่านเกณฑ์ แต่ถ้าคุณออกที่แนวต้านพอดีจะได้แค่ ${esc(r.rr.labelConservative)} ซึ่งต่ำกว่า 1:1.5 — แผนนี้ต้องให้ราคาทะลุแนวต้านไปจริงจึงคุ้ม</div>`
                : ''}
              <div class="text-slate-400">ขนาดไม้</div><div class="num text-right">${r.position?.shares || 0} หุ้น</div>
              <div class="text-slate-400">เงินที่เสี่ยง</div><div class="num text-right">${fmtMoney(r.position?.riskAmount, 2, c)}</div>
              <div class="text-slate-400">มูลค่าที่ต้องใช้</div><div class="num text-right">${fmtMoney(r.position?.cost, 2, c)}</div>
              <div class="text-slate-400">Expected Move</div><div class="num text-right">${esc(r.expectedMove?.label || '—')}</div>
            </div>
            ${r.expectedMove?.note ? `<div class="text-[10px] text-slate-500 mt-1.5">ℹ️ ${esc(r.expectedMove.note)}</div>` : ''}
            ${r.position?.note ? `<div class="text-[10px] text-slate-500 mt-1">ℹ️ ${esc(r.position.note)}</div>` : ''}
          </div>

          <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs pt-2 border-t border-slate-800">
            <div class="text-slate-400">RSI(14)</div><div class="num text-right">${fmtNum(r.rsi, 1)}</div>
            <div class="text-slate-400">ATR (แท่ง ${esc(r.tf)})</div><div class="num text-right">${fmtMoney(r.atr, 3, c)} (${fmtNum(r.atrPct, 2)}%)</div>
            <div class="text-slate-400">VWAP</div><div class="num text-right">${fmtMoney(r.vwap, 2, c)} ${r.aboveVwap === true ? '<span class="text-emerald-500">เหนือ</span>' : r.aboveVwap === false ? '<span class="text-red-500">ใต้</span>' : ''}</div>
            <div class="text-slate-400">Spread</div><div class="num text-right">${Number.isFinite(r.spreadPct) ? r.spreadPct.toFixed(3) + '%' + (Number.isFinite(r.spreadTicks) ? ` (${r.spreadTicks} ช่องราคา)` : '') : '— (provider ไม่ให้)'}</div>
            <div class="text-slate-400">แหล่งข้อมูล</div><div class="text-right text-slate-300">${esc(r.dataSource || '—')}${r.stitched ? ' <span class="text-[10px] text-slate-500">(เย็บแท่งล่าสุด)</span>' : ''}</div>
            <div class="text-slate-400">อายุข้อมูล</div><div class="num text-right ${r.dataStale ? 'text-red-400' : ''}">${Number.isFinite(r.dataAgeSec) ? Math.round(r.dataAgeSec) + ' วินาที' : '—'}</div>
            ${r.earnings?.earningsDate ? `<div class="text-slate-400">ประกาศงบ</div><div class="text-right">อีก ${fmtNum(r.earnings.daysUntil, 0)} วัน</div>` : ''}
            ${Number.isFinite(r.fundamentals?.floatShares) ? `<div class="text-slate-400">Float</div><div class="num text-right">${fmtVol(r.fundamentals.floatShares)} หุ้น</div>` : ''}
            ${Number.isFinite(r.fundamentals?.shortPct) ? `<div class="text-slate-400">Short interest</div><div class="num text-right">${fmtNum(r.fundamentals.shortPct, 1)}% ของ float</div>` : ''}
          </div>

          <div class="text-[11px] text-slate-400 pt-2 border-t border-slate-800">
            <b class="text-slate-300">ที่มาของราคาเป้าหมาย:</b> ${esc(r.alertNote || '—')}
          </div>
          ${r.market === 'TH' ? `<div class="text-[11px] text-amber-500/90 leading-snug">ℹ️ หุ้นไทย: ข้อมูลฟรีจาก Yahoo ช้ากว่าตลาดจริงราว 15–30 นาที (อายุข้อมูลด้านบน) · ขนาดไม้ปัดเป็นทวีคูณของ 100 หุ้น · ช่องราคา ณ ราคานี้ ฿${fmtNum(r.tick, 2)} · ไม่มีข่าว/sentiment (ได้คะแนนกลางๆ)</div>` : ''}
          ${newsBox}
          ${failBox}
          ${warnBox}
        </div>
      </div>
    </td></tr>`;
}

// ═══════════════ วาด log ═══════════════
// การ์ด Log และประวัติการแจ้งเตือนถูกเอาออกจากหน้าแดชบอร์ดแล้ว — ฟังก์ชันวาดจะข้ามไปเองเมื่อไม่มี element
// (server ยังบันทึก log และประวัติการแจ้งเตือนตามเดิม ใส่ section กลับใน index.html ก็แสดงได้ทันที)
function appendLog(entry) {
  const box = $('logBox');
  if (!box) return;
  const color = { info: 'text-slate-300', warn: 'text-amber-400', error: 'text-red-400', success: 'text-emerald-400' }[entry.level] || 'text-slate-300';
  const div = document.createElement('div');
  div.className = `log-line ${color}`;
  div.innerHTML = `<span class="text-slate-600">${fmtTime(entry.ts)}</span> ${esc(entry.msg)}`;
  box.appendChild(div);
  while (box.childElementCount > 500) box.removeChild(box.firstChild);
  if (autoScroll) box.scrollTop = box.scrollHeight;
}

function renderLogs(list) {
  if (!$('logBox')) return;
  $('logBox').innerHTML = '';
  for (const e of list) appendLog(e);
}

// ═══════════════ วาดประวัติการแจ้งเตือน (สเปกข้อ 4) ═══════════════
// อ่านจาก data/alerts-history.json ผ่าน GET /api/alerts
function renderAlertHistory(list) {
  const box = $('alertHistBox');
  if (!box) return;
  const items = Array.isArray(list) ? list : [];
  $('alertHistCount').textContent = items.length ? `(${items.length} รายการล่าสุด)` : '(ยังไม่มี)';

  if (items.length === 0) {
    box.innerHTML = '<p class="p-4 text-sm text-slate-500">ยังไม่มีการแจ้งเตือน — จะบันทึกไว้ที่นี่พร้อมเวลาเมื่อราคาแตะเป้าหมาย</p>';
    return;
  }

  box.innerHTML = items.map((a) => `
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 border-b border-slate-800/60 text-xs">
      <span class="text-slate-500 num w-32 shrink-0">${new Date(a.ts).toLocaleString('th-TH', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      <b class="w-14 shrink-0">${esc(a.symbol)}</b>
      <span class="text-slate-300 num">ราคา ${fmtMoney(a.price, 2, curOf(a.symbol))}</span>
      <span class="text-amber-300 num">เป้า ${fmtMoney(a.target, 2, curOf(a.symbol))}</span>
      <span class="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 text-[10px]">${esc(a.label || '')}</span>
      ${Number.isFinite(a.resistanceLevel) ? `<span class="text-slate-500 num">แนวต้าน ${fmtMoney(a.resistanceLevel, 2, curOf(a.symbol))}</span>` : ''}
    </div>`).join('');
}

async function loadAlertHistory() {
  try {
    const r = await api('/api/alerts?limit=100');
    if (r.ok) { alertStates = r.states || alertStates; renderAlertHistory(r.history); }
  } catch (err) {
    console.warn('โหลดประวัติการแจ้งเตือนไม่สำเร็จ:', err.message);
  }
}

// ═══════════════ วาดสถานะ provider (สเปกข้อ 5.5) ═══════════════
function renderProviders(list) {
  $('providerGrid').innerHTML = (list || []).map((p) => {
    const c = { ok: 'border-emerald-700 bg-emerald-950/25', degraded: 'border-amber-700 bg-amber-950/25',
                exhausted: 'border-red-700 bg-red-950/25', disabled: 'border-slate-700 bg-slate-950/40' }[p.status];
    const dot = { ok: 'bg-emerald-400', degraded: 'bg-amber-400', exhausted: 'bg-red-400', disabled: 'bg-slate-600' }[p.status];
    const q = p.quota || {};

    const quotaLine = [];
    if (q.perMinute != null) quotaLine.push(`นาทีนี้ ${q.usedMinute}/${q.perMinute}`);
    if (q.perDay != null) quotaLine.push(`วันนี้ ${q.usedDay}/${q.perDay} (เหลือ ${q.remainingDay})`);
    if (q.perMinute == null && q.perDay == null) quotaLine.push('ไม่ประกาศโควตา');

    return `
      <div class="rounded-xl border px-3.5 py-3 ${c}">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full ${dot}"></span>
            <b class="text-sm">${esc(p.name)}</b>
          </div>
          <span class="text-[10px] text-slate-500">${esc(p.capabilities.join(' · '))}</span>
        </div>
        <div class="text-[11px] text-slate-400">${esc(p.statusText)}</div>
        <div class="text-[11px] text-slate-500 num mt-0.5">${esc(quotaLine.join(' · '))}</div>
        ${!p.configured && p.signupUrl ? `<a href="${esc(p.signupUrl)}" target="_blank" rel="noopener" class="text-[10px] text-sky-500 hover:underline">ขอ API key ฟรี →</a>` : ''}
      </div>`;
  }).join('');
}

// ═══════════════ การกระทำของ user ═══════════════
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json().catch(() => ({ ok: false, error: 'ตอบกลับไม่ใช่ JSON' }));
}

$('btnStart').onclick = async () => {
  // ปลุก AudioContext ตอน user คลิก (เบราว์เซอร์บล็อกเสียงถ้าไม่มี user gesture)
  if (soundOn && !audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  const r = await api('/api/scanner/start', { method: 'POST' });
  if (!r.ok && r.reason) toast(esc(r.reason), 'warn');
};

$('btnStop').onclick = async () => {
  const r = await api('/api/scanner/stop', { method: 'POST' });
  if (!r.ok && r.reason) toast(esc(r.reason), 'warn');
};

$('btnScanNow').onclick = async () => {
  if (soundOn && !audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  const r = await api('/api/scanner/scan-now', { method: 'POST' });
  if (!r.ok && r.reason) toast(esc(r.reason), 'warn');
};

$('btnAdd').onclick = addTickers;
$('tickerInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTickers(); });

async function addTickers() {
  const input = $('tickerInput');
  const val = input.value.trim();
  if (!val) { toast('กรุณาพิมพ์ Ticker ก่อน', 'warn'); return; }

  const btn = $('btnAdd');
  btn.disabled = true;
  btn.textContent = 'กำลังตรวจ…';

  try {
    const r = await api('/api/watchlist', { method: 'POST', body: { tickers: val } });
    const ok = (r.results || []).filter((x) => x.ok);
    const bad = (r.results || []).filter((x) => !x.ok);

    const parts = [];
    if (ok.length) parts.push(`<b class="text-emerald-300">✓ เพิ่มแล้ว:</b> ${ok.map((x) => `${esc(x.symbol)}${x.price ? ` (${fmtMoney(x.price, 2, curOf(x.symbol))})` : ''}${x.resolvedFrom ? ` <span class="text-slate-400">— พบในตลาดหุ้นไทย จากที่พิมพ์ "${esc(x.resolvedFrom)}"</span>` : ''}`).join(', ')}`);
    if (bad.length) parts.push(`<b class="text-red-300">✗ ไม่สำเร็จ:</b><br>${bad.map((x) => `&nbsp;&nbsp;• ${esc(x.symbol)} — ${esc(x.reason)}`).join('<br>')}`);

    toast(parts.join('<br>'), bad.length && !ok.length ? 'error' : bad.length ? 'warn' : 'ok');
    if (ok.length) input.value = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '+ เพิ่ม';
  }
}

window.removeTicker = async (symbol) => {
  const r = await api(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
  if (!r.ok) toast(esc(r.reason || 'ลบไม่สำเร็จ'), 'error');
};

window.setTarget = async (symbol, value) => {
  const body = { targetPrice: value === '' ? null : Number(value) };
  const r = await api(`/api/watchlist/${encodeURIComponent(symbol)}/target`, { method: 'PUT', body });
  if (!r.ok) toast(esc(r.reason || 'ตั้งราคาเป้าหมายไม่สำเร็จ'), 'error');
  else toast(r.mode === 'manual'
    ? `${esc(symbol)}: ตั้งราคาเป้าหมายเอง ${fmtMoney(r.targetPrice, 2, curOf(symbol))}`
    : `${esc(symbol)}: กลับไปใช้เป้าอัตโนมัติ (แนวต้าน −0.1%)`, 'ok');
};

window.resetAlert = async (symbol) => {
  const r = await api(`/api/alerts/${encodeURIComponent(symbol)}/reset`, { method: 'POST' });
  if (r.ok) {
    alertedThisSession.delete(symbol);
    toast(`รีเซ็ตการเตือนของ ${esc(symbol)} แล้ว — พร้อมเตือนใหม่`, 'ok');
  }
};

$('btnResetAlerts').onclick = async () => {
  const r = await api('/api/alerts/reset-all', { method: 'POST' });
  if (r.ok) { alertedThisSession.clear(); toast(`รีเซ็ตการเตือนทั้งหมด (${r.count} รายการ)`, 'ok'); }
};

window.toggleRow = (key) => {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  renderRows();
};


// ---------- ★ v2: ปุ่มของตารางไม้ ----------
window.openTrade = async (symbol, tf) => {
  const r = await api('/api/trades/open', { method: 'POST', body: { symbol, tf } }); // api() แปลงเป็น JSON ให้เอง
  if (r.ok) toast(`📗 จดไม้ <b>${esc(symbol)}</b> ลงสมุดแล้ว — ระบบจะคุม stop และบอกจังหวะออกให้`, 'ok');
  else toast(esc(r.error || 'เปิดไม้ไม่สำเร็จ'), 'error');
};

window.closeTrade = async (id) => {
  const r = await api(`/api/trades/${encodeURIComponent(id)}/close`, { method: 'POST', body: {} });
  if (r.ok) toast(`ปิดไม้ <b>${esc(r.trade?.symbol || '')}</b> ที่ ${Number(r.trade?.totalR || 0).toFixed(2)}R`, 'ok');
  else toast(esc(r.error || 'ปิดไม้ไม่สำเร็จ'), 'error');
};

window.acceptPyramid = async (id) => {
  const r = await api(`/api/trades/${encodeURIComponent(id)}/pyramid`, { method: 'POST', body: {} });
  if (r.ok) toast(`➕ เติมไม้ <b>${esc(r.trade?.symbol || '')}</b> แล้ว`, 'ok');
  else toast(esc(r.error || 'เติมไม้ไม่สำเร็จ'), 'error');
};

$('btnResumeTrading').onclick = async () => {
  const r = await api('/api/trades/resume', { method: 'POST', body: {} });
  if (r.ok) { tradeState = r; renderTrades(); renderSummary(); toast('ยกเลิกการหยุดเทรดแล้ว — ระวังการไล่คืนทุน', 'warn'); }
};

$('btnClearClosed').onclick = async () => {
  const r = await api('/api/trades/closed', { method: 'DELETE' });
  if (r.ok) { tradeState = r; renderTrades(); }
};


// ---------- ★ v2.1: ปุ่มของการ์ดค่าเงิน (ทำงานกับคู่ที่กำลังดูอยู่) ----------
$('btnFxCheck').onclick = async () => {
  const pair = fxActive;
  if (!pair) return;
  $('btnFxCheck').disabled = true;
  const r = await api('/api/fx/check', { method: 'POST', body: { pair } });
  $('btnFxCheck').disabled = false;
  if (r.ok) { fxState.byPair[pair] = { data: r.data, error: null }; renderFx(); toast(`อัปเดต ${esc(pair)} แล้ว`, 'ok'); }
  else { fxState.byPair[pair] = { data: null, error: r.error }; renderFx(); toast(esc(r.error || 'ดึงค่าเงินไม่สำเร็จ'), 'error'); }
};

$('btnFxReset').onclick = async () => {
  const pair = fxActive;
  if (!pair) return;
  const r = await api('/api/fx/reset', { method: 'POST', body: { pair } });
  if (r.ok) { fxState.alertState = r.alertState || {}; renderFx(); toast(`รีเซ็ตการเตือนของ ${esc(pair)} แล้ว`, 'ok'); }
};

// ---------- ★ เลือก / เพิ่ม / ลบสกุลเงิน ----------
window.selectFxPair = (pair) => { fxActive = pair; renderFx(); };

async function saveFxPairs(pairs, focusPair) {
  const r = await api('/api/fx/pairs', { method: 'PUT', body: { pairs } });
  if (!r.ok) { toast(esc(r.error || 'บันทึกรายการสกุลเงินไม่สำเร็จ'), 'error'); return; }
  if (focusPair && (r.pairs || []).includes(focusPair)) fxActive = focusPair;
  applyFxSnapshot(r);
  renderFx();
  if (r.warnings?.length) toast(r.warnings.map(esc).join('<br>'), 'warn');
}

window.addFxPair = (pair) => {
  if (!pair || fxState.pairs.includes(pair)) return;
  saveFxPairs([...fxState.pairs, pair], pair);
};

window.removeFxPair = (pair) => {
  if (fxState.pairs.length <= 1) return;
  saveFxPairs(fxState.pairs.filter((p) => p !== pair), fxActive === pair ? null : fxActive);
};

$('btnNotify').onclick = () => requestNotifyPermission(true);
$('btnTestSound').onclick = () => { soundOn = true; $('chkSound').checked = true; playAlertSound(); };
$('chkSound').onchange = (e) => { soundOn = e.target.checked; };
if ($('chkAutoScroll')) $('chkAutoScroll').onchange = (e) => { autoScroll = e.target.checked; };
$('chkOnlyPassed').onchange = (e) => { filterOnlyPassed = e.target.checked; renderRows(); };
$('chkOnlyWatch').onchange = (e) => { filterOnlyWatch = e.target.checked; renderRows(); };
// ★ แท็บตลาด — เลือกแล้วจำไว้ (ในหน่วยความจำ) ไม่สลับตามเวลาตลาดอีก
document.querySelectorAll('input[name="mktTab"]').forEach((el) => {
  el.addEventListener('change', () => { if (el.checked) { marketTab = el.value; renderRows(); } });
});
if ($('btnClearLog')) $('btnClearLog').onclick = async () => { await api('/api/logs/clear', { method: 'POST' }); $('logBox').innerHTML = ''; };
if ($('btnReloadAlerts')) $('btnReloadAlerts').onclick = loadAlertHistory;


// ═══════════════ ★ v2: ตารางไม้ที่เปิดอยู่ ═══════════════
// ย้ำในโค้ดเหมือนที่ย้ำใน UI: นี่คือสมุดบันทึก ไม่มีการส่งคำสั่งซื้อขายจริงที่ไหนเลย
function renderTrades() {
  const open = tradeState.open || [];
  const closed = tradeState.closed || [];
  const day = tradeState.day || {};
  const lim = tradeState.limits || {};

  $('trCount').textContent = open.length ? `(${open.length} ไม้)` : '';
  $('trEmpty').classList.toggle('hidden', open.length > 0);

  // แถบหยุดเทรดเมื่อถึงลิมิตขาดทุนรายวัน
  const halt = $('trHalt');
  if (day.halted) {
    $('trHaltMsg').innerHTML = `🛑 <b>หยุดเปิดไม้ใหม่วันนี้</b> — ขาดทุนสะสม ${Number(day.realizedR || 0).toFixed(2)}R ` +
      `ถึงลิมิต ${lim.dailyLossLimitR}R ที่ตั้งไว้ · ไม้ที่เปิดอยู่ยังถูกคุม stop ตามปกติ`;
    halt.classList.remove('hidden');
  } else {
    halt.classList.add('hidden');
  }

  $('tradesBody').innerHTML = open.map((t) => {
    const c = curOf(t.symbol); // ★ $ | ฿
    const r = Number.isFinite(t.totalR) ? t.totalR : 0;
    const rCls = r > 0.01 ? 'text-emerald-400' : r < -0.01 ? 'text-red-400' : 'text-slate-300';
    const pnl = Number.isFinite(t.pnl) ? t.pnl : 0;

    const status = [];
    if (t.tp1Done) status.push('<span class="px-2 py-0.5 rounded-full bg-emerald-900/60 text-emerald-300 text-[10px]">ขาย TP1 แล้ว</span>');
    if (t.stop >= t.entry) status.push('<span class="px-2 py-0.5 rounded-full bg-sky-900/60 text-sky-300 text-[10px]">stop พ้นทุนแล้ว</span>');
    if (t.adds?.length) status.push(`<span class="px-2 py-0.5 rounded-full bg-violet-900/60 text-violet-300 text-[10px]">เติม ${t.adds.length} ครั้ง</span>`);
    if (t.note) status.push(`<span class="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[10px]">${esc(t.note)}</span>`);
    if (t.pyramidSuggestion) {
      status.push(`<span class="px-2 py-0.5 rounded-full bg-amber-900/60 text-amber-300 text-[10px]" title="${esc(t.pyramidSuggestion.note)}">เติมไม้ได้ +${t.pyramidSuggestion.shares} หุ้น</span>`);
    }

    const lastEvent = t.events?.[t.events.length - 1];

    return `
      <tr class="border-b border-slate-800/60 hover:bg-sky-950">
        <td class="px-3 py-2.5">
          <b>${esc(t.symbol)}</b>
          <span class="text-[10px] text-slate-500">${esc(t.tf)}</span>
          <div class="text-[10px] text-slate-500" title="${esc(lastEvent?.note || '')}">
            1R = ${fmtMoney(t.riskPerShare, 3, c)}/หุ้น${t.trendPass ? ` · แนวโน้ม ${esc(t.trendPass)}` : ''}
          </div>
        </td>
        <td class="px-3 py-2.5 text-right num">${fmtMoney(t.entry, 2, c)}</td>
        <td class="px-3 py-2.5 text-right num">${fmtMoney(t.currentPrice, 2, c)}</td>
        <td class="px-3 py-2.5 text-right num ${t.stop >= t.entry ? 'text-emerald-400' : 'text-red-400'}">${fmtMoney(t.stop, 2, c)}</td>
        <td class="px-3 py-2.5 text-right num text-slate-400">${fmtMoney(t.target, 2, c)}</td>
        <td class="px-3 py-2.5 text-right num">${t.sharesOpen}<span class="text-slate-600">/${t.shares}</span></td>
        <td class="px-3 py-2.5 text-right num font-bold ${rCls}">${r >= 0 ? '+' : ''}${r.toFixed(2)}R</td>
        <td class="px-3 py-2.5 text-right num ${rCls}">${pnl >= 0 ? '+' : ''}${fmtMoney(Math.abs(pnl), 2, c)}</td>
        <td class="px-3 py-2.5"><div class="flex flex-wrap gap-1">${status.join(' ') || '<span class="text-slate-600 text-[10px]">ถืออยู่</span>'}</div></td>
        <td class="px-3 py-2.5 text-right whitespace-nowrap">
          ${t.pyramidSuggestion ? `<button onclick="acceptPyramid('${esc(t.id)}')" class="px-3 py-1 rounded-full bg-amber-900 text-amber-300 border border-amber-700 hover:bg-amber-600 hover:text-white text-[11px] font-medium mr-1 transition-colors">เติมไม้</button>` : ''}
          <button onclick="closeTrade('${esc(t.id)}')" class="px-3 py-1 rounded-full bg-slate-900 text-slate-300 border border-slate-700 hover:bg-sky-950 hover:text-sky-300 hover:border-sky-700 text-[11px] font-medium transition-colors">ปิดไม้</button>
        </td>
      </tr>`;
  }).join('');

  // ไม้ที่ปิดไปแล้ว — แสดงเป็นชิปสั้นๆ
  const wrap = $('trClosedWrap');
  if (closed.length > 0) {
    wrap.classList.remove('hidden');
    $('trClosed').innerHTML = closed.slice(0, 20).map((t) => {
      const r = Number.isFinite(t.totalR) ? t.totalR : 0;
      const cls = r > 0 ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300' : 'bg-red-950/60 border-red-900 text-red-300';
      return `<span class="px-2.5 py-1 rounded-full border ${cls}" title="${esc(t.events?.[t.events.length - 1]?.note || '')}">
        <b>${esc(t.symbol)}</b> ${esc(t.exitLabel || t.exitReason)} ${r >= 0 ? '+' : ''}${r.toFixed(2)}R</span>`;
    }).join('');
  } else {
    wrap.classList.add('hidden');
  }
}


// ═══════════════ ★ v2.1: การ์ดค่าเงิน ═══════════════
function fxScoreColor(v) {
  if (v >= 80) return 'text-emerald-400';
  if (v >= 65) return 'text-green-400';
  if (v >= 45) return 'text-yellow-400';
  if (v >= 30) return 'text-orange-400';
  return 'text-slate-500';
}

function renderFxSpark(spark) {
  const el = $('fxSpark');
  if (!Array.isArray(spark) || spark.length < 2) { el.innerHTML = ''; return; }
  const lo = Math.min(...spark);
  const hi = Math.max(...spark);
  const span = hi - lo || 1;
  const pts = spark.map((v, i) => {
    const x = (i / (spark.length - 1)) * 300;
    const y = 56 - ((v - lo) / span) * 52;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastY = 56 - ((spark[spark.length - 1] - lo) / span) * 52;
  el.innerHTML =
    '<defs><linearGradient id="fxSparkFill" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#B7688A" stop-opacity="0.22"/><stop offset="1" stop-color="#B7688A" stop-opacity="0"/>' +
    '</linearGradient></defs>' +
    `<polygon points="0,60 ${pts} 300,60" fill="url(#fxSparkFill)"/>` +
    `<polyline points="${pts}" fill="none" stroke="#B7688A" stroke-width="1.75" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    `<line x1="0" y1="${lastY.toFixed(1)}" x2="300" y2="${lastY.toFixed(1)}" stroke="#D8C6C0" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="300" cy="${lastY.toFixed(1)}" r="2.5" fill="#A85478"/>`;
}

// รับภาพรวมค่าเงินจาก server (bootstrap / fx-snapshot / คำตอบของ PUT /api/fx/pairs)
// รองรับรูปแบบเดิมที่มีแค่ { data, error } ของคู่เดียวด้วย
function applyFxSnapshot(s) {
  if (!s) return;
  const pairs = Array.isArray(s.pairs) && s.pairs.length > 0 ? s.pairs
    : s.data?.pair ? [s.data.pair] : fxState.pairs;
  const incoming = s.byPair || (pairs[0] ? { [pairs[0]]: { data: s.data ?? null, error: s.error ?? null } } : {});
  const byPair = {};
  for (const p of pairs) {
    const next = incoming[p];
    // ไม่ถอยกลับไปเป็น "กำลังโหลด" ถ้ามีข้อมูลที่มาทาง socket ก่อนแล้ว
    byPair[p] = next && (next.data || next.error) ? next : (fxState.byPair[p] || { data: null, error: null });
  }
  fxState = {
    ...fxState,
    pairs,
    byPair,
    currencies: s.currencies || fxState.currencies,
    alertState: s.alertState || fxState.alertState,
    maxPairs: s.maxPairs || fxState.maxPairs,
  };
  if (!pairs.includes(fxActive)) fxActive = pairs[0] || null;
}

function fxCurrency(code) {
  return (fxState.currencies || []).find((c) => c.code === code) || { code, name: code, short: code, symbol: code };
}

// แถบเลือกสกุลเงิน: ปุ่มเม็ดยาของทุกคู่ที่เฝ้าดู + ตัวเลือกเพิ่มสกุลใหม่
function renderFxTabs() {
  const pairs = fxState.pairs || [];
  const home = (pairs[0] || 'USD/THB').split('/')[1];

  const pills = pairs.map((p) => {
    const [base, quote] = p.split('/');
    const cur = fxState.byPair[p] || {};
    const d = cur.data;
    const hit = d && Object.values(d.directions || {}).some((x) => x.scoreHit || x.manualHit);
    const rateTxt = d ? fmtRate(d.rate) : cur.error ? 'ดึงไม่ได้' : 'กำลังโหลด…';
    const info = fxCurrency(base);
    return `
      <div class="fx-pill${p === fxActive ? ' active' : ''}${cur.error && !d ? ' error' : ''}">
        <button type="button" class="fx-pill-main" onclick="selectFxPair('${esc(p)}')" title="${esc(info.name)} (${esc(p)})">
          <span class="fx-sym">${esc(info.symbol.trim())}</span>
          <span class="fx-code">${esc(quote === home ? base : p)}</span>
          <span class="fx-rate num">${rateTxt}</span>
          ${hit ? '<span class="fx-hit" title="เข้าเงื่อนไขแจ้งเตือน"></span>' : ''}
        </button>
        ${pairs.length > 1
          ? `<button type="button" class="fx-pill-x" onclick="removeFxPair('${esc(p)}')" title="เลิกเฝ้าดู ${esc(p)}">✕</button>`
          : ''}
      </div>`;
  });

  // server รุ่นเก่า (ยังไม่ได้รีสตาร์ทหลังอัปเดต) ไม่ส่งรายชื่อสกุลเงินมา → บอกตรงๆ แทนการซ่อนปุ่มเงียบๆ
  if ((fxState.currencies || []).length === 0) {
    $('fxTabs').innerHTML = pills.join('') +
      '<span class="text-xs text-amber-400">รีสตาร์ท server (Ctrl+C แล้ว npm start) เพื่อเปิดใช้การเพิ่มสกุลเงิน</span>';
    return;
  }

  const available = (fxState.currencies || [])
    .filter((c) => c.code !== home && !pairs.includes(`${c.code}/${home}`));
  const add = pairs.length < fxState.maxPairs && available.length > 0
    ? `<select class="fx-add" onchange="addFxPair(this.value); this.value = ''" title="เลือกสกุลเงินที่อยากเฝ้าดูเพิ่ม">
         <option value="">+ เพิ่มสกุลเงิน</option>
         ${available.map((c) => `<option value="${esc(c.code)}/${esc(home)}">${esc(c.code)} · ${esc(c.name)}</option>`).join('')}
       </select>`
    : '';

  $('fxTabs').innerHTML = pills.join('') + add;
}

function renderFx() {
  renderFxTabs();
  const errEl = $('fxError');
  const cur = fxState.byPair[fxActive] || { data: null, error: null };
  const d = cur.data;

  if (cur.error) {
    errEl.textContent = `ดึงข้อมูล ${fxActive} ไม่ได้: ${cur.error}`;
    errEl.className = 'px-6 py-2.5 bg-red-950 border-b border-red-800 text-red-300 text-sm';
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }

  if (!d) {
    $('fxPairLabel').textContent = fxActive || '';
    $('fxRate').textContent = '—';
    $('fxUnit').textContent = '';
    $('fxRange').innerHTML = '';
    $('fxEff').innerHTML = '';
    $('fxSource').textContent = '';
    $('fxSpark').innerHTML = '';
    $('fxDirs').innerHTML = cur.error
      ? '<div class="text-sm text-slate-500">ยังไม่มีข้อมูล — กด "ตรวจเดี๋ยวนี้" เพื่อลองใหม่</div>'
      : `<div class="text-sm text-slate-500 flex items-center gap-2"><span class="animate-spin inline-flex text-sky-500">${(window.themeIcon || (() => ''))('loader')}</span>กำลังดึงข้อมูล ${esc(fxActive || '')} ย้อนหลัง 1 ปี…</div>`;
    return;
  }

  const bInfo = d.baseInfo || fxCurrency(d.baseCur);
  const qInfo = d.quoteInfo || fxCurrency(d.quoteCur);

  $('fxPairLabel').textContent = `${d.pair} · สถิติ ${d.stats.windowDays} วันย้อนหลัง`;

  // ★ คำเตือนเรื่องคุณภาพข้อมูล (ช่วงแคบเกิน / ตัดเรตที่เป็น 0 ทิ้ง)
  if ((d.warnings || []).length > 0) {
    errEl.innerHTML = d.warnings.map((w) => `⚠️ ${esc(w)}`).join('<br>');
    errEl.className = 'px-6 py-2.5 bg-amber-950 border-b border-amber-800 text-amber-300 text-sm';
    errEl.classList.remove('hidden');
  } else if (!cur.error) {
    errEl.className = 'hidden px-6 py-2.5 bg-red-950 border-b border-red-800 text-red-300 text-sm';
    errEl.classList.add('hidden');
  }
  $('fxSource').textContent = `แหล่ง ${d.source}${d.crossVia ? ` (คำนวณผ่าน ${d.crossVia})` : ''} · ${fmtTime(d.checkedAt)}`;
  $('fxRate').textContent = fmtRate(d.rate);
  $('fxUnit').textContent = `${qInfo.short} ต่อ 1 ${bInfo.name}`;
  $('fxRange').innerHTML =
    `ปีที่ผ่านมา <span class="num">${fmtRate(d.stats.low)}</span> – <span class="num">${fmtRate(d.stats.high)}</span> ` +
    `· เฉลี่ย <span class="num">${fmtRate(d.stats.mean)}</span> ` +
    `· ตอนนี้อยู่เปอร์เซ็นไทล์ <b class="num">${d.stats.percentile.toFixed(0)}</b>`;
  $('fxEff').innerHTML =
    `หักส่วนต่าง ${d.spreadPct}% แล้ว: ซื้อ${esc(bInfo.short)} <span class="num text-slate-200">${fmtRate(d.effBuyUsd)}</span> ` +
    `· ขาย${esc(bInfo.short)} <span class="num text-slate-200">${fmtRate(d.effSellUsd)}</span>`;
  renderFxSpark(d.spark);

  const alertState = fxState.alertState || {};

  $('fxDirs').innerHTML = Object.values(d.directions).map((x) => {
    const hit = x.scoreHit || x.manualHit;
    const fired = alertState[`${d.pair}:${x.key}`]?.armed === false;
    const box = hit ? 'border-amber-600 bg-amber-950/25' : 'border-slate-800 bg-slate-950/40';

    const target = x.manualTarget
      ? `<div class="text-[11px] ${x.manualHit ? 'text-amber-300' : 'text-slate-500'}">
           เป้าที่ตั้งเอง <span class="num">${fmtRate(x.manualTarget)}</span>
           ${x.manualHit ? '· ถึงแล้ว' : `· อีก ${Math.abs(x.manualDistancePct).toFixed(2)}%`}
         </div>`
      : `<div class="text-[11px] text-slate-600">ไม่ได้ตั้งเรตเป้าของ ${esc(d.pair)} — ดูจากคะแนนอย่างเดียว (ตั้งได้ที่ปุ่ม 🔔 กฎแจ้งเตือน)</div>`;

    const bars = x.factors.map((f) => `
      <div class="flex items-center gap-2 text-[11px]" title="${esc(f.why)}">
        <span class="w-32 text-slate-500 shrink-0">${esc(f.label)}</span>
        <span class="num w-14 text-right text-slate-400 shrink-0">${esc(f.raw)}</span>
        <span class="flex-1 h-1.5 bg-slate-800 rounded overflow-hidden">
          <span class="block h-full bg-sky-500" style="width:${f.score.toFixed(0)}%"></span>
        </span>
        <span class="num w-7 text-right ${fxScoreColor(f.score)} shrink-0">${f.score.toFixed(0)}</span>
      </div>`).join('');

    return `
      <div class="rounded-2xl border p-4 ${box}">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div>
            <div class="font-semibold text-sm">${esc(x.label)}</div>
            <div class="text-[11px] text-slate-500">${esc(x.purpose)} · เรตที่น่าจะได้ <span class="num">${fmtRate(x.effectiveRate)}</span></div>
          </div>
          <div class="text-right shrink-0">
            <b class="text-2xl num ${fxScoreColor(x.score)}">${x.score.toFixed(0)}</b>
            <div class="text-[10px] text-slate-500">/100</div>
          </div>
        </div>
        ${target}
        <div class="mt-2 space-y-1">${bars}</div>
        ${x.amountNote ? `<div class="mt-2 text-[11px] ${x.diffVsMean >= 0 ? 'text-emerald-400' : 'text-orange-400'}">💵 ${esc(x.amountNote)}</div>` : ''}
        ${d.narrowRange ? '<div class="mt-2 text-[11px] text-slate-500">ช่วงแกว่งทั้งปีแคบเกินกว่าจะตัดสินได้ — คะแนนถูกดึงเข้าหากลาง</div>' : ''}
        ${hit ? `<div class="mt-2 text-[11px] text-amber-300">★ เข้าเงื่อนไขแล้ว${fired ? ' · แจ้งเตือนไปแล้ววันนี้' : ''}</div>` : ''}
      </div>`;
  }).join('');
}

// ═══════════════ ★ กฎแจ้งเตือน (ตั้งจากแดชบอร์ด) ═══════════════
// แผงเปิด/ปิดจากปุ่ม "กฎแจ้งเตือน" บนหัวการ์ด · บันทึกผ่าน PUT /api/alert-rules · มีผลรอบสแกน/รอบตรวจถัดไป

// LINE พร้อมส่งจริงไหม — ต้องเปิดสวิตช์หลักและมี token + target (server ส่งมาแบบ mask แต่ไม่ว่าง)
const lineReady = () => !!(appSettings.lineEnabled && appSettings.lineToken && appSettings.lineTarget);

function channelText(line, browser) {
  const c = [];
  if (line) c.push('LINE');
  if (browser) c.push('เบราว์เซอร์');
  return c.length ? c.join(' + ') : 'ไม่มีช่องทาง';
}

function renderRuleChips() {
  const s = appSettings;
  $('scoreRuleChip').textContent = s.scoreAlertEnabled
    ? `คะแนน ≥ ${s.scoreAlertMin} → ${channelText(s.scoreAlertLine, s.scoreAlertBrowser)}`
    : 'กฎแจ้งเตือน: ปิดอยู่';
  $('btnScoreRule').classList.toggle('on', !!s.scoreAlertEnabled);

  const fxOn = s.fxAlertBuy !== false || s.fxAlertSell !== false;
  $('fxRuleChip').textContent = fxOn
    ? `คะแนน ≥ ${s.fxScoreThreshold ?? 75} → ${channelText(s.fxAlertLine !== false, s.fxAlertBrowser !== false)}`
    : 'กฎแจ้งเตือน: ปิดอยู่';
  $('btnFxRule').classList.toggle('on', fxOn);
}

// บรรทัดสถานะ LINE + ปุ่มทดสอบ (ใช้ทั้งสองแผง)
function lineStatusHtml(wantLine) {
  const status = lineReady()
    ? '<span class="status-dot bg-emerald-500"></span>LINE พร้อมส่ง'
    : `<span class="status-dot bg-amber-500"></span>LINE ยังไม่พร้อม — ต้องเปิด "ส่งแจ้งเตือนเข้า LINE" และใส่ Token / Target ID ที่หน้า
       <a href="/settings" class="underline text-sky-400">Settings</a>${wantLine ? ' (ติ๊ก LINE ไว้ก็จะยังไม่ส่งจนกว่าจะตั้งค่า)' : ''}`;
  return `<span class="rule-note">${status}</span>
    <button type="button" class="btn btn-xs btn-ghost" onclick="testLine()"><span>${(window.themeIcon || (() => ''))('message')}</span>ทดสอบส่ง LINE</button>`;
}

window.testLine = async () => {
  const r = await api('/api/line/test', { method: 'POST' });
  toast(r.ok ? 'ส่งข้อความทดสอบแล้ว — เช็คใน LINE' : `ส่ง LINE ไม่สำเร็จ: ${esc(r.reason || '')}`, r.ok ? 'ok' : 'error');
};

async function saveAlertRules(body, panelId) {
  const r = await api('/api/alert-rules', { method: 'PUT', body });
  if (!r.ok) { toast(esc(r.error || 'บันทึกกฎแจ้งเตือนไม่สำเร็จ'), 'error'); return; }
  appSettings = r.settings || appSettings;
  closeRulePanel(panelId);
  renderRuleChips();
  const warn = r.warnings || [];
  toast('บันทึกกฎแจ้งเตือนแล้ว — มีผลรอบถัดไป' + (warn.length ? `<br>${warn.map(esc).join('<br>')}` : ''), warn.length ? 'warn' : 'ok');
}

function closeRulePanel(panelId) {
  $(panelId).classList.add('hidden');
  $(panelId).innerHTML = '';
  $(panelId === 'scoreRulePanel' ? 'btnScoreRule' : 'btnFxRule').classList.remove('open');
}
window.closeRulePanel = closeRulePanel;

// ---------- กฎคะแนนหุ้น ----------
// เงื่อนไขเดียวกับ src/score-alerts.js → matchesScoreRule — แก้ที่หนึ่งต้องแก้อีกที่
function scoreRuleMatches(r, rule) {
  if (!r || r.dataError || r.dataStale) return false;
  if (!Number.isFinite(r.score) || r.score < rule.scoreAlertMin) return false;
  if (rule.scoreAlertRequirePassed && !r.passed) return false;
  if (rule.scoreAlertScope === 'watchlist' && r.from !== 'watchlist') return false;
  return true;
}

let scoreAlertedToday = {}; // หุ้นที่เตือนไปแล้ววันนี้ (จาก GET /api/score-alerts)

function readScoreRuleForm() {
  return {
    scoreAlertEnabled: $('srEnabled').checked,
    scoreAlertMin: Number($('srMin').value),
    scoreAlertScope: document.querySelector('input[name="srScope"]:checked')?.value || 'all',
    scoreAlertRequirePassed: $('srPassed').checked,
    scoreAlertLine: $('srLine').checked,
    scoreAlertBrowser: $('srBrowser').checked,
    priceAlertLine: $('srPriceLine').checked,
  };
}

function updateScorePreview() {
  const rule = readScoreRuleForm();
  const best = new Map();
  for (const r of rows) {
    if (!scoreRuleMatches(r, rule)) continue;
    const prev = best.get(r.symbol);
    if (!prev || r.score > prev.score) best.set(r.symbol, r);
  }
  const list = [...best.values()].sort((a, b) => b.score - a.score);
  const fresh = list.filter((r) => !scoreAlertedToday[r.symbol]);
  const stale = rows.filter((r) => r.dataStale && Number.isFinite(r.score) && r.score >= rule.scoreAlertMin).length;
  const names = (arr) => arr.slice(0, 12).map((r) => `<b>${esc(r.symbol)}</b> ${Number(r.score).toFixed(0)}`).join(' · ') +
    (arr.length > 12 ? ` · และอีก ${arr.length - 12} ตัว` : '');

  let html;
  if (!rule.scoreAlertEnabled) {
    html = '<span class="text-slate-500">ปิดอยู่ — เปิดสวิตช์ด้านบนเพื่อเริ่มแจ้งเตือน</span>';
  } else if (list.length === 0) {
    html = `ตอนนี้ยังไม่มีหุ้นเข้าเงื่อนไข${rule.scoreAlertRequirePassed ? ' <span class="text-slate-500">(ลองเอาติ๊ก "เฉพาะหุ้นที่ผ่านด่านคุณภาพ" ออกถ้าอยากได้มากขึ้น)</span>' : ''}`;
  } else {
    html = `ตอนนี้เข้าเงื่อนไข <b>${list.length}</b> ตัว: ${names(list)}` +
      `<br><span class="text-slate-500">รอบสแกนถัดไปจะแจ้ง <b class="text-sky-400">${fresh.length}</b> ตัว` +
      (list.length > fresh.length ? ` (อีก ${list.length - fresh.length} ตัวเตือนไปแล้ววันนี้)` : '') +
      (rule.scoreAlertLine ? ' · รวมเป็น LINE 1 ข้อความ' : '') + '</span>';
  }
  if (rule.scoreAlertEnabled && stale > 0) {
    html += `<br><span class="text-amber-400">ข้าม ${stale} แถวที่ข้อมูลไม่อัปเดต — คะแนนจากราคาเก่าจะไม่ถูกส่งแจ้งเตือน</span>`;
  }
  $('srPreview').innerHTML = html;
}

function openScoreRulePanel() {
  const s = appSettings;
  const panel = $('scoreRulePanel');
  panel.innerHTML = `
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <label class="flex items-center gap-3 cursor-pointer">
          <input id="srEnabled" type="checkbox" class="switch" ${s.scoreAlertEnabled ? 'checked' : ''}>
          <span><span class="rule-title">แจ้งเตือนเมื่อคะแนนหุ้นถึงเกณฑ์</span>
            <span class="rule-note block">หุ้นละไม่เกิน 1 ครั้งต่อวัน · ทุกตัวที่เข้าเกณฑ์ในรอบเดียวกันรวมเป็นการแจ้งเตือนเดียว</span></span>
        </label>
      </div>

      <div class="rule-row">
        <span class="rule-label">คะแนนตั้งแต่</span>
        <input id="srMinRange" type="range" min="0" max="100" step="1" value="${s.scoreAlertMin ?? 70}" class="rule-range">
        <input id="srMin" type="number" min="0" max="100" step="1" value="${s.scoreAlertMin ?? 70}" class="field rule-num num">
        <span class="text-sm text-slate-400">ขึ้นไป</span>
      </div>

      <div class="rule-row">
        <span class="rule-label">ขอบเขต</span>
        <div class="seg">
          <label><input type="radio" name="srScope" value="all" ${s.scoreAlertScope !== 'watchlist' ? 'checked' : ''}>ทุกหุ้นในตาราง</label>
          <label><input type="radio" name="srScope" value="watchlist" ${s.scoreAlertScope === 'watchlist' ? 'checked' : ''}>เฉพาะรายการเฝ้าดู</label>
        </div>
        <label class="check-pill"><input id="srPassed" type="checkbox" class="w-3.5 h-3.5" ${s.scoreAlertRequirePassed !== false ? 'checked' : ''}>เฉพาะหุ้นที่ผ่านด่านคุณภาพ</label>
      </div>

      <div class="rule-row">
        <span class="rule-label">ส่งทาง</span>
        <label class="check-pill"><input id="srLine" type="checkbox" class="w-3.5 h-3.5" ${s.scoreAlertLine !== false ? 'checked' : ''}>LINE OA</label>
        <label class="check-pill"><input id="srBrowser" type="checkbox" class="w-3.5 h-3.5" ${s.scoreAlertBrowser !== false ? 'checked' : ''}>เสียง + ป๊อปอัปบนหน้าเว็บ</label>
      </div>

      <div id="srPreview" class="rule-preview"></div>

      <div class="rule-divider pt-4 rule-row">
        <span class="rule-label">ราคาแตะเป้า<br><span class="rule-note">(รายการเฝ้าดู)</span></span>
        <label class="check-pill"><input id="srPriceLine" type="checkbox" class="w-3.5 h-3.5" ${s.priceAlertLine !== false ? 'checked' : ''}>ส่ง LINE ด้วย</label>
        <span class="rule-note">เสียง ป๊อปอัป และแถวกระพริบบนหน้าเว็บทำงานเสมอ</span>
      </div>

      <div class="rule-divider pt-4 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2" id="srLineStatus"></div>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-sm btn-ghost" onclick="resetScoreAlertsToday()" title="หุ้นที่เตือนไปแล้ววันนี้จะเตือนได้อีกครั้งในรอบถัดไป"><span>${(window.themeIcon || (() => ''))('rotate')}</span>ล้างสถานะวันนี้</button>
          <button type="button" class="btn btn-sm btn-ghost" onclick="closeRulePanel('scoreRulePanel')">ยกเลิก</button>
          <button type="button" class="btn btn-sm btn-primary" id="srSave">บันทึกกฎ</button>
        </div>
      </div>
    </div>`;

  const refreshLine = () => { $('srLineStatus').innerHTML = lineStatusHtml($('srLine').checked); };
  $('srMinRange').oninput = (e) => { $('srMin').value = e.target.value; updateScorePreview(); };
  $('srMin').oninput = (e) => { $('srMinRange').value = e.target.value; updateScorePreview(); };
  for (const el of panel.querySelectorAll('input[type=checkbox], input[type=radio]')) el.addEventListener('change', updateScorePreview);
  $('srLine').addEventListener('change', refreshLine);
  $('srSave').onclick = () => saveAlertRules(readScoreRuleForm(), 'scoreRulePanel');
  refreshLine();
  updateScorePreview();

  panel.classList.remove('hidden');
  $('btnScoreRule').classList.add('open');
  // ดึงรายชื่อที่เตือนไปแล้ววันนี้มาแสดงในตัวอย่าง
  api('/api/score-alerts').then((r) => {
    if (!r.ok || $('scoreRulePanel').classList.contains('hidden')) return;
    scoreAlertedToday = r.state || {};
    updateScorePreview();
  }).catch(() => {});
}

window.resetScoreAlertsToday = async () => {
  const r = await api('/api/score-alerts/reset', { method: 'POST' });
  if (r.ok) {
    scoreAlertedToday = {};
    if (!$('scoreRulePanel').classList.contains('hidden')) updateScorePreview();
    toast(`ล้างสถานะแล้ว (${r.count} ตัว) — รอบสแกนถัดไปจะเตือนใหม่ถ้ายังเข้าเกณฑ์`, 'ok');
  }
};

$('btnScoreRule').onclick = () => {
  if ($('scoreRulePanel').classList.contains('hidden')) openScoreRulePanel();
  else closeRulePanel('scoreRulePanel');
};

// ---------- กฎค่าเงิน ----------
function readFxRuleForm() {
  const num = (id) => ($(id).value.trim() === '' ? 0 : Number($(id).value));
  return {
    fxScoreThreshold: Number($('frMin').value),
    fxAlertBuy: $('frBuy').checked,
    fxAlertSell: $('frSell').checked,
    fxAlertLine: $('frLine').checked,
    fxAlertBrowser: $('frBrowser').checked,
    fxTargets: fxActive ? { [fxActive]: { buyBelow: num('frBuyBelow'), sellAbove: num('frSellAbove') } } : undefined,
  };
}

// คู่/ทิศทางที่ "ตอนนี้" เข้าเงื่อนไขตามค่าในฟอร์ม (คู่ที่กำลังดูใช้เรตเป้าที่พิมพ์อยู่ คู่อื่นใช้ที่บันทึกไว้)
function updateFxPreview() {
  const rule = readFxRuleForm();
  const hits = [];
  for (const p of fxState.pairs) {
    const d = fxState.byPair[p]?.data;
    if (!d) continue;
    const typed = p === fxActive ? rule.fxTargets?.[p] : null;
    for (const x of Object.values(d.directions || {})) {
      const isBuy = x.key === 'BUY_USD';
      if (isBuy ? !rule.fxAlertBuy : !rule.fxAlertSell) continue;
      const scoreHit = x.score >= rule.fxScoreThreshold && !d.narrowRange;
      const target = typed ? (isBuy ? typed.buyBelow : typed.sellAbove) : x.manualTarget;
      const manualHit = target > 0 && (isBuy ? d.rate <= target : d.rate >= target);
      if (scoreHit || manualHit) {
        hits.push(`<b>${esc(p)}</b> ${esc(x.label)} ${x.score.toFixed(0)}${manualHit ? ' · ถึงเรตเป้า' : ''}`);
      }
    }
  }
  $('frPreview').innerHTML = !rule.fxAlertBuy && !rule.fxAlertSell
    ? '<span class="text-slate-500">ไม่ได้เลือกทิศทางไหนเลย — จะไม่มีการแจ้งเตือนค่าเงิน</span>'
    : hits.length
      ? `ตอนนี้เข้าเงื่อนไข: ${hits.join(' · ')}<br><span class="text-slate-500">เตือนทิศทางละไม่เกิน 1 ครั้งต่อวันต่อคู่เงิน · ช่วงแกว่งแคบเกินไปจะไม่เตือนจากคะแนน</span>`
      : 'ตอนนี้ยังไม่มีคู่ไหนเข้าเงื่อนไข';
}

function openFxRulePanel() {
  const s = appSettings;
  const d = fxState.byPair[fxActive]?.data;
  // เรตเป้าที่บันทึกไว้ อ่านจากค่าตั้งค่าเสมอ (ไม่ใช่จากข้อมูลเรต ซึ่งอาจยังโหลดไม่เสร็จ → บันทึกทับเป็น 0)
  // คู่หลักที่ยังไม่เคยตั้งแยกใช้ช่องแบบเดิม fxBuyBelow / fxSellAbove
  const t = s.fxTargets?.[fxActive] || {};
  const legacy = fxActive === s.fxPair;
  const saved = {
    BUY_USD: t.buyBelow ?? (legacy ? s.fxBuyBelow : 0),
    SELL_USD: t.sellAbove ?? (legacy ? s.fxSellAbove : 0),
  };
  const val = (v) => (Number(v) > 0 ? v : '');
  const buyLabel = d?.directions?.BUY_USD?.label || 'ซื้อเงินต่างประเทศ';
  const sellLabel = d?.directions?.SELL_USD?.label || 'แลกเงินต่างประเทศกลับ';
  const panel = $('fxRulePanel');
  panel.innerHTML = `
    <div class="space-y-4">
      <div>
        <div class="rule-title">แจ้งเตือนค่าเงิน</div>
        <div class="rule-note">เกณฑ์คะแนนและช่องทางใช้กับทุกคู่เงิน · เรตเป้าตั้งแยกตามคู่ (ตอนนี้กำลังตั้งของ <b>${esc(fxActive || '—')}</b> — สลับคู่ด้วยปุ่มสกุลเงินด้านบน)</div>
      </div>

      <div class="rule-row">
        <span class="rule-label">คะแนนความคุ้มตั้งแต่</span>
        <input id="frMinRange" type="range" min="0" max="100" step="1" value="${s.fxScoreThreshold ?? 75}" class="rule-range">
        <input id="frMin" type="number" min="0" max="100" step="1" value="${s.fxScoreThreshold ?? 75}" class="field rule-num num">
        <span class="text-sm text-slate-400">ขึ้นไป</span>
      </div>

      <div class="rule-row">
        <span class="rule-label">ทิศทาง</span>
        <label class="check-pill"><input id="frBuy" type="checkbox" class="w-3.5 h-3.5" ${s.fxAlertBuy !== false ? 'checked' : ''}>${esc(buyLabel)}</label>
        <label class="check-pill"><input id="frSell" type="checkbox" class="w-3.5 h-3.5" ${s.fxAlertSell !== false ? 'checked' : ''}>${esc(sellLabel)}</label>
      </div>

      <div class="rule-row">
        <span class="rule-label">เรตเป้า ${esc(fxActive || '')}</span>
        <span class="text-xs text-slate-400">ซื้อเมื่อต่ำกว่า</span>
        <input id="frBuyBelow" type="number" min="0" step="any" placeholder="ไม่ใช้" value="${val(saved.BUY_USD)}" class="field w-32 num">
        <span class="text-xs text-slate-400">ขายกลับเมื่อสูงกว่า</span>
        <input id="frSellAbove" type="number" min="0" step="any" placeholder="ไม่ใช้" value="${val(saved.SELL_USD)}" class="field w-32 num">
        ${d ? `<span class="rule-note">เรตตอนนี้ ${fmtRate(d.rate)}</span>` : ''}
      </div>

      <div class="rule-row">
        <span class="rule-label">ส่งทาง</span>
        <label class="check-pill"><input id="frLine" type="checkbox" class="w-3.5 h-3.5" ${s.fxAlertLine !== false ? 'checked' : ''}>LINE OA</label>
        <label class="check-pill"><input id="frBrowser" type="checkbox" class="w-3.5 h-3.5" ${s.fxAlertBrowser !== false ? 'checked' : ''}>เสียง + ป๊อปอัปบนหน้าเว็บ</label>
      </div>

      <div id="frPreview" class="rule-preview"></div>

      <div class="rule-divider pt-4 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2" id="frLineStatus"></div>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-sm btn-ghost" onclick="closeRulePanel('fxRulePanel')">ยกเลิก</button>
          <button type="button" class="btn btn-sm btn-primary" id="frSave">บันทึกกฎ</button>
        </div>
      </div>
    </div>`;

  const refreshLine = () => { $('frLineStatus').innerHTML = lineStatusHtml($('frLine').checked); };
  $('frMinRange').oninput = (e) => { $('frMin').value = e.target.value; updateFxPreview(); };
  $('frMin').oninput = (e) => { $('frMinRange').value = e.target.value; updateFxPreview(); };
  for (const el of panel.querySelectorAll('input')) el.addEventListener('input', updateFxPreview);
  $('frLine').addEventListener('change', refreshLine);
  $('frSave').onclick = () => saveAlertRules(readFxRuleForm(), 'fxRulePanel');
  refreshLine();
  updateFxPreview();

  panel.classList.remove('hidden');
  $('btnFxRule').classList.add('open');
}

$('btnFxRule').onclick = () => {
  if ($('fxRulePanel').classList.contains('hidden')) openFxRulePanel();
  else closeRulePanel('fxRulePanel');
};

// การแจ้งเตือนบนเบราว์เซอร์แบบทั่วไป (showNotification ด้านบนออกแบบไว้สำหรับราคาแตะเป้าโดยเฉพาะ)
function browserNote(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body: `${body}\nเครื่องมือช่วยคัดกรอง ไม่ใช่คำแนะนำการลงทุน`, tag });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (err) {
    console.warn('แจ้งเตือนไม่ได้:', err.message);
  }
}

// ═══════════════ Socket.IO ═══════════════
socket.on('connect', () => {
  $('connDot').className = 'w-2 h-2 rounded-full bg-emerald-400';
  $('connText').textContent = 'เชื่อมต่อแล้ว';
});

socket.on('disconnect', () => {
  $('connDot').className = 'w-2 h-2 rounded-full bg-red-500';
  $('connText').textContent = 'ขาดการเชื่อมต่อ — กำลังลองใหม่…';
});

socket.on('bootstrap', (d) => {
  state = d.state || state;
  rows = d.rows || [];
  watchlist = d.watchlist || [];
  alertStates = d.alerts || {};
  tradeState = d.trades || tradeState; // ★ v2
  applyFxSnapshot(d.fx);               // ★ v2.1 + หลายคู่เงิน
  appSettings = d.settings || appSettings; // ★ กฎแจ้งเตือน
  renderRuleChips();
  renderState(); renderTrades(); renderFx(); renderSummary(); renderWatchlist(); renderRows();
  renderLogs(d.logs || []);
  renderProviders(d.providers);
  if (d.mockMode) $('mockBanner').classList.remove('hidden');
  loadAlertHistory();
  // ขอ permission แจ้งเตือนตอนเปิดหน้าเว็บครั้งแรก (สเปกข้อ 4)
  requestNotifyPermission(false);
  updateNotifyButton();
});

socket.on('state', (s) => {
  const prevTab = effectiveMarketTab();
  state = s; renderState(); renderSummary();
  if (!marketTab && effectiveMarketTab() !== prevTab) renderRows(); // ★ ตลาดเปิด/ปิด → แท็บอัตโนมัติเปลี่ยนตาม
});
socket.on('rows', (r) => {
  rows = r; renderRows(); renderSummary();
  if (!$('scoreRulePanel').classList.contains('hidden')) updateScorePreview(); // ตัวอย่างในแผงกฎตามข้อมูลล่าสุด
});
// ค่าตั้งค่าเปลี่ยน (จากแท็บอื่น หรือหน้า Settings) — อัปเดตป้ายสรุปกฎ ไม่ยุ่งกับแผงที่กำลังแก้อยู่
socket.on('settings', (s) => { appSettings = s || appSettings; renderRuleChips(); });

// ★ หุ้นคะแนนถึงเกณฑ์ (server ส่ง LINE เองแล้ว ฝั่งนี้ทำแค่เสียง/ป๊อปอัปถ้าเปิดช่องทางเบราว์เซอร์ไว้)
socket.on('score-alert', (p) => {
  const hits = p.hits || [];
  if (hits.length === 0 || appSettings.scoreAlertBrowser === false) return;
  const list = hits.slice(0, 8).map((h) => `${esc(h.symbol)} (${Number(h.score).toFixed(0)})`).join(', ') +
    (hits.length > 8 ? ` และอีก ${hits.length - 8} ตัว` : '');
  playAlertSound();
  toast(`🔔 <b>คะแนนถึงเกณฑ์ ≥ ${esc(p.min)}</b> — ${list}`, 'ok');
  browserNote(`🔔 หุ้นคะแนนถึงเกณฑ์ ≥ ${p.min} (${hits.length} ตัว)`,
    hits.slice(0, 6).map((h) => `${h.symbol} ${Number(h.score).toFixed(0)}`).join(' · '), 'score-alert');
});
socket.on('summary', (s) => { state.summary = s; renderSummary(); });

socket.on('row', (row) => {
  // อัปเดตทีละแถวระหว่างที่ยังสแกนอยู่ (เห็นผลไหลๆ ไม่ต้องรอจบรอบ)
  const i = rows.findIndex((r) => r.symbol === row.symbol && r.tf === row.tf);
  if (i >= 0) rows[i] = row; else rows.push(row);
  rows.sort((a, b) => (b.score || 0) - (a.score || 0));
  renderRows(); renderSummary();
});

socket.on('watchlist', (items) => { watchlist = items || []; renderWatchlist(); });

socket.on('alerts-reset', (d) => {
  if (d.all) { alertStates = {}; alertedThisSession.clear(); }
  else if (d.symbol) { delete alertStates[d.symbol]; alertedThisSession.delete(d.symbol); }
  renderWatchlist();
  loadAlertHistory();
});

// ---------- ราคาแตะเป้าหมาย (สเปกข้อ 4) ----------
socket.on('alert', (payload) => {
  alertStates[payload.symbol] = { symbol: payload.symbol, triggeredAt: payload.ts, triggerPrice: payload.price };

  // เล่นเสียง + แจ้งเตือน ครั้งเดียวต่อ symbol ต่อการเปิดหน้าเว็บ (กันรบกวน)
  if (!alertedThisSession.has(payload.symbol)) {
    alertedThisSession.add(payload.symbol);
    playAlertSound();
    showNotification(payload);
  }

  toast(`🔔 <b>${esc(payload.symbol)}</b> ${esc(payload.message)}`, 'warn');
  renderWatchlist();
  loadAlertHistory(); // อัปเดตประวัติการแจ้งเตือนทันที
});

socket.on('log', (entry) => appendLog(entry));
socket.on('logs-cleared', () => { if ($('logBox')) $('logBox').innerHTML = ''; });
socket.on('providers', (p) => renderProviders(p));

// ---------- ★ v2: ไม้ที่เปิดอยู่ ----------
socket.on('trades', (t) => { tradeState = t || tradeState; renderTrades(); renderSummary(); renderRows(); });

// ---------- ★ v2.1: ค่าเงิน ----------
// อัปเดตทีละคู่ { pair, data, error }
socket.on('fx', (p) => {
  const pair = p.pair || p.data?.pair || fxState.pairs[0];
  if (!pair || (fxState.pairs.length > 0 && !fxState.pairs.includes(pair))) return; // คู่ที่เพิ่งถูกลบ
  fxState.byPair[pair] = { data: p.data ?? null, error: p.error ?? null };
  if (fxState.pairs.length === 0) { fxState.pairs = [pair]; fxActive = pair; }
  renderFx();
});
// รายการคู่เงินเปลี่ยน (เพิ่ม/ลบจากแท็บอื่น หรือบันทึกจากหน้า Settings)
socket.on('fx-snapshot', (s) => { applyFxSnapshot(s); renderFx(); });

socket.on('fx-alert', (e) => {
  if (appSettings.fxAlertBrowser === false) return; // ปิดช่องทางเบราว์เซอร์ไว้ในกฎแจ้งเตือน (LINE ยังส่งตามปกติ)
  playAlertSound();
  const reasons = (e.reasons || []).join(' · ');
  toast(`💱 <b>${esc(e.label)}</b> — ${esc(e.pair)} ${fmtRate(Number(e.rate))} · คะแนน ${Number(e.score).toFixed(0)}/100<br>` +
        `<span class="text-xs">${esc(reasons)}</span>` +
        (e.amountNote ? `<br><span class="text-xs">${esc(e.amountNote)}</span>` : ''), 'warn');
  browserNote(`💱 ${e.pair} · ${e.label}`,
    `${fmtRate(Number(e.rate))} · คะแนน ${Number(e.score).toFixed(0)}/100 — ${reasons}`, `fx-${e.pair}-${e.direction}`);
});

socket.on('trade-exit', (e) => {
  const win = Number(e.totalR) > 0;
  playAlertSound();
  toast(`${win ? '📗' : '📕'} <b>${esc(e.symbol)}</b> ${esc(e.label)} @ ${fmtMoney(e.price, 2, curOf(e.symbol))} — ` +
        `${Number(e.totalR) >= 0 ? '+' : ''}${Number(e.totalR).toFixed(2)}R`, win ? 'ok' : 'warn');
  showNotification({ symbol: e.symbol, message: `${e.label} · ${Number(e.totalR) >= 0 ? '+' : ''}${Number(e.totalR).toFixed(2)}R` });
});

// ---------- โหลดสถานะครั้งแรกผ่าน REST (เผื่อ socket ยังไม่ต่อ) ----------
(async () => {
  try {
    const d = await api('/api/status');
    if (d.ok) {
      state = d;
      rows = d.rows || [];
      renderState(); renderSummary(); renderRows();
      renderProviders(d.providers);
    }
    const w = await api('/api/watchlist');
    if (w.ok) { watchlist = w.items || []; renderWatchlist(); }
    await loadAlertHistory();
  } catch (err) {
    console.warn('โหลดสถานะเริ่มต้นไม่สำเร็จ:', err.message);
  }
  updateNotifyButton();
})();
