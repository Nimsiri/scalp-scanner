// config.js — โหลดค่าตั้งค่าทั้งหมดจาก .env แล้วแปลงเป็น object ที่ใช้งานง่าย
import 'dotenv/config';

// ---------- helper แปลงค่า .env ----------
// N() แปลงเป็นตัวเลข ถ้าไม่มีค่าหรือแปลงไม่ได้ ใช้ค่า default
function N(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

// B() แปลงเป็น boolean ("true"/"1" = จริง)
function B(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';
}

// L() แปลง comma-separated string เป็น array ของ string (ตัดช่องว่างและตัวอักษรว่างทิ้ง)
function L(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// --dry-run flag จาก command line (ใช้คู่กับ env DRY_RUN)
const argvDryRun = process.argv.includes('--dry-run');

export const CFG = {
  // ---------- แหล่งข้อมูลราคา ----------
  provider: process.env.PROVIDER || 'yahoo',
  finnhubApiKey: process.env.FINNHUB_API_KEY || '',
  alpacaApiKey: process.env.ALPACA_API_KEY || '',
  alpacaApiSecret: process.env.ALPACA_API_SECRET || '',
  maxQuoteStaleSec: N('MAX_QUOTE_STALE_SEC', 90),
  stitchLastBar: B('STITCH_LAST_BAR', true),

  // ---------- การคัดเลือกหุ้น (universe) ----------
  screeners: L('SCREENERS', ['day_gainers', 'most_actives']),
  extraTickers: L('EXTRA_TICKERS', []),
  universeSize: N('UNIVERSE_SIZE', 60),
  minPrice: N('MIN_PRICE', 2),
  maxPrice: N('MAX_PRICE', 1000),
  minAvgVolume: N('MIN_AVG_VOLUME', 1_000_000),

  // ---------- คุณภาพราคา / สภาพคล่อง ----------
  maxSpreadPct: N('MAX_SPREAD_PCT', 0.35),
  minDollarVolume5m: N('MIN_DOLLAR_VOLUME_5M', 500_000),

  // ---------- ความเสี่ยงจากข่าว/การหยุดซื้อขาย ----------
  skipEarningsDays: N('SKIP_EARNINGS_DAYS', 2),
  haltGapSec: N('HALT_GAP_SEC', 420),

  // ---------- ตัวชี้วัดทางเทคนิค ----------
  timeframes: L('TIMEFRAMES', ['5m', '15m']),
  volSpike: N('VOL_SPIKE', 2.0),
  rsiLow: N('RSI_LOW', 50),
  rsiHigh: N('RSI_HIGH', 70),
  rsiOversold: N('RSI_OVERSOLD', 35),
  lookback: N('LOOKBACK', 20),
  minScore: N('MIN_SCORE', 70),

  // ---------- Relative Volume ----------
  rvolDays: N('RVOL_DAYS', 10),
  minRvolTod: N('MIN_RVOL_TOD', 1.8),

  // ---------- การบริหารความเสี่ยง / เป้าหมายกำไร ----------
  atrStopMult: N('ATR_STOP_MULT', 1.5),
  atrTp1: N('ATR_TP1', 1.5),
  atrTp2: N('ATR_TP2', 2.5),
  maxExtension: N('MAX_EXTENSION', 2.5),
  requireVwap: B('REQUIRE_VWAP', true),

  // ---------- เงินทุน / ขนาดพอร์ต ----------
  accountSize: N('ACCOUNT_SIZE', 10000),
  riskPct: N('RISK_PCT', 1),
  dailyLossLimitR: N('DAILY_LOSS_LIMIT_R', 3),
  maxOpenPositions: N('MAX_OPEN_POSITIONS', 4),
  maxAlertsPerDay: N('MAX_ALERTS_PER_DAY', 25),
  timeStopMin: N('TIME_STOP_MIN', 45),
  exitPollSec: N('EXIT_POLL_SEC', 30),

  // ---------- จังหวะการทำงาน ----------
  pollMs: N('POLL_MS', 60_000),
  cooldownMs: N('COOLDOWN_MS', 900_000),
  session: process.env.SESSION || 'regular',
  dryRun: argvDryRun || B('DRY_RUN', false),

  // ---------- LINE ----------
  lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  lineTarget: process.env.LINE_TARGET_ID || '',
};

// ---------- helper เวลา ----------
export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// คืนเวลาปัจจุบันตามเขต America/New_York เป็น {weekday, minutes}
// weekday: 0=อาทิตย์ ... 6=เสาร์, minutes = นาทีนับจากเที่ยงคืน (0-1439)
export function nyNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[map.weekday] ?? new Date().getDay();
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // บาง locale คืน 24:xx แทน 00:xx
  const minute = Number(map.minute);
  const minutes = hour * 60 + minute;

  return { weekday, minutes };
}

// คืนวันที่ปัจจุบันตามเขต America/New_York รูปแบบ YYYY-MM-DD (ใช้เป็น key แยกวัน)
export function nyDateKey() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA ให้รูปแบบ YYYY-MM-DD ตรงตัว
}

// เช็คว่าตลาดเปิดอยู่หรือไม่ ตาม CFG.session
// regular = 09:30-16:00 ET (นาที 570-960), extended = 04:00-20:00, always = เปิดเสมอ
export function marketOpen(session = CFG.session) {
  if (session === 'always') return true;

  const { weekday, minutes } = nyNow();
  if (weekday === 0 || weekday === 6) return false; // เสาร์-อาทิตย์ตลาดปิด

  if (session === 'extended') {
    return minutes >= 4 * 60 && minutes < 20 * 60;
  }
  // default: regular
  return minutes >= 570 && minutes < 960;
}

// เช็คความครบถ้วนของค่าตั้งค่าที่จำเป็น (โดยเฉพาะ LINE)
// ถ้าขาดสิ่งสำคัญ จะพิมพ์คำอธิบายภาษาไทยและวิธีแก้ แล้วปิดโปรแกรม (ยกเว้นโหมด dry-run)
export function validateConfig() {
  const problems = [];

  if (!CFG.lineToken) {
    problems.push(
      '- ขาด LINE_CHANNEL_ACCESS_TOKEN: ไปที่ https://developers.line.biz/console/ > เลือก Provider > เลือก Messaging API Channel ของคุณ > แท็บ "Messaging API" > เลื่อนหา "Channel access token" แล้วกด Issue เพื่อสร้างโทเคน จากนั้นคัดลอกมาใส่ในไฟล์ .env'
    );
  }
  if (!CFG.lineTarget) {
    problems.push(
      '- ขาด LINE_TARGET_ID: เป็น ID ของกลุ่มหรือผู้ใช้ที่จะรับข้อความ หาได้จาก LINE Official Account Manager หรือใช้ Webhook ของ Messaging API เพื่อดู userId/groupId แล้วนำมาใส่ในไฟล์ .env'
    );
  }

  if (problems.length > 0) {
    console.error('\n❌ ตั้งค่าไม่ครบ ไม่สามารถเริ่มโปรแกรมได้:\n');
    console.error(problems.join('\n'));
    console.error('\nแก้ไขไฟล์ .env แล้วรันโปรแกรมใหม่อีกครั้ง (ดูตัวอย่างในไฟล์ .env.example)\n');

    if (CFG.dryRun) {
      console.warn('⚠️  กำลังรันในโหมดทดสอบ (--dry-run) จึงยอมให้ทำงานต่อได้ แต่จะไม่มีการส่งข้อความ LINE จริง\n');
      return;
    }
    process.exit(1);
  }
}
