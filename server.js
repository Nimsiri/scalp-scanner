// server.js — Express + Socket.IO
//
// ═══ หลักการสำคัญ (สเปกข้อ 2) ═══
// "Express server ต้องรันแยกจาก scanner loop"
// → server สร้าง ScannerEngine ตอน boot แต่ "ไม่ start ให้เอง"
// → เปิดเว็บทิ้งไว้ได้แม้ scanner หยุดอยู่ และกด Start ใหม่ได้โดยไม่ต้องรีสตาร์ท server
//
// การสื่อสาร 2 ทาง:
//   REST API   — คำสั่งจาก user (start/stop/scan-now/เพิ่มหุ้น/แก้ settings)
//   Socket.IO  — push ข้อมูลจาก server ไปหน้าเว็บ (rows/log/alert/state)

import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { Server as SocketServer } from 'socket.io';

import { settings } from './src/settings.js';
import { log } from './src/logbus.js';
import { scanner } from './src/scanner.js';
import { trades } from './src/trades.js'; // ★ v2
import { fxWatcher, fxPairList, CURRENCIES } from './src/fx.js';   // ★ v2.1
import {
  getWatchlist, addTickers, removeTicker, setTargetPrice, setNote, clearWatchlist,
} from './src/watchlist.js';
import {
  resetAlert, resetAllAlerts, getAllAlertStates, getAlertHistory, forgetSymbol,
} from './src/alerts.js';
import {
  getProviderStatus, getChains, clearCache, isMockMode, validateTicker,
} from './src/providers/index.js';
import { runBacktest } from './src/backtest.js';
import { marketStatus, SESSIONS, thaiMarketStatus } from './src/market-hours.js';
import { TH_UNIVERSE_DEFAULT } from './src/markets.js'; // ★ หุ้นไทย
import { flushAll } from './src/store.js';
import { pushSignalToLine, isLineConfigured, sendLineTest, pushFxToLine, pushScoreAlertToLine } from './src/notify-line.js';
import { getScoreAlertState, resetScoreAlerts, getScoreAlertHistory } from './src/score-alerts.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public');

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

// ---------- รหัสผ่านหน้าเว็บ (เปิดใช้เมื่อตั้ง APP_PASSWORD ใน env เท่านั้น) ----------
// ใช้ตอนเอาขึ้นเว็บจริง (Render/Railway) กันคนที่ได้ลิงก์เข้ามาแก้ settings/trades
// browser จะเด้งช่องให้กรอก — username ใส่อะไรก็ได้ ตรวจแค่ password
const APP_PASSWORD = process.env.APP_PASSWORD || '';
function isAuthorized(header) {
  if (!APP_PASSWORD) return true;
  const [scheme, encoded] = String(header || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(APP_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
app.use((req, res, next) => {
  if (isAuthorized(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Scalp Scanner", charset="UTF-8"');
  res.status(401).send('ต้องใส่รหัสผ่าน');
});
io.use((socket, next) => {
  if (isAuthorized(socket.request.headers.authorization)) return next();
  next(new Error('unauthorized'));
});

app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// ---------- helper: ครอบ route ด้วย try/catch ----------
// สเปกข้อ 9: "อย่าให้ server crash เพราะหุ้นตัวเดียวดึงข้อมูลไม่ได้"
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    log.error(`API ${req.method} ${req.path} ผิดพลาด: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
};

// ═══════════════════ REST API ═══════════════════

// ---------- สถานะระบบ ----------
// /api/status เป็นชื่อหลัก, /api/state เป็นชื่อพ้อง (ให้เรียกได้ทั้งสองแบบ)
const statusHandler = wrap(async (req, res) => {
  res.json({
    ok: true,
    ...scanner.getState(),
    rows: scanner.getRows(),
    watchlistCount: (await getWatchlist()).length,
    providers: getProviderStatus(),
    chains: getChains(),
    lineConfigured: isLineConfigured(),
  });
});
app.get('/api/status', statusHandler);
app.get('/api/state', statusHandler);

// ---------- ควบคุม scanner (สเปกข้อ 2) ----------
app.post('/api/scanner/start', wrap(async (req, res) => {
  const r = scanner.start();
  res.json({ ok: r.ok, reason: r.reason ?? null, state: r.state });
}));

app.post('/api/scanner/stop', wrap(async (req, res) => {
  const r = scanner.stop();
  res.json({ ok: r.ok, reason: r.reason ?? null, state: r.state });
}));

app.post('/api/scanner/scan-now', wrap(async (req, res) => {
  const r = await scanner.scanNow();
  res.json({ ok: r.ok, reason: r.reason ?? null, state: r.state, rows: r.rows ?? [] });
}));

// ชื่อพ้อง (เผื่อเรียกแบบ scanOnce)
app.post('/api/scanner/scan-once', wrap(async (req, res) => {
  const r = await scanner.scanNow();
  res.json({ ok: r.ok, reason: r.reason ?? null, state: r.state, rows: r.rows ?? [] });
}));

// ---------- ผลสแกนล่าสุด ----------
app.get('/api/rows', wrap(async (req, res) => {
  res.json({ ok: true, rows: scanner.getRows(), summary: scanner.getState().summary });
}));

// ---------- log ----------
app.get('/api/logs', wrap(async (req, res) => {
  res.json({ ok: true, logs: log.history() });
}));

app.post('/api/logs/clear', wrap(async (req, res) => {
  log.clear();
  res.json({ ok: true });
}));

// ═══════════════════ Watchlist (สเปกข้อ 3) ═══════════════════

app.get('/api/watchlist', wrap(async (req, res) => {
  const items = await getWatchlist();
  const alerts = await getAllAlertStates();
  res.json({
    ok: true,
    items: items.map((it) => ({ ...it, alert: alerts[it.symbol] || null })),
  });
}));

// เพิ่มหุ้น — รองรับหลายตัวคั่นด้วย comma, validate ทีละตัว
app.post('/api/watchlist', wrap(async (req, res) => {
  const input = req.body?.tickers ?? req.body?.symbol ?? req.body?.ticker ?? '';
  const r = await addTickers(input);
  const items = await getWatchlist();
  res.json({
    ok: r.added.length > 0,
    added: r.added.map((a) => a.symbol),
    results: r.results,
    items,
  });
  io.emit('watchlist', items);
}));

app.delete('/api/watchlist/:symbol', wrap(async (req, res) => {
  const r = await removeTicker(req.params.symbol);
  if (r.ok) await forgetSymbol(req.params.symbol); // ลบสถานะการเตือนไปด้วย
  const items = await getWatchlist();
  res.status(r.ok ? 200 : 404).json({ ...r, items });
  io.emit('watchlist', items);
}));

app.delete('/api/watchlist', wrap(async (req, res) => {
  await clearWatchlist();
  await resetAllAlerts();
  res.json({ ok: true, items: [] });
  io.emit('watchlist', []);
}));

// ---------- ราคาเป้าหมาย (สเปกข้อ 4) ----------
app.put('/api/watchlist/:symbol/target', wrap(async (req, res) => {
  const r = await setTargetPrice(req.params.symbol, req.body?.targetPrice);
  const items = await getWatchlist();
  res.status(r.ok ? 200 : 400).json({ ...r, items });
  io.emit('watchlist', items);
}));

app.put('/api/watchlist/:symbol/note', wrap(async (req, res) => {
  const r = await setNote(req.params.symbol, req.body?.note);
  res.status(r.ok ? 200 : 400).json(r);
}));

// ---------- ตรวจ ticker แบบไม่เพิ่มเข้ารายการ ----------
app.get('/api/validate/:symbol', wrap(async (req, res) => {
  res.json(await validateTicker(req.params.symbol));
}));

// ═══════════════════ การแจ้งเตือน (สเปกข้อ 4) ═══════════════════

app.get('/api/alerts', wrap(async (req, res) => {
  res.json({
    ok: true,
    states: await getAllAlertStates(),
    history: await getAlertHistory(Number(req.query.limit) || 100),
  });
}));

app.post('/api/alerts/:symbol/reset', wrap(async (req, res) => {
  const r = await resetAlert(req.params.symbol);
  res.status(r.ok ? 200 : 404).json(r);
  io.emit('alerts-reset', { symbol: req.params.symbol });
}));

app.post('/api/alerts/reset-all', wrap(async (req, res) => {
  const r = await resetAllAlerts();
  res.json(r);
  io.emit('alerts-reset', { all: true });
}));

// ═══════════════════ Settings (สเปกข้อ 8) ═══════════════════

app.get('/api/settings', wrap(async (req, res) => {
  res.json({
    ok: true,
    settings: settings.publicView,   // API key ถูก mask แล้ว
    sessions: Object.entries(SESSIONS).map(([k, v]) => ({ value: k, label: v.label })),
    providers: getProviderStatus(),
    chains: getChains(),
    mockMode: isMockMode(),
    fxCurrencies: CURRENCIES, // ★ ชื่อสกุลเงินสำหรับตารางเรตเป้าแยกคู่
    thUniverseDefault: TH_UNIVERSE_DEFAULT, // ★ ปุ่ม "คืนรายชื่อตั้งต้น" ในหน้า Settings
  });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const r = await settings.update(req.body || {});
  clearCache(); // ค่าตั้งค่าเปลี่ยน → cache เดิมอาจไม่สอดคล้อง
  res.json({ ok: true, ...r });
  io.emit('settings', r.settings);
  io.emit('providers', getProviderStatus());
  io.emit('state', scanner.getState());
}));

app.post('/api/settings/reset', wrap(async (req, res) => {
  const s = await settings.reset();
  clearCache();
  res.json({ ok: true, settings: s });
  io.emit('settings', s);
}));

// ═══════════════════ Providers (สเปกข้อ 5.5) ═══════════════════

app.get('/api/providers', wrap(async (req, res) => {
  res.json({ ok: true, providers: getProviderStatus(), chains: getChains(), mockMode: isMockMode() });
}));

app.post('/api/providers/clear-cache', wrap(async (req, res) => {
  clearCache();
  log.info('ล้าง cache ข้อมูลทั้งหมดแล้ว');
  res.json({ ok: true });
}));

// ═══════════════════ LINE (ช่องเสริม) ═══════════════════

app.post('/api/line/test', wrap(async (req, res) => {
  const r = await sendLineTest();
  res.status(r.ok ? 200 : 400).json(r);
}));

// ═══════════════════ ★ กฎแจ้งเตือน (ตั้งจากแดชบอร์ด) ═══════════════════
// รับเฉพาะฟิลด์ของกฎแจ้งเตือน — แยกจาก PUT /api/settings เพราะตัวนั้นล้าง cache ข้อมูลหุ้นทั้งหมดด้วย
const ALERT_RULE_KEYS = [
  'scoreAlertEnabled', 'scoreAlertMin', 'scoreAlertScope', 'scoreAlertRequirePassed',
  'scoreAlertLine', 'scoreAlertBrowser', 'priceAlertLine',
  'fxScoreThreshold', 'fxAlertBuy', 'fxAlertSell', 'fxAlertLine', 'fxAlertBrowser', 'fxTargets',
];
app.put('/api/alert-rules', wrap(async (req, res) => {
  const patch = {};
  for (const k of ALERT_RULE_KEYS) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  const r = await settings.update(patch);
  res.json({ ok: true, settings: r.settings, warnings: r.warnings, lineReady: isLineConfigured() });
  io.emit('settings', r.settings);
}));

app.get('/api/score-alerts', wrap(async (req, res) => {
  res.json({ ok: true, state: getScoreAlertState(), history: await getScoreAlertHistory(20) });
}));

app.post('/api/score-alerts/reset', wrap(async (req, res) => {
  res.json(await resetScoreAlerts());
}));

// ═══════════════════ Backtest (สเปกข้อ 7) ═══════════════════

// ═══════════ ★ v2: ไม้ที่เปิดอยู่ ═══════════
// หมายเหตุ: ไม่มี endpoint ไหนส่งคำสั่งซื้อขายจริง — ทั้งหมดเป็นการ "จดบันทึก" ไม้ที่คุณกดเอง
app.get('/api/trades', wrap(async (req, res) => {
  res.json({ ok: true, ...trades.getState() });
}));

app.post('/api/trades/open', wrap(async (req, res) => {
  const symbol = String(req.body?.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ ok: false, error: 'ต้องระบุ symbol' });

  // หาแถวล่าสุดของหุ้นตัวนั้นจากรอบสแกนล่าสุด (ถ้าระบุ tf มาก็ใช้ tf นั้น)
  const tf = req.body?.tf ? String(req.body.tf) : null;
  const rows = scanner.getRows();
  const row = rows.find((r) => r.symbol === symbol && (!tf || r.tf === tf) && !r.dataError);
  if (!row) return res.status(404).json({ ok: false, error: `ไม่พบ ${symbol} ในผลสแกนล่าสุด — กด Scan Now ก่อน` });

  const shares = Number(req.body?.shares);
  const entry = Number(req.body?.entry);
  const out = await trades.openFromRow(row, {
    shares: Number.isFinite(shares) ? shares : null,
    entry: Number.isFinite(entry) ? entry : null,
  });
  res.status(out.ok ? 200 : 400).json(out);
}));

app.post('/api/trades/:id/close', wrap(async (req, res) => {
  const price = Number(req.body?.price);
  const out = await trades.closeManual(req.params.id, Number.isFinite(price) ? price : null);
  res.status(out.ok ? 200 : 404).json(out);
}));

app.post('/api/trades/:id/pyramid', wrap(async (req, res) => {
  const out = await trades.acceptPyramid(req.params.id);
  res.status(out.ok ? 200 : 400).json(out);
}));

app.post('/api/trades/resume', wrap(async (req, res) => {
  res.json({ ok: true, ...(await trades.resumeAfterHalt()) });
}));

app.delete('/api/trades/closed', wrap(async (req, res) => {
  res.json({ ok: true, ...(await trades.clearClosed()) });
}));

// ═══════════ ★ v2.1: ค่าเงิน ═══════════
app.get('/api/fx', wrap(async (req, res) => {
  const snap = fxWatcher.getLast();
  // ยังไม่เคยตรวจ (เพิ่งเปิด server) → ตรวจให้เลยครั้งหนึ่ง
  if (!snap.data && !snap.error) {
    try { await fxWatcher.checkNow(); } catch { /* error ถูกเก็บไว้ใน watcher แล้ว */ }
  }
  const out = fxWatcher.getLast();
  res.json({ ok: true, ...out, enabled: settings.get('fxEnabled') });
}));

// body.pair = ตรวจเฉพาะคู่นั้น · ไม่ระบุ = ตรวจทุกคู่ แล้วคืนข้อมูลของคู่หลัก
app.post('/api/fx/check', wrap(async (req, res) => {
  const pair = req.body?.pair ? String(req.body.pair).toUpperCase() : null;
  if (pair && !fxPairList().includes(pair)) {
    return res.status(400).json({ ok: false, error: `${pair} ไม่ได้อยู่ในรายการที่เฝ้าดู` });
  }
  try {
    const data = await fxWatcher.checkNow(pair);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
}));

app.post('/api/fx/reset', wrap(async (req, res) => {
  const dir = req.body?.direction ? String(req.body.direction) : null;
  const pair = req.body?.pair ? String(req.body.pair).toUpperCase() : null;
  const state = await fxWatcher.resetAlert(dir, pair);
  res.json({ ok: true, alertState: state });
}));

// ★ เพิ่ม/ลบคู่เงินจากการ์ดในแดชบอร์ด — แยกจาก PUT /api/settings
// เพราะตัวนั้นล้าง cache ของหุ้นทั้งหมดด้วย ซึ่งไม่จำเป็นเลยเวลาแค่เพิ่มสกุลเงิน
app.put('/api/fx/pairs', wrap(async (req, res) => {
  const r = await settings.update({ fxPairs: req.body?.pairs ?? [] });
  res.json({ ok: true, warnings: r.warnings, ...fxWatcher.getLast() });
  io.emit('settings', r.settings);
}));

app.get('/api/fx/history', wrap(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  res.json({ ok: true, history: await fxWatcher.getHistory(limit) });
}));

app.get('/api/backtest', wrap(async (req, res) => {
  const result = await runBacktest({
    windowMin: Number(req.query.window) || 60,
    minScore: req.query.minScore != null ? Number(req.query.minScore) : null,
  });
  res.json({ ok: true, ...result });
}));

// ═══════════════════ หน้าเว็บ ═══════════════════
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'settings.html')));
app.get('/backtest', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'backtest.html')));

// 404 สำหรับ API ที่ไม่มี
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: `ไม่พบ endpoint: ${req.method} ${req.originalUrl}` });
});

// ---------- ตัวดัก error กลาง ----------
// สำคัญ: express.json() จะ throw เมื่อ body ไม่ใช่ JSON ที่ถูกต้อง
// ถ้าไม่ดักที่นี่ error จะไปโผล่ที่ uncaughtException แล้วพิมพ์ stack trace ยาวๆ
// ทั้งที่มันเป็นแค่ request ที่ผิดรูปแบบ ไม่ใช่บั๊กของเรา
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isBadJson = err instanceof SyntaxError && err.status === 400 && 'body' in err;
  if (isBadJson) {
    log.warn(`ได้รับ request ที่ body ไม่ใช่ JSON ที่ถูกต้อง (${req.method} ${req.path}) — ตอบ 400`);
    return res.status(400).json({ ok: false, error: 'body ที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง' });
  }
  log.error(`ข้อผิดพลาดที่ไม่ได้จัดการใน ${req.method} ${req.path}: ${err.message}`);
  if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
});

// ═══════════════════ Socket.IO ═══════════════════

io.on('connection', async (socket) => {
  // ส่งสถานะปัจจุบันทั้งชุดให้ client ที่เพิ่งต่อเข้ามา
  try {
    socket.emit('bootstrap', {
      state: scanner.getState(),
      rows: scanner.getRows(),
      logs: log.history(),
      watchlist: await getWatchlist(),
      alerts: await getAllAlertStates(),
      providers: getProviderStatus(),
      settings: settings.publicView,
      mockMode: isMockMode(),
      trades: trades.getState(), // ★ v2
      fx: fxWatcher.getLast(),    // ★ v2.1
    });
  } catch (err) {
    log.error(`ส่งข้อมูลเริ่มต้นให้เบราว์เซอร์ไม่สำเร็จ: ${err.message}`);
  }

  socket.on('disconnect', () => { /* ไม่ต้องทำอะไร */ });
});

// ---------- ต่อ event ของ scanner เข้ากับ Socket.IO ----------
scanner.on('state', (s) => io.emit('state', s));
scanner.on('rows', (rows) => io.emit('rows', rows));
scanner.on('row', (row) => io.emit('row', row));
scanner.on('summary', (s) => io.emit('summary', s));

scanner.on('alert', async (payload) => {
  io.emit('alert', payload); // หน้าเว็บจะทำเสียง + notification + ไฮไลต์

  // ส่ง LINE ด้วย ถ้าเปิดใช้ (ช่องเสริม) และกฎ "ราคาแตะเป้า → LINE" ไม่ได้ถูกปิด
  if (settings.get('lineEnabled') && settings.get('priceAlertLine') !== false) {
    try {
      await pushSignalToLine(payload);
    } catch (err) {
      log.warn(`ส่ง LINE ไม่สำเร็จ: ${err.message}`);
    }
  }
});

// ---------- ★ หุ้นคะแนนถึงเกณฑ์ (กฎจากแดชบอร์ด) ----------
scanner.on('score-alert', async (payload) => {
  io.emit('score-alert', payload); // หน้าเว็บทำเสียง/แจ้งเตือนเอง ถ้ากฎเปิดช่องทางเบราว์เซอร์ไว้
  if (settings.get('lineEnabled') && settings.get('scoreAlertLine')) {
    try {
      await pushScoreAlertToLine(payload);
    } catch (err) {
      log.warn(`ส่งแจ้งเตือนคะแนนเข้า LINE ไม่สำเร็จ: ${err.message}`);
    }
  }
});

// ---------- ★ v2: ไม้ที่เปิดอยู่ ----------
trades.on('change', (st) => io.emit('trades', st));
trades.on('opened', () => io.emit('trades', trades.getState()));
trades.on('exit', (a) => {
  io.emit('trades', trades.getState());
  io.emit('trade-exit', {
    symbol: a.trade.symbol,
    type: a.type,
    label: a.trade.exitLabel || a.type,
    price: a.price,
    totalR: a.trade.totalR,
    note: a.trade.events?.[a.trade.events.length - 1]?.note || '',
  });
});
trades.on('halt', (day) => io.emit('trades', trades.getState()));
scanner.on('trade', () => io.emit('trades', trades.getState()));

// ---------- ★ v2.1: ค่าเงิน ----------
fxWatcher.on('update', (d) => io.emit('fx', { pair: d.pair, data: d, error: null }));
fxWatcher.on('error', (msg, pair) => io.emit('fx', { pair, data: null, error: msg }));
fxWatcher.on('alert', async (entry) => {
  io.emit('fx-alert', entry); // หน้าเว็บทำเสียง + notification + ไฮไลต์การ์ด

  if (settings.get('lineEnabled') && settings.get('fxAlertLine') !== false) {
    try {
      await pushFxToLine(entry);
    } catch (err) {
      log.warn(`ส่งแจ้งเตือนค่าเงินเข้า LINE ไม่สำเร็จ: ${err.message}`);
    }
  }
});

// ---------- log ทุกบรรทัดไปหน้าเว็บ ----------
log.on('log', (entry) => io.emit('log', entry));
log.on('cleared', () => io.emit('logs-cleared'));

// ---------- settings เปลี่ยน → แจ้งทุก client ----------
settings.on('change', () => {
  io.emit('providers', getProviderStatus());
  // ★ v2.1 — รอบตรวจ/สวิตช์ค่าเงินอาจเปลี่ยน จึงตั้งตัวเฝ้าดูใหม่
  // (start() เรียก stop() ให้ก่อนเสมอ จึงไม่เกิด timer ซ้อน)
  fxWatcher.start();
  // รายการคู่เงินอาจเปลี่ยน → ส่งภาพรวมให้หน้าเว็บวาดแถบสกุลเงินใหม่ทันที (ข้อมูลของคู่ใหม่ตามมาทีหลัง)
  io.emit('fx-snapshot', fxWatcher.getLast());
});

// ═══════════════════ เริ่ม server ═══════════════════

// ★ v2.1 — ตัวเฝ้าดูค่าเงินทำงานแยกจากลูปสแกนหุ้นโดยสิ้นเชิง
// (หลักเดียวกับข้อ 2 ของสเปก: server ต้องไม่ผูกกับ scanner loop)
// ค่าเงินต้องถูกเฝ้าแม้ scanner จะหยุดอยู่ เพราะจังหวะแลกเงินไม่เกี่ยวกับการสแกนหุ้น
fxWatcher.start();

server.listen(PORT, () => {
  const st = settings.all;
  const market = marketStatus(st.session);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  const th = thaiMarketStatus(new Date(), { dataDelayMin: st.thDataDelayMin }); // ★
  console.log('  🩺 Scalp Scanner — เครื่องมือช่วยคัดกรองหุ้นอเมริกา + หุ้นไทย');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  เปิดหน้าเว็บที่ : http://localhost:${PORT}`);
  console.log(`  Session         : ${st.session} (${market.sessionLabel})`);
  console.log(`  หุ้นอเมริกา     : ${st.usEnabled === false ? 'ปิดใช้' : market.open ? '🟢 เปิด' : '🔴 ปิด'} — เวลานิวยอร์ก ${market.nyTime}`);
  console.log(`  หุ้นไทย         : ${st.thEnabled === false ? 'ปิดใช้' : th.open ? '🟢 เปิด' : `🔴 ${th.actualPhaseLabel}`} — เวลาไทย ${th.localTime}`);
  console.log(`  รอบสแกน         : ทุก ${st.scanIntervalSec} วินาที`);
  console.log(`  เงินทุน         : $${st.accountSize.toLocaleString()} (หุ้นอเมริกา) · ฿${Number(st.thAccountSize).toLocaleString()} (หุ้นไทย) · เสี่ยงต่อไม้ ${st.riskPct}%`);
  if (isMockMode()) {
    console.log('');
    console.log('  ⚠️  โหมดข้อมูลจำลอง (MOCK_DATA=true) — ตัวเลขทั้งหมดไม่ใช่ราคาจริง');
  }
  console.log('');
  console.log('  scanner ยังไม่เริ่มทำงาน — กดปุ่ม "▶ Start Scanner" ในหน้าเว็บ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  log.info(`server พร้อมใช้งานที่ http://localhost:${PORT}`);
});

// ═══════════════════ ปิดโปรแกรมอย่างเรียบร้อย ═══════════════════
let shuttingDown = false;
async function shutdown(signal) {
  fxWatcher.stop(); // ★ v2.1
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 ได้รับสัญญาณ ${signal} — กำลังปิดโปรแกรม...`);

  scanner.stop();          // หยุดลูปสแกนและเคลียร์ timer
  await flushAll();        // รอให้การเขียนไฟล์ที่ค้างเสร็จ (ไม่ให้ข้อมูลหาย)
  io.close();

  server.close(() => {
    console.log('ปิดเรียบร้อย ขอบคุณที่ใช้งาน 🙏');
    process.exit(0);
  });

  // ถ้าปิดไม่ลงใน 5 วินาที บังคับออก
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// กัน server ตายจาก error ที่ไม่ได้ดัก (สเปกข้อ 9)
process.on('unhandledRejection', (reason) => {
  log.error(`Promise ที่ไม่ได้ดัก error: ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`ข้อผิดพลาดที่ไม่ได้ดัก: ${err.message}`);
  console.error(err.stack);
  // ไม่ exit — ให้ server ทำงานต่อ (log ไว้แล้ว user เห็นในหน้าเว็บ)
});

export { app, server, io };
