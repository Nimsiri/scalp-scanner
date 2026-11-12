// line.js — ส่งข้อความแจ้งเตือนเข้า LINE (Flex Message) และสร้างการ์ดสัญญาณเข้า/ออก
import { CFG } from './config.js';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const MAX_BUBBLES_PER_PUSH = 5; // LINE จำกัดสูงสุด 5 ข้อความต่อการยิงหนึ่งครั้ง

function etTimeString(date = new Date()) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date) + ' ET';
}

// ส่งข้อความ (array ของ LINE message object) เข้า LINE
// แบ่งส่งครั้งละไม่เกิน 5 ข้อความ ถ้า dryRun แค่ log แทนการยิงจริง
export async function pushLine(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  const chunks = [];
  for (let i = 0; i < messages.length; i += MAX_BUBBLES_PER_PUSH) {
    chunks.push(messages.slice(i, i + MAX_BUBBLES_PER_PUSH));
  }

  for (const chunk of chunks) {
    if (CFG.dryRun) {
      console.log('📨 [dry-run] จะส่งข้อความ LINE:', JSON.stringify(chunk, null, 2));
      continue;
    }

    try {
      const res = await fetch(LINE_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CFG.lineToken}`,
        },
        body: JSON.stringify({ to: CFG.lineTarget, messages: chunk }),
      });

      if (res.status === 401) {
        console.error('❌ ส่ง LINE ไม่สำเร็จ: LINE Token ไม่ถูกต้องหรือหมดอายุ กรุณาไปสร้างโทเคนใหม่ที่ LINE Developers Console');
        continue;
      }
      if (res.status === 400) {
        const body = await res.text().catch(() => '');
        console.error(`❌ ส่ง LINE ไม่สำเร็จ: Group ID / User ID ไม่ถูกต้อง (LINE_TARGET_ID) รายละเอียด: ${body}`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`❌ ส่ง LINE ไม่สำเร็จ (HTTP ${res.status}): ${body}`);
      }
    } catch (err) {
      console.error(`❌ ส่ง LINE ไม่สำเร็จ (เชื่อมต่อเครือข่ายผิดพลาด): ${err.message}`);
    }
  }
}

function scoreColor(score) {
  if (score >= 85) return '#C62828'; // แดง
  if (score >= 75) return '#EF6C00'; // ส้ม
  return '#1565C0'; // น้ำเงิน
}

function row(label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 4 },
      { type: 'text', text: String(value), size: 'sm', color: '#111111', flex: 6, align: 'end', wrap: true },
    ],
  };
}

function chip(text) {
  return {
    type: 'box',
    layout: 'baseline',
    backgroundColor: '#EEEEEE',
    cornerRadius: 'md',
    paddingAll: '4px',
    paddingStart: '8px',
    paddingEnd: '8px',
    contents: [{ type: 'text', text, size: 'xxs', color: '#444444' }],
  };
}

// สร้างการ์ด Flex สัญญาณ "เข้า" จาก signal object (ดูโครงสร้าง signal ใน monitor.js)
export function buildFlex(signal) {
  const color = scoreColor(signal.score);
  const changeSign = signal.changePct >= 0 ? '+' : '';

  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'horizontal',
      backgroundColor: color,
      paddingAll: '16px',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: signal.symbol, color: '#FFFFFF', size: 'xl', weight: 'bold' },
            { type: 'text', text: `TF ${signal.tf}`, color: '#FFFFFFCC', size: 'xs' },
          ],
          flex: 6,
        },
        {
          type: 'box',
          layout: 'vertical',
          alignItems: 'flex-end',
          contents: [
            { type: 'text', text: 'คะแนน', color: '#FFFFFFCC', size: 'xs', align: 'end' },
            { type: 'text', text: String(Math.round(signal.score)), color: '#FFFFFF', size: 'xxl', weight: 'bold', align: 'end' },
          ],
          flex: 4,
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: `$${signal.price.toFixed(2)}`, size: 'xxl', weight: 'bold' },
            {
              type: 'text',
              text: `${changeSign}${signal.changePct?.toFixed(2) ?? '0.00'}%`,
              size: 'md',
              color: signal.changePct >= 0 ? '#2E7D32' : '#C62828',
              align: 'end',
              gravity: 'center',
            },
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          spacing: 'sm',
          contents: [
            row('เข้า (Entry)', `$${signal.entry.toFixed(2)}`),
            row('จุดตัดขาดทุน (Stop)', `$${signal.stop.toFixed(2)}`),
            row('เป้าที่ 1 (TP1)', `$${signal.tp1.toFixed(2)}`),
            row('เป้าที่ 2 (TP2)', `$${signal.tp2.toFixed(2)}`),
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          spacing: 'sm',
          contents: [
            row('จำนวนหุ้นที่ควรซื้อ', `${signal.shares.toLocaleString()} หุ้น`),
            row('เงินที่เสี่ยง', `$${signal.riskAmount.toFixed(2)}`),
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          wrap: true,
          contents: (signal.reasons || []).slice(0, 6).map(chip),
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          contents: [
            row('RSI', signal.rsi != null ? signal.rsi.toFixed(1) : '-'),
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            row('RVOL', signal.rvol != null ? `${signal.rvol.toFixed(2)}x` : '-'),
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            row('ATR%', signal.atrPct != null ? `${signal.atrPct.toFixed(2)}%` : '-'),
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'text',
          text: `ภาวะตลาด: ${signal.regime || '-'}  •  ${etTimeString(signal.ts)}  •  ${signal.source || 'yahoo'}`,
          size: 'xxs',
          color: '#999999',
          wrap: true,
        },
      ],
    },
  };

  return { type: 'flex', altText: `สัญญาณเข้า ${signal.symbol} คะแนน ${Math.round(signal.score)}`, contents: bubble };
}

const EXIT_LABEL = {
  STOP: 'โดนจุดตัดขาดทุน (STOP)',
  TP1: 'ถึงเป้าที่ 1 (TP1)',
  TP2: 'ถึงเป้าที่ 2 (TP2) — ปิดไม้',
  BREAKEVEN: 'ปิดไม้เท่าทุน (BREAKEVEN)',
  EMA5_LOST: 'หลุด EMA5 — ปิดไม้',
  VWAP_LOST: 'หลุด VWAP — ปิดไม้',
  TIME_STOP: 'ถือนานเกินกำหนด — ปิดไม้ (TIME STOP)',
};

function exitColor(type) {
  if (type === 'TP1' || type === 'TP2') return '#2E7D32'; // เขียว
  if (type === 'BREAKEVEN') return '#EF6C00'; // ส้ม
  return '#C62828'; // แดง
}

// สร้างการ์ด Flex สัญญาณ "ออก" จาก event object (ดูโครงสร้างใน positions.js checkExits())
export function buildExitFlex(event) {
  const color = exitColor(event.type);
  const label = EXIT_LABEL[event.type] || event.type;

  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'horizontal',
      backgroundColor: color,
      paddingAll: '16px',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: `${event.emoji} ${event.symbol}`, color: '#FFFFFF', size: 'xl', weight: 'bold' },
            { type: 'text', text: label, color: '#FFFFFFCC', size: 'xs', wrap: true },
          ],
          flex: 7,
        },
        {
          type: 'box',
          layout: 'vertical',
          alignItems: 'flex-end',
          contents: [
            { type: 'text', text: 'R', color: '#FFFFFFCC', size: 'xs', align: 'end' },
            { type: 'text', text: `${event.r >= 0 ? '+' : ''}${event.r.toFixed(2)}`, color: '#FFFFFF', size: 'xxl', weight: 'bold', align: 'end' },
          ],
          flex: 3,
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: [
        row('ราคาเข้า → ปัจจุบัน', `$${event.entry.toFixed(2)} → $${event.price.toFixed(2)}`),
        row('ถือมาแล้ว', `${event.heldMin.toFixed(0)} นาที`),
        { type: 'separator', margin: 'sm' },
        row('กำไรสูงสุดระหว่างถือ (MFE)', `${event.mfeR.toFixed(2)}R`),
        row('ขาดทุนสูงสุดระหว่างถือ (MAE)', `${event.maeR.toFixed(2)}R`),
        { type: 'separator', margin: 'sm' },
        row('สรุปกำไร/ขาดทุนวันนี้', `${event.dayR >= 0 ? '+' : ''}${event.dayR.toFixed(2)}R`),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'text', text: etTimeString(new Date()), size: 'xxs', color: '#999999' },
      ],
    },
  };

  return { type: 'flex', altText: `สัญญาณออก ${event.symbol} ${label}`, contents: bubble };
}
