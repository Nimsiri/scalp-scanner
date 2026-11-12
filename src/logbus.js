// src/logbus.js — แทน console.log ด้วย event bus ที่ส่ง log ไปหน้าเว็บได้
// เก็บ log ล่าสุดไว้ในหน่วยความจำ (ring buffer) เพื่อให้เบราว์เซอร์ที่เพิ่งเปิด
// เห็นย้อนหลังได้ทันที ไม่ต้องรอ log ใหม่
// ยังพิมพ์ลง terminal ด้วย เพื่อให้โหมด CLI (monitor.js) ทำงานเหมือนเดิม

import { EventEmitter } from 'node:events';

const MAX_LINES = 500; // เก็บ 500 บรรทัดล่าสุด

class LogBus extends EventEmitter {
  constructor() {
    super();
    this.buffer = [];
    this._seq = 0;
    this.echoToConsole = true; // ปิดได้ตอนรัน test เพื่อไม่ให้ output รบกวน
  }

  _push(level, msg, meta) {
    const entry = {
      id: ++this._seq,
      ts: new Date().toISOString(),
      level, // 'info' | 'warn' | 'error' | 'success'
      msg: String(msg),
      ...(meta ? { meta } : {}),
    };

    this.buffer.push(entry);
    if (this.buffer.length > MAX_LINES) this.buffer.shift();

    if (this.echoToConsole) {
      const prefix = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', success: '✅' }[level] || '  ';
      const out = level === 'error' || level === 'warn' ? console.error : console.log;
      out(`${prefix} ${entry.msg}`);
    }

    this.emit('log', entry);
    return entry;
  }

  info(msg, meta) { return this._push('info', msg, meta); }
  warn(msg, meta) { return this._push('warn', msg, meta); }
  error(msg, meta) { return this._push('error', msg, meta); }
  success(msg, meta) { return this._push('success', msg, meta); }

  // คืน log ทั้งหมดที่เก็บไว้ (ให้ client ที่เพิ่งต่อเข้ามา)
  history() {
    return [...this.buffer];
  }

  clear() {
    this.buffer = [];
    this.emit('cleared');
  }
}

export const log = new LogBus();
