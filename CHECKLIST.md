# CHECKLIST — Self-Audit ตามโจทย์ทุกข้อ

> ตรวจโดยเปิดไฟล์อ่านจริงและรัน `npm test` จริง
> **กติกา: ห้ามติ๊ก ✅ ถ้ายังไม่ได้เขียนโค้ดจริง · ห้ามนับ TODO comment เป็นเสร็จ · ทำไม่ได้ให้บอกเหตุผลตรงๆ**
>
> สร้างเมื่อ: 2026-09-08 · ผลทดสอบล่าสุด: `npm test` → **✅ 79 / ❌ 0**
>
> **รอบที่ 2:** หลังเขียน checklist รอบแรกเสร็จ ผมให้ตัวตรวจสอบอิสระอ่านโค้ดทั้งหมดใหม่แบบมองหาบั๊ก
> เจอบั๊กจริงเพิ่ม **7 ข้อ** (รวมข้อที่ละเมิดสเปกข้อ 2 ตรงๆ) แก้แล้วทั้งหมด + เพิ่ม regression test 9 ข้อ
> ดูรายละเอียดที่หัวข้อ **บั๊กรอบที่ 2** ท้ายเอกสาร

**สัญลักษณ์:** ✅ ทำแล้ว (มีโค้ดจริง + ทดสอบแล้ว) · ⚠️ ทำบางส่วน · ❌ ยังไม่ทำ

---

## ข้อ 0 — งานแรกที่ต้องทำ

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 0.1 อ่านไฟล์ทั้งหมด + สรุปโครงสร้างเดิม | ✅ ทำแล้ว | — (ตอบในแชท) | อ่านครบ 9 ไฟล์ + `.env` (40 ตัวแปร) + `package.json` · สรุปด่านคัดกรอง 16 ด่าน + สูตรคะแนน + risk math + regime + exit 7 แบบ |
| 0.2 ไม่ลบโค้ดเดิม | ✅ ทำแล้ว | `monitor.js` `config.js` `indicators.js` `market.js` `positions.js` `journal.js` `line.js` `backtest.js` | อยู่ครบทุกไฟล์ · แก้เฉพาะ `datafeed.js` (จำเป็นเพราะอัปเกรด v3) และ `start.bat` (แก้ encoding) |
| 0.3 ย้าย logic สแกนเป็น module แยก | ✅ ทำแล้ว | `src/scanner.js:31` `class ScannerEngine` | `start()` :69 · `stop()` :85 · `scanNow()` :105 · `_analyse()` :330 · web layer เรียกผ่าน `scanner` singleton :759 |
| 0.4 เสนอแผนเป็นขั้นๆ ก่อนลงมือ | ✅ ทำแล้ว | — (ตอบในแชท + `claude/scalp-scanner-webapp-plan.md` ใน Project) | เสนอแผน 7 stage + ถาม 4 คำถามก่อนเขียนโค้ด |

---

## ข้อ 1 — Web UI

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 1.1 Express.js เป็น backend | ✅ ทำแล้ว | `server.js:12,37` | Express 5.2.1 |
| 1.2 Socket.IO push realtime | ✅ ทำแล้ว | `server.js:15,39` · event ที่ต่อไว้ :277-320 | `bootstrap` `state` `rows` `row` `summary` `log` `alert` `watchlist` `providers` |
| 1.3 HTML + Tailwind CDN ธีมมืด ไม่มี build step | ✅ ทำแล้ว | `public/index.html:7` (CDN) · CSS ธีมมืด :9-27 | ไม่มี build step จริง — เปิดไฟล์ได้ตรงๆ |
| 1.4 รันที่ localhost:3000 | ✅ ทำแล้ว | `server.js:34` `PORT = 3000` | ทดสอบแล้วใน smoke test (`server listen ที่ port ที่ถูกต้อง`) |
| 1.5 สถานะระบบ: กำลังรัน/หยุด | ✅ ทำแล้ว | `public/index.html:71` · render `public/app.js:151` | |
| 1.6 สถานะระบบ: ตลาดเปิด-ปิด | ✅ ทำแล้ว | `public/index.html:73` · `src/market-hours.js:107` `marketStatus()` | บอกเหตุผลด้วยว่าปิดเพราะอะไร (เสาร์-อาทิตย์/วันหยุด/นอกเวลา session) |
| 1.7 สถานะระบบ: session ปัจจุบัน | ✅ ทำแล้ว | `public/index.html:74` · `src/market-hours.js:117` | แสดงทั้ง session ที่ตั้งไว้และช่วงที่ตลาดอยู่จริง |
| 1.8 ตาราง: Ticker | ✅ ทำแล้ว | `public/index.html:175` | |
| 1.9 ตาราง: ราคาล่าสุด | ✅ ทำแล้ว | `public/index.html:176` | |
| 1.10 ตาราง: %เปลี่ยนแปลง | ✅ ทำแล้ว | `public/index.html:177` | |
| 1.11 ตาราง: Volume | ✅ ทำแล้ว | `public/index.html:178` | |
| 1.12 ตาราง: RVOL | ✅ ทำแล้ว | `public/index.html:179` | |
| 1.13 ตาราง: แนวต้าน | ✅ ทำแล้ว | `public/index.html:180` | แสดงระดับ + ยืนยันแล้ว/ไม่ยืนยัน + จำนวนครั้งที่ชน |
| 1.14 ตาราง: ราคาเป้าหมายแจ้งเตือน | ✅ ทำแล้ว | `public/index.html:181` | แสดงระยะห่างอีกกี่ % ด้วย |
| 1.15 ตาราง: คะแนน | ✅ ทำแล้ว | `public/index.html:186` | แยกสีตามช่วงคะแนน |
| 1.16 ตาราง: สถานะ | ✅ ทำแล้ว | `public/index.html:187` | badge: สัญญาณ/ผ่านด่าน/ตกด่าน/ข้อมูลไม่อัปเดต/แตะเป้าแล้ว/screener |
| 1.17 Log realtime แทน terminal | ✅ ทำแล้ว | `src/logbus.js:1` · `public/index.html:209` | ring buffer 500 บรรทัด · client ที่เพิ่งเปิดเห็นย้อนหลังทันที |
| 1.18 Log แยกสี info/warn/error | ✅ ทำแล้ว | `public/app.js` `appendLog()` | 4 ระดับ: info เทา · warn เหลือง · error แดง · success เขียว |
| 1.19 summary: จำนวนหุ้นที่สแกน | ✅ ทำแล้ว | `public/index.html:111` | |
| 1.20 summary: จำนวนสัญญาณที่เจอ | ✅ ทำแล้ว | `public/index.html:115` | |
| 1.21 summary: ภาวะตลาด | ✅ ทำแล้ว | `public/index.html:131` · `src/regime.js:71` | + ตัวคูณขนาดไม้ |

**เกินจากที่ขอ:** คอลัมน์ R:R, Expected Move, ขนาดไม้, ที่มาเป้า · การ์ด "ผ่านด่านคุณภาพ" / "แจ้งเตือนแล้ว" / "ข้อมูลไม่อัปเดต" · ตัวกรองตาราง 2 แบบ

---

## ข้อ 2 — ปุ่มควบคุมบนหน้าเว็บ

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 2.1 ปุ่ม ▶ Start Scanner | ✅ ทำแล้ว | `public/index.html:85` · `server.js:76` · `src/scanner.js:69` | ทดสอบแล้ว: `POST start` → `running=true` |
| 2.2 ปุ่ม ⏸ Stop Scanner | ✅ ทำแล้ว | `public/index.html:88` · `server.js:81` · `src/scanner.js:85` | |
| 2.3 **หยุดจริง ไม่ค้าง interval** | ✅ ทำแล้ว | `src/scanner.js:89` (`_abort=true`) · `:92` (`clearTimeout`) · `:148` (setTimeout recursive) | **ทดสอบพิสูจน์แล้ว**: ตั้ง interval 10 วิ → กด stop → รอ 12 วิ → `scanCount` ไม่เปลี่ยน (1→1) · กัน 3 ชั้น: clearTimeout + ธง `_abort` เช็คหลังทุก await + ใช้ setTimeout ไม่ใช่ setInterval |
| 2.4 ปุ่ม 🔄 Scan Now | ✅ ทำแล้ว | `public/index.html:91` · `server.js:86` · `src/scanner.js:105` | ทดสอบแล้ว: ทำงานได้แม้ลูปหยุดอยู่ และไม่ทำให้ลูปกลับมาทำงาน |
| 2.5 ปุ่มเปลี่ยนสี/สถานะตามจริง | ✅ ทำแล้ว | `public/app.js:168-190` `renderState()` | สถานะมาจาก `state` event ของ server ไม่ใช่เดาฝั่ง client → เปิด 2 แท็บก็ตรงกัน · Stop กดไม่ได้ตอนหยุด · Scan Now กดไม่ได้ตอนกำลังสแกน |
| 2.6 **Express แยกจาก scanner loop** | ✅ ทำแล้ว | `server.js:19` (import แต่ไม่ start) | **ทดสอบแล้ว**: `scanner ยังไม่เริ่มทำงานเอง (แยกจาก server)` → หลังเปิด server `running=false` |
| 2.7 เปิดเว็บทิ้งไว้ได้แม้ scanner หยุด | ✅ ทำแล้ว | เหมือน 2.6 | |
| 2.8 กด Start ใหม่ได้ไม่ต้องรีสตาร์ท | ✅ ทำแล้ว | `src/scanner.js:69` | ทดสอบแล้ว: start → stop → scan-now → ทำงานได้ทั้งหมด · กดซ้ำไม่พัง (แจ้งเหตุผลกลับ) |
| 2.9 run.bat encoding UTF-8 | ✅ ทำแล้ว | `run.bat` | UTF-8 · ไม่มี BOM · CRLF · **`chcp 65001` บรรทัดที่ 2** (สาเหตุที่ start.bat เดิมภาษาไทยเป็นตัวขยะ) |
| 2.10 run.bat รัน node server.js | ✅ ทำแล้ว | `run.bat:74` | + ตรวจ Node.js, `npm install` ถ้าไม่มี, สร้าง `.env` จาก `.env.example` |
| 2.11 run.bat เปิดเบราว์เซอร์อัตโนมัติ | ✅ ทำแล้ว | `run.bat:64` | หน่วง 3 วินาทีให้ server พร้อมก่อน |

> ⚠️ **ยังไม่ได้ทดสอบบน Windows จริง** — เขียนถูกตามหลักและตรวจ encoding/BOM/CRLF แล้ว แต่ผมรันบน Linux ต้องให้คุณดับเบิลคลิกยืนยันอีกที

---

## ข้อ 3 — Watchlist

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 3.1 ช่อง input พิมพ์ Ticker + ปุ่มเพิ่ม | ✅ ทำแล้ว | `public/index.html:143,145` · `public/app.js` `addTickers()` | กด Enter ก็ได้ |
| 3.2 แสดงเป็นรายการ | ✅ ทำแล้ว | `public/index.html:151` · `public/app.js` `renderWatchlist()` | แสดงราคาปัจจุบันในชิปด้วย |
| 3.3 ปุ่มลบรายตัว | ✅ ทำแล้ว | `src/watchlist.js:107` · `server.js:137` | ทดสอบแล้ว: ลบแล้วหายจากไฟล์จริง · ลบตัวที่ไม่มี → 404 ไม่ crash |
| 3.4 รองรับหลายตัวคั่นด้วย comma | ✅ ทำแล้ว | `src/watchlist.js:50` | รับ comma, เว้นวรรค, ขึ้นบรรทัดใหม่, semicolon · ตัดตัวซ้ำในคำขอเดียวกัน |
| 3.5 validate ว่ามีจริงก่อนเพิ่ม (fetch quote) | ✅ ทำแล้ว | `src/providers/index.js:273` `validateTicker()` · เรียกที่ `src/watchlist.js:78` | ตรวจรูปแบบก่อน (ประหยัด API call) แล้วค่อย fetch quote จริง |
| 3.6 ไม่มีให้แจ้ง error | ✅ ทำแล้ว | `src/watchlist.js:80` · `public/app.js` `addTickers()` | **รายงานแยกรายตัว** เช่น "✓ NVDA ($303.45) · ✗ ZZFAKE — ไม่พบราคาของสัญลักษณ์นี้" · ทดสอบแล้ว |
| 3.7 บันทึกลง data/watchlist.json | ✅ ทำแล้ว | `src/watchlist.js:24` · `src/store.js:60` | **ทดสอบพิสูจน์แล้ว**: อ่านไฟล์จากดิสก์จริง (ไม่ใช่ผ่าน API) แล้วยืนยันว่ามีข้อมูล |
| 3.8 ปิดโปรแกรมแล้วเปิดใหม่ข้อมูลไม่หาย | ✅ ทำแล้ว | `src/store.js:79` เขียน `.tmp` แล้ว `rename` (atomic) | rename เป็น atomic ของ OS → ไฟล์ไม่เสียแม้ปิดกลางคัน · JSON เสียจะถูกย้ายเป็น `.corrupt-<ts>` ไม่ลบทิ้ง |

---

## ข้อ 4 — ระบบแจ้งเตือนราคา

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 4.1 ช่องกรอกราคาเป้าหมายแต่ละ Ticker | ✅ ทำแล้ว | `public/app.js` `renderWatchlist()` · `src/watchlist.js:121` · `server.js:153` | ช่องอยู่ในชิปของแต่ละตัว · ขอบฟ้า = ตั้งเอง, ขอบเทา = auto |
| 4.2 กรอกเอง → ใช้ราคานั้น | ✅ ทำแล้ว | `src/levels.js:216` `resolveAlertTarget()` mode `manual` | เตือนถ้าราคาที่ตั้งอยู่ใต้ราคาปัจจุบันแล้ว |
| 4.3 ไม่กรอก → แนวต้าน × 0.999 | ✅ ทำแล้ว | `src/levels.js:238` | `resistance.level * (1 - alertOffsetPct/100)` · offset ปรับได้ใน Settings |
| 4.4 วิธีหาแนวต้าน + **อธิบายเหตุผล** | ✅ ทำแล้ว | `src/levels.js:1-27` (เหตุผลเต็ม) · `findPivotHighs():32` · `clusterLevels():73` · `findResistance():123` | เลือก **fractal swing pivot (k=2) + ATR clustering** · เหตุผลอยู่ในคอมเมนต์หัวไฟล์ + README §6 + ตอบในแชท |
| 4.5 คำนวณแนวต้านใหม่ทุกรอบ | ✅ ทำแล้ว | `src/scanner.js:400` (อยู่ใน `_analyse` ที่เรียกทุกรอบ) | |
| 4.6 แสดงค่าล่าสุดในตาราง | ✅ ทำแล้ว | `public/index.html:180` · `public/app.js` `resCell` | |
| 4.7 บอกชัดว่า "ตั้งเอง" หรือ "auto (แนวต้าน −0.1%)" | ✅ ทำแล้ว | `public/index.html:182` · `public/app.js` `modeBadge` | ป้ายฟ้า = ตั้งเอง · ป้ายเทา = auto · มี tooltip อธิบายที่มา |
| 4.8 แถวไฮไลต์สีเด่น | ✅ ทำแล้ว | `public/index.html:31` `.row-alert` | |
| 4.9 animation กระพริบ | ✅ ทำแล้ว | `public/index.html:29-33` `@keyframes alertBlink` | 1.1 วินาที/รอบ + ขอบซ้ายสีเหลือง |
| 4.10 เสียงเตือน | ✅ ทำแล้ว | `public/app.js:59` `playAlertSound()` | Web Audio API — บี๊บ 880Hz → 1180Hz **ไม่ต้องมีไฟล์ .mp3** · มี envelope กัน pop · ปุ่ม "ทดสอบเสียง" |
| 4.11 Browser Notification | ✅ ทำแล้ว | `public/app.js:116` `showNotification()` | ใช้ `tag` เดียวกันต่อ symbol → ไม่กองพะเนิน |
| 4.12 ขอ permission ตอนเปิดหน้าเว็บครั้งแรก | ✅ ทำแล้ว | `public/app.js:87` `requestNotifyPermission(false)` เรียกใน `bootstrap` | + ปุ่มขอเองถ้าพลาด · ปุ่มบอกสถานะปัจจุบัน (เปิด/ปิด/ไม่รองรับ) |
| 4.13 เขียนลง alert log + timestamp | ✅ ทำแล้ว | `src/alerts.js:88` → `data/alerts-history.json` | เก็บ 2000 รายการล่าสุด · `GET /api/alerts` อ่านได้ |
| 4.14 **กันเตือนซ้ำ** | ✅ ทำแล้ว | `src/alerts.js:66` (เช็ค `triggeredAt`) · เก็บใน `data/alerts.json` | **ทดสอบพิสูจน์แล้ว**: สแกนซ้ำ 2 รอบ → `alertJustTriggered=false` · event ยิงแค่ 1 ครั้ง |
| 4.15 ปุ่ม reset alert รายตัว | ✅ ทำแล้ว | `src/alerts.js:119` · `server.js:180` · ปุ่ม `public/app.js` `renderWatchlist()` | **ทดสอบแล้ว**: reset → สแกน → เตือนใหม่ได้ (`alertJustTriggered=true`) · มีปุ่มรีเซ็ตทั้งหมดด้วย |

**บั๊กที่เจอตอนทดสอบและแก้แล้ว:** เป้า auto ตกไปอยู่ **ใต้** ราคาปัจจุบันเมื่อแนวต้านอยู่ใกล้กว่า 0.1% → แจ้งเตือนทันทีทุกรอบแบบไร้ความหมาย · แก้โดยเพิ่ม `minDistancePct` (`src/levels.js:124,127`) และ guard `auto-invalid` (`src/levels.js:243`)

---

## ข้อ 5 — แก้ปัญหาการดึงข้อมูล

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 5.0 ข้อความ error ที่ให้มา | ⚠️ ทำบางส่วน | — | **โค้ดบล็อกในโจทย์ส่งมาว่างเปล่า** ไม่มีข้อความ error · ผมเดาจากโค้ดเดิมว่าเป็น 429 + `invalid json response body` + Yahoo ตอบ HTML แทน JSON แล้วดักทั้ง 3 แบบไว้ (`src/providers/_shared.js:120,179`) · **ถ้าเจอ error อื่นรบกวนวางมาให้ดู** |
| 5.1 อัปเกรด yahoo-finance2 → v3 | ✅ ทำแล้ว | `src/providers/yahoo.js:14` (ใหม่) · `datafeed.js:11` (ของเดิม) | v2.14.2 → **3.15.4** · breaking change ที่แก้: default export เป็น class ต้อง `new` + `suppressNotices` ย้ายไปเป็น constructor option · ทดสอบ import แล้วเมธอดครบ |
| 5.2 retry + exponential backoff | ✅ ทำแล้ว | `src/providers/_shared.js:135` `withBackoff()` | 2s → 6s → 18s **+ jitter ±25%** (`:148`) · jitter สำคัญเพราะถ้าหลายตัวโดน 429 พร้อมกันแล้ว retry พร้อมกันอีกก็โดนซ้ำทั้งชุด |
| 5.3 cache ระยะสั้นกัน rate limit | ✅ ทำแล้ว | `src/providers/index.js:59` `TTL` | ราคา 20s · แท่งเทียน 45s · แท่งรายวัน 12ชม. · ข่าว 6ชม. · งบ 6ชม. · screener 2นาที · **+ กันยิงซ้ำ** (`inflight` :70) คำขอเดียวกันที่วิ่งพร้อมกันรอผลตัวแรก |
| 5.4 "ข้อมูลไม่อัปเดต" ใน UI ชัดๆ | ✅ ทำแล้ว | แบนเนอร์ `public/index.html:44` · แถวแดง `:35` · `src/scanner.js:_errorRow()` | 3 ชั้น: แบนเนอร์แดงบนสุดบอกว่าตัวไหน + แถวไฮไลต์แดง + กางแถวเห็นเหตุผลจริงจาก provider · **ไม่เงียบ** |
| 5.5 ใช้แหล่งข้อมูลฟรีเท่านั้น | ✅ ทำแล้ว | `src/providers/*.js` ทั้งหมด | ทั้ง 6 เจ้าเป็น free tier · ไม่มีที่ต้องผูกบัตร · ไม่มีการเรียก endpoint ที่ต้องเสียเงิน |

---

## ข้อ 5.5 — เพิ่มแหล่งข้อมูลหลายชั้น

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 5.5.0 adapter pattern แต่ละ provider เป็นไฟล์แยก | ✅ ทำแล้ว | `src/providers/` 9 ไฟล์ | interface เดียวกันทุกตัว · **smoke test ตรวจ interface ให้** (ข้อ 6 ของ test) |
| 5.5.0b fallback อัตโนมัติเมื่อตัวหนึ่งล่ม | ✅ ทำแล้ว | `src/providers/index.js:97` `callChain()` | **fallback แยกตามชนิดข้อมูล ไม่ใช่ตาม provider** — ดูหมายเหตุใต้ตาราง |
| **5.5.1a** Finnhub — ราคา realtime หลัก | ✅ ทำแล้ว | `src/providers/finnhub.js:52` `quote()` | `/quote` · rate limit 60/นาที (`:12` token bucket) |
| **5.5.1b** Finnhub — earnings calendar | ✅ ทำแล้ว | `src/providers/finnhub.js:78` `earnings()` | ดูล่วงหน้า 14 วัน |
| **5.5.1c** "หุ้นที่จะประกาศงบใน 1-3 วัน = ผันผวนสูง" | ✅ ทำแล้ว | `src/scanner.js:519` | ติดป้ายเตือนเมื่อ `daysUntil ≤ 3` · **ไม่คัดออก** (ต่างจากโค้ดเดิมที่คัดออก) เพราะผันผวนสูงเป็นได้ทั้งโอกาสและกับดัก |
| **5.5.1d** Finnhub — company news | ✅ ทำแล้ว | `src/providers/finnhub.js:105` `news()` | ประมาณ sentiment จากคำในหัวข้อ + **ติดธง `estimated:true`** ให้ UI บอกว่าเป็นการประมาณ ไม่ใช่ค่าจริง |
| **5.5.1e** Finnhub — **WebSocket** | ❌ **ยังไม่ทำ** | — | **ไม่ได้ทำ** ระบบใช้ REST polling `/quote` ตามรอบสแกนแทน · เหตุผล: (1) ทดสอบ WebSocket จริงไม่ได้เลยจาก sandbox ที่บล็อก `finnhub.io` — ส่งโค้ดที่ไม่เคยรันได้ให้ไม่ดี (2) WebSocket ให้ข้อมูล tick-by-tick ซึ่งต้องมี aggregation layer และ reconnect/heartbeat ต่างหาก เป็นงานอีกก้อน (3) polling ตามรอบเพียงพอกับ interval 60 วินาที **ผลกระทบ:** ไม่มี bid/ask จาก Finnhub → ปัจจัย spread คำนวณไม่ได้เมื่อใช้ Finnhub เป็นแหล่งราคา (UI แสดง `—` และบอกเหตุผล) |
| **5.5.2a** Alpha Vantage — `NEWS_SENTIMENT` | ✅ ทำแล้ว | `src/providers/alphavantage.js:39` `news()` | ใช้ `ticker_sentiment` ของหุ้นตัวนั้น (แม่นกว่า `overall_sentiment` ของบทความ) · ถ่วงน้ำหนักด้วย relevance × ความใหม่ (ครึ่งชีวิต 24 ชม.) |
| **5.5.2b** ประหยัดโควตา (25/วัน) | ✅ ทำแล้ว | `src/scanner.js:_enrichTopCandidates()` · cache `src/providers/index.js:64` | โควตาจริง **25/วัน** (ไม่ใช่ 500 แล้ว) · เรียกเฉพาะ top N (default 3) + cache 6 ชม. + หยุดยิงเมื่อโควตาหมด (`alphavantage.js:44`) |
| **5.5.2c** เรียกเฉพาะหุ้นที่ผ่านเกณฑ์ชั้นแรก | ✅ ทำแล้ว | `src/scanner.js` `_enrichTopCandidates()` filter `r.passed && !r.dataError` | ตรงตามสเปก |
| **5.5.3** Twelve Data — fallback ราคา + ข้อมูลย้อนหลัง | ✅ ทำแล้ว | `src/providers/twelvedata.js:48` `quote()` · `:64` `bars()` | 8/นาที + 800/วัน · ข้าม provider เองเมื่อโควตาหมด (`:32`) |
| **5.5.4** Marketaux — ข่าว + sentiment | ✅ ทำแล้ว | `src/providers/marketaux.js:38` `news()` | ใช้ `sentiment_score` + `match_score` ต่อ entity |
| **5.5.5** FMP — float, short interest | ⚠️ ทำบางส่วน | `src/providers/fmp.js:63` `fundamentals()` · ใช้ที่ `src/scanner.js` `_enrichTopCandidates()` · แสดงที่ `public/app.js` detail panel | **เขียนครบและต่อเข้าระบบแล้ว** แต่: (1) ยังไม่ยืนยันว่า free tier ให้จริง (สเปกเองก็เขียนว่า "ถ้า free tier ยังให้") — โค้ดออกแบบให้เจอ 403 แล้วจำไว้ ไม่เรียกซ้ำ ไม่เผาโควตา (`fmp.js:26,44`) (2) **ไม่เอาไปบวกคะแนน** โดยเจตนา — ถ้าบวก หุ้นที่ไม่มีข้อมูลจะเสียเปรียบโดยไม่มีเหตุผล จึงแสดงเป็น "ข้อควรระวัง" แทน (float < 50M, short > 15%) |
| 5.5.6 เก็บ key ทั้งหมดใน .env | ✅ ทำแล้ว | `.env` / `.env.example` | 5 key + คำอธิบาย + ลิงก์ขอ key |
| 5.5.7 หน้า Settings กรอก key ผ่าน UI | ✅ ทำแล้ว | `public/settings.html` หัวข้อ 🔑 API Keys · `server.js:205` | **ไม่ต้องแก้ไฟล์เอง** · key ที่บันทึกแล้วแสดงเป็น `••••1234` ไม่ส่งค่าเต็มกลับ (`src/settings.js:153` `publicView`) |
| 5.5.8 ไม่ใส่ key → ข้าม ไม่ crash | ✅ ทำแล้ว | `src/providers/index.js:115` (`isConfigured()` → `skipped`) | **ทดสอบแล้ว**: ไม่มี key เลย 5 ตัว ระบบยังทำงานด้วย Yahoo ได้ปกติ |
| 5.5.9 แสดงสถานะ + โควตาคงเหลือใน UI | ✅ ทำแล้ว | `src/providers/index.js:294` `getProviderStatus()` · `public/index.html:215` · `public/app.js` `renderProviders()` | 4 สถานะ: ok / degraded / exhausted / disabled · โควตารายนาที + รายวัน + เหลืออีกเท่าไหร่ · ลิงก์ขอ key ถ้ายังไม่ใส่ |

### ⚠️ หมายเหตุสำคัญ — ทำไม fallback แยกตามชนิดข้อมูล

สเปกเขียนว่า Finnhub เป็น **"แหล่งราคา realtime หลัก (แทน Yahoo ที่ fetch failed บ่อย)"**
แต่ตรวจสอบแล้วพบว่า **Finnhub free tier ไม่ให้แท่งเทียน** — endpoint `/stock/candle` ย้ายไป premium
free key จะได้ HTTP 403 `You don't have access to this resource`
([ยืนยันจาก Finnhub-API issue #546](https://github.com/finnhubio/Finnhub-API/issues/546))

**Finnhub จึงแทน Yahoo ได้แค่บางส่วน** ถ้าเรียงลำดับ provider แบบเดียวรวบทุกอย่าง ระบบจะพังทันทีที่ขอแท่งเทียน
จึงต้องแยก fallback chain ตามชนิดข้อมูล (`src/providers/index.js:30-43`):

| ชนิดข้อมูล | ลำดับ |
|---|---|
| ราคาปัจจุบัน | Finnhub → Twelve Data → Yahoo |
| **แท่งเทียน** | **Yahoo → Twelve Data** (Finnhub ใช้ไม่ได้) |
| ปฏิทินงบ | Finnhub → Yahoo |
| ข่าว/sentiment | Alpha Vantage → Marketaux → Finnhub (เปลี่ยนลำดับได้ใน Settings) |
| float/short | FMP |
| screener | Yahoo |

**smoke test ตรวจข้อนี้ให้:** `bars ไม่ใช้ Finnhub (free tier ไม่ให้แท่งเทียน)` ✅

---

## ข้อ 6 — ระบบให้คะแนน (Opportunity Score)

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 6.0 สร้าง src/scoring.js คะแนน 0-100 | ✅ ทำแล้ว | `src/scoring.js:410` `computeScore()` | clamp 0-100 |
| 6.1 ปัจจัย RVOL 25% | ✅ ทำแล้ว | `src/scoring.js:37` `scoreRvol()` | เส้นโค้ง: 1.0→0 · 1.5→40 · 2.0→65 · 3.0→85 · ≥5→100 |
| 6.2 ปัจจัย ATR%/Volatility 20% | ✅ ทำแล้ว | `src/scoring.js:66` `scoreVolatility()` | **⚠️ ทำเป็นระฆัง ไม่ใช่ยิ่งมากยิ่งดี** — ดูหมายเหตุใต้ตาราง |
| 6.3 ปัจจัย ระยะห่างจากแนวต้าน 15% | ✅ ทำแล้ว | `src/scoring.js:93` `scoreResistance()` | **⚠️ peak 0.3-1.5 ATR ไม่ใช่ยิ่งใกล้ยิ่งดี** · + โบนัสตามจำนวนครั้งที่ชน · แนวต้านไม่ยืนยันได้ 50 กลางๆ |
| 6.4 ปัจจัย Momentum 15% | ✅ ทำแล้ว | `src/scoring.js:137` `scoreMomentum()` | 3 องค์ประกอบ: %chg (60%) + EMA5 vs EMA15 (25%) + ความชัน EMA5 (15%) |
| 6.5 ปัจจัย News Sentiment 15% | ✅ ทำแล้ว | `src/scoring.js:186` `scoreSentiment()` | **ไม่มีข้อมูล = 50 + ติดป้ายว่าไม่มีข้อมูล** ห้ามให้ดูเหมือนข่าวดี |
| 6.6 ปัจจัย Spread/Liquidity 10% | ✅ ทำแล้ว | `src/scoring.js:222` `scoreLiquidity()` | spread (70%) + มูลค่าซื้อขาย 5 นาที (30%) |
| 6.7 ปรับน้ำหนักได้ในหน้า Settings | ✅ ทำแล้ว | `public/settings.html` หัวข้อ 🧮 · `src/settings.js:validate()` | slider 6 ตัว + แสดงผลรวมสด + บังคับ normalize ให้รวม 100 · **ทดสอบแล้ว**: ส่ง 50×6 → ปรับเป็นรวม 100 |
| 6.8 แสดงคะแนนในตาราง เรียงมากไปน้อย | ✅ ทำแล้ว | `src/scanner.js:239,242` `rows.sort()` · `public/index.html:186` | |
| 6.9 **กดดู breakdown ได้ ห้ามเป็น black box** | ✅ ทำแล้ว | `public/app.js` `detailRow()` · ข้อมูลจาก `src/scoring.js:474` `breakdown` | ทุกปัจจัยแสดง: **ค่าดิบ → คะแนน 0-100 → น้ำหนัก → คะแนนที่ได้ → แถบกราฟ → ประโยคอธิบาย "ทำไม"** · **ทดสอบแล้ว**: `breakdown=6 ปัจจัย` |
| 6.10 คำนวณ Expected Move % จาก ATR | ✅ ทำแล้ว | `src/scoring.js:263` `expectedMove()` | ใช้ ATR(14) จากแท่ง **daily** ตรงๆ (cache 12ชม.) ถ้าไม่มีจึงประมาณจาก intraday × √(แท่งต่อวัน) · บอกวิธีที่ใช้ทุกครั้ง |
| 6.11 คำนวณ R:R จาก entry/stop/target | ✅ ทำแล้ว | `src/scoring.js:312` `riskReward()` | entry=ราคาปัจจุบัน · stop จาก ATR + structure · target=แนวต้าน+ส่วนขยาย |
| 6.12 แสดงเป็นอัตราส่วน เช่น 1:2.5 | ✅ ทำแล้ว | `src/scoring.js:363` `label` | แสดง 2 แบบ: เป้าเลยแนวต้าน (หลัก) + ออกที่แนวต้านพอดี (อนุรักษ์นิยม) |
| 6.13 **กรอง R:R < 1:1.5 ออก** | ✅ ทำแล้ว | `src/scanner.js:_checkQuality()` เงื่อนไข `rr.rr < st.minRR` | ค่า `minRR` default 1.5 ปรับได้ใน Settings · **ทดสอบเห็นผลจริง**: AMD ถูกกรองด้วย `R:R ต่ำกว่าเกณฑ์ (1:0.86 < 1:1.5)` |
| 6.14 คำนวณ Position Size | ✅ ทำแล้ว | `src/scoring.js:379` `positionSize()` | `(ทุน × %เสี่ยง ÷ risk/หุ้น) × ตัวคูณภาวะตลาด` · ใช้ค่าจาก config เดิม |
| 6.15 ห้ามข้อความรับประกันกำไร | ✅ ทำแล้ว | ตรวจทั้งโปรเจกต์ด้วยสคริปต์ | สแกนคำต้องห้าม 10 คำในทุกไฟล์ → พบ 3 จุดที่เป็น false positive ทั้งหมด (2 จุดคือกฎในคอมเมนต์เอง, 1 จุดคือ "ต้องขึ้นเลขเวอร์ชัน" ใน README) |
| 6.16 ใช้คำกลางๆ | ✅ ทำแล้ว | ทั่วโปรเจกต์ | "โอกาสเคลื่อนไหว" 6 ครั้ง · "จากค่าสถิติ" 8 ครั้ง · "ไม่ใช่การพยากรณ์" 3 ครั้ง |
| 6.17 disclaimer ท้ายหน้าเว็บ | ✅ ทำแล้ว | `public/index.html:219` · `public/settings.html` footer · `public/backtest.html` footer | **ครบทั้ง 3 หน้า** |
| 6.18 ทุกสัญญาณบอก "ทำไม" | ✅ ทำแล้ว | `src/scoring.js` ทุก factor คืน `why` · `:481` `topReasons` | ทุกปัจจัยมีประโยคอธิบายเป็นภาษาไทย · ส่งไป LINE ด้วย (`src/notify-line.js:53`) |

### ⚠️ 3 จุดที่ตั้งใจทำต่างจากตารางในโจทย์ (พร้อมเหตุผล)

**1. ATR% เป็นระฆัง ไม่ใช่ยิ่งมากยิ่งดี** (`src/scoring.js:61-65`)
หุ้นนิ่งเกินไป scalp ไม่คุ้มค่าธรรมเนียม แต่หุ้นเหวี่ยงเกินไปก็คุมความเสี่ยงไม่ได้
(stop กว้าง ขนาดไม้เล็กจนไม่คุ้ม และโดน stop จากสัญญาณรบกวนตลอด) → ช่วงคะแนนเต็ม 1.5-3%/วัน ปรับได้

**2. ปัจจัยนี้ใช้ ATR% "เทียบเท่ารายวัน" ไม่ใช่ของแท่ง 5 นาที** (`src/scoring.js:55-59`)
**นี่คือบั๊กที่เจอตอนทดสอบ**: ATR ของแท่ง 5 นาทีอยู่ราว 0.1-0.5% แต่ช่วงที่เหมาะของรายวันคือ 1.5-3%
เอามาเทียบกันตรงๆ หุ้นทุกตัวได้ **0 คะแนน** หมด ทั้งที่ความผันผวนปกติดี → แก้ให้ส่งค่า Expected Move เข้าไปแทน

**3. ระยะห่างจากแนวต้าน peak 0.3-1.5 ATR ไม่ใช่ "ยิ่งใกล้ยิ่งดี"** (`src/scoring.js:89-92`)
ชิดเกินไป (<0.15 ATR) = เป้ากับราคาแทบเท่ากัน R:R หายไปแล้ว

### ⚠️ ความขัดแย้งในสเปกที่ต้องแก้ (สำคัญที่สุดของงานนี้)

สเปกขอ 2 อย่างที่**ขัดกันเองถ้าใช้สูตร stop เดิม**:
- (ก) ปัจจัย "ระยะห่างจากแนวต้าน" ให้คะแนนสูงสุดเมื่อ "ใกล้เบรกเอาท์"
- (ข) กรองสัญญาณที่ R:R < 1:1.5 ออก

สูตรเดิม `stop = min(ราคา − 1.5×ATR, swingLow − 0.15×ATR)` — `min` เลือกราคาต่ำกว่า = stop **กว้างกว่า**
(ปลอดภัยจากสัญญาณรบกวน แต่เสีย R:R) ซึ่งเป็นการตั้งค่าแบบ **day trade**

ผลคือระยะ stop ≈ 1.5 ATR แต่ระยะถึงเป้า ≈ 0.5 ATR → **R:R ≈ 0.33 เสมอ**
จะได้ R:R ถึง 1.5 ต้องให้แนวต้านห่าง ≥ 2.25 ATR ซึ่งเป็นช่วงที่ปัจจัย (ก) ให้คะแนนต่ำ
→ **หุ้นที่คะแนนดีตกตัวกรอง R:R ทุกตัว ไม่มีสัญญาณออกมาเลย** (เห็นด้วยตาตอนทดสอบ: 0/8 ผ่าน)

**แก้ 2 จุด** (`src/scoring.js:312-377`, เหตุผลเต็มอยู่ในคอมเมนต์):
1. stop ใช้ `Math.max` เลือกตัวที่**แคบกว่า** + มีพื้นขั้นต่ำ `minStopAtr` (0.35×ATR) กันโดนสัญญาณรบกวนเคาะออก
2. เป้าของ R:R ขยายเลยแนวต้านไป `targetExtAtr` (0.5×ATR) เพราะการเล่นจริงคือ "เข้าก่อนแนวต้าน → แนวต้านแตก → ราคาวิ่งต่อ" ถ้าตั้งเป้าที่แนวต้านพอดีก็คือไม่ได้กำไรจากการเบรกเลย
3. `ATR_STOP_MULT` default เปลี่ยน **1.5 → 1.0**

**ผลหลังแก้:** 7/8 ผ่านด่าน มีสัญญาณออก และ AMD ยังถูกกรองด้วย R:R 0.86 อย่างถูกต้อง
**ทุกค่าปรับได้ในหน้า Settings** ถ้าคุณอยากกลับไปใช้ stop กว้างแบบเดิม

---

## ข้อ 7 — Backtest

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 7.1 เพิ่มหน้า /backtest | ✅ ทำแล้ว | `public/backtest.html` · route `server.js` · API `server.js:243` | |
| 7.2 win rate | ✅ ทำแล้ว | `src/backtest.js:143` `stats()` | คิดจากไม้ที่ตัดสินผลได้แล้วเท่านั้น (ไม่รวม UNDECIDED) |
| 7.3 avg gain/loss | ✅ ทำแล้ว | `src/backtest.js:158-159` | แยกกำไรเฉลี่ยเมื่อชนะ และขาดทุนเฉลี่ยเมื่อแพ้ |
| 7.4 max drawdown | ✅ ทำแล้ว | `src/backtest.js:106` `computeMaxDrawdown()` | peak-to-trough ของ equity curve แบบ R + คืน curve ไปวาดกราฟ SVG |
| 7.5 เก็บ log สัญญาณลง data/signals-history.json | ✅ ทำแล้ว | `src/scanner.js:274` `appendToArray(SIGNALS_FILE, ...)` · `toSignalRecord()` | เก็บ 10,000 รายการล่าสุด · **บันทึก breakdown คะแนนทุกปัจจัยด้วย** เพื่อวิเคราะห์ย้อนหลังได้ว่าปัจจัยไหนได้ผลจริง |
| 7.6 "ให้รู้ว่าเกณฑ์ใช้ได้จริงไหมก่อนเอาเงินจริงลง" | ✅ ทำแล้ว | `src/backtest.js:225` แยกตามช่วงคะแนน · `:236` แยกตามปัจจัย | **ตอบคำถามที่สำคัญที่สุด**: คะแนนสูงได้ผลดีจริงไหม (ถ้า expectancy ไม่เพิ่มตามคะแนน = ระบบให้คะแนนยังไม่มีประโยชน์) และปัจจัยไหนช่วยแยกไม้ดีออกจากไม้แย่ |

**เกินจากที่ขอ:** expectancy, profit factor, equity curve (SVG ไม่ต้องโหลด library), แยกตามวิธีหาแนวต้าน, คำแนะนำอัตโนมัติ, **ระบุข้อจำกัด 5 ข้อของ backtest เอง** (`src/backtest.js:347`) เช่น แท่งเดียวแตะทั้ง stop และเป้า = นับเป็นแพ้, ไม่คิดค่าคอมและ slippage

---

## ข้อ 8 — หน้า Settings

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 8.1 เลือก session regular/pre/post/all | ✅ ทำแล้ว | `src/market-hours.js:12-17` `SESSIONS` · `public/settings.html:47` | **โค้ดเดิมรู้จักแค่ regular/extended/always** — เขียน `market-hours.js` ใหม่รองรับครบ 4 แบบ · pre 04:00-09:30 ET · post 16:00-20:00 ET · **ทดสอบแล้ว**: `มี session ให้เลือกครบ 4 แบบ` |
| 8.2 ปรับ timeframe (5m, 15m) | ✅ ทำแล้ว | `public/settings.html:57` | เลือกได้หลายอัน (5 ตัวเลือก: 1m/5m/15m/30m/1h) |
| 8.3 ปรับ scan interval | ✅ ทำแล้ว | `public/settings.html:68` | 10-3600 วินาที · มีผลทันทีรอบถัดไป |
| 8.4 ปรับเงินทุน + %ความเสี่ยง | ✅ ทำแล้ว | `public/settings.html:79,83` | **ทดสอบแล้ว**: `accountSize=25000` บันทึกได้ |
| 8.5 ปรับน้ำหนักคะแนนแต่ละปัจจัย | ✅ ทำแล้ว | `public/settings.html` หัวข้อ 🧮 | slider 6 ตัว + ปุ่มคืนค่าเริ่มต้น + ปุ่มปรับให้รวม 100% |
| 8.6 กรอก API keys | ✅ ทำแล้ว | `public/settings.html` หัวข้อ 🔑 | 5 เจ้า + คำอธิบายโควตา + ลิงก์ขอ key · mask เป็น `••••1234` |
| 8.7 บันทึกลง data/settings.json | ✅ ทำแล้ว | `src/settings.js:173` `writeJson()` | มีผลทันทีไม่ต้องรีสตาร์ท (emit `change` → provider โหลด key ใหม่ที่ `src/providers/index.js:55`) |

**เกินจากที่ขอ:** validate ค่าที่ผิดแล้วปรับให้อยู่ในช่วงที่ใช้ได้ + คืนคำเตือน (`src/settings.js:validate()`) · **ทดสอบแล้ว**: ส่ง `scanIntervalSec:1, riskPct:999` → ปรับเป็น 10 + คำเตือน 2 ข้อ

---

## ข้อ 9 — ข้อกำหนดทางเทคนิค

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 9.1 ไฟล์ทั้งหมดเป็น UTF-8 | ✅ ทำแล้ว | ทุกไฟล์ | ตรวจด้วยสคริปต์: ทุกไฟล์ `.js/.html/.md/.json/.bat/.env*` decode เป็น UTF-8 ได้ · **ไม่มีไฟล์ไหนมี BOM** (BOM ทำให้ `.bat` และ node พัง) |
| 9.1b start.bat เดิมพังเพราะ encoding | ✅ ทำแล้ว | `run.bat:2` · `start.bat:2` `chcp 65001 >nul` | **หาสาเหตุได้แล้ว**: ไฟล์เดิมเป็น UTF-8 อยู่แล้ว แต่ **ขาด `chcp 65001`** → cmd อ่านด้วย codepage 874/437 ตามค่าเริ่มต้น ภาษาไทยจึงเป็นตัวขยะ · แก้ทั้ง 2 ไฟล์ + ใช้ CRLF |
| 9.2 คอมเมนต์ภาษาไทยอธิบายส่วนสำคัญ | ✅ ทำแล้ว | ทุกไฟล์ใหม่ | **730 บรรทัด** จาก 6,161 บรรทัด (~12%) · ไฟล์ที่ตรรกะซับซ้อนสุดมีมากสุด: `scoring.js` 100 · `scanner.js` 85 · `levels.js` 67 |
| 9.3 error handling ครบ อย่าให้ server crash | ✅ ทำแล้ว | หลายชั้น (ดูใต้ตาราง) | **ทดสอบแล้ว 3 กรณี**: API ไม่มี → 404 · body ไม่ใช่ JSON → 400 · server ยังทำงานต่อได้ |
| 9.4 อัปเดต package.json ให้มี npm start | ✅ ทำแล้ว | `package.json` | `start` → `node server.js` · + `demo` `cli` `backtest` `test` |

### ชั้นการป้องกัน error (9.3)

| ชั้น | ที่ไหน | ป้องกันอะไร |
|---|---|---|
| หุ้นตัวเดียวพัง | `src/scanner.js` try/catch ต่อ symbol ในลูป | หุ้นตัวเดียวดึงข้อมูลไม่ได้ ไม่ทำให้ทั้งรอบพัง (ตรงตามสเปก) |
| ดึงข้อมูลไม่ได้เลย | `src/scanner.js` `_errorRow()` | คืนแถวที่บอกว่า "ข้อมูลไม่อัปเดต" แทนการหายเงียบ |
| รอบสแกนพัง | `src/scanner.js:134` try/catch ใน `_loop()` | ทำงานต่อรอบถัดไป |
| REST API พัง | `server.js:46` `wrap()` | ทุก route ครอบ try/catch → 500 + ข้อความ ไม่ crash |
| body ไม่ใช่ JSON | `server.js` error middleware | 400 + ข้อความไทย ไม่พิมพ์ stack trace |
| Promise ไม่ได้ดัก | `server.js` `unhandledRejection` | log ไว้ ไม่ crash |
| Exception ไม่ได้ดัก | `server.js` `uncaughtException` | log ไว้ **ไม่ exit** |
| ไฟล์ JSON เสีย | `src/store.js:44` | ย้ายเป็น `.corrupt-<ts>` เก็บไว้ แล้วเริ่มจากค่าเริ่มต้น |
| เขียนไฟล์กลางคัน | `src/store.js:79` `.tmp` + `rename` | atomic — ไฟล์ไม่เสีย |
| ปิดโปรแกรม | `server.js` `shutdown()` | หยุด scanner + `flushAll()` รอเขียนไฟล์เสร็จ + timeout 5 วิ |

---

## ข้อ 10 — ส่งมอบ

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 10.1 เขียนไฟล์ให้ครบทุกไฟล์ | ✅ ทำแล้ว | 26 ไฟล์ใหม่ + แก้ 3 ไฟล์เดิม | รวม 6,161 บรรทัดโค้ดใหม่ |
| 10.2 บอกว่าต้อง npm install อะไรเพิ่ม | ✅ ทำแล้ว | `README.md` §2.2 · `package.json` | `express` `socket.io` + อัปเกรด `yahoo-finance2@^3.15.4` · ไม่เพิ่ม dep อื่น ไม่มี build step |
| 10.3 README.md ภาษาไทย step-by-step | ✅ ทำแล้ว | `README.md` 558 บรรทัด | 11 หัวข้อ + สารบัญ · ติดตั้ง Node.js → npm install → คำสั่ง → ขอ API key ทั้ง 5 เจ้า → ตารางแก้ปัญหา 18 อาการ |
| 10.4 รันทดสอบว่าเปิด localhost:3000 ได้จริง | ✅ ทำแล้ว | `test/smoke-test.js` | **ทดสอบจริงแล้ว** — เปิด server, ยิง API, ตรวจ 4 หน้าเว็บโหลดได้ |
| 10.5 ทดสอบว่าปุ่ม Start/Stop ทำงานถูกต้อง | ✅ ทำแล้ว | `test/smoke-test.js` | **ทดสอบจริงแล้ว** รวมการพิสูจน์ว่าไม่มี timer ค้าง (รอ 12 วินาทีจริง) |

---

## ข้อ 11 — Self-Audit + Smoke Test

| ข้อ | สถานะ | ไฟล์/บรรทัดที่ทำ | หมายเหตุ |
|---|---|---|---|
| 11.1 สร้าง CHECKLIST.md ไล่เช็คทุกข้อ | ✅ ทำแล้ว | `CHECKLIST.md` (ไฟล์นี้) | |
| 11.2 test/smoke-test.js รันด้วย npm test | ✅ ทำแล้ว | `test/smoke-test.js` · `package.json` | รันในโหมด `MOCK_DATA=true` → ไม่ต้องต่อเน็ต ไม่ต้องมี key ผลเหมือนกันทุกครั้ง · **สำรอง/คืนไฟล์ `data/` ให้** ไม่ทำลาย watchlist จริง |
| 11.3 เช็ค: server เปิด port 3000 ได้ | ✅ ทำแล้ว | `smoke-test.js` หัวข้อ 1 | 2 ข้อทดสอบ |
| 11.4 เช็ค: GET /api/status ตอบ 200 | ✅ ทำแล้ว | `smoke-test.js` หัวข้อ 2 | 5 ข้อ (รวม `/api/state` ที่เป็นชื่อพ้อง) |
| 11.5 เช็ค: start แล้ว running จริง | ✅ ทำแล้ว | `smoke-test.js` หัวข้อ 3 | 8 ข้อ (รวมตรวจว่าแถวมีคะแนน/breakdown/แนวต้าน/R:R/ขนาดไม้ครบ) |
| 11.6 เช็ค: stop แล้วหยุดจริง ไม่มี interval ค้าง | ✅ ทำแล้ว | `smoke-test.js` หัวข้อ 4 | **พิสูจน์ด้วยการรอ 12 วินาทีจริง** แล้วเทียบ `scanCount` |
| 11.7 เช็ค: เพิ่ม ticker แล้วอ่านกลับจาก watchlist.json | ✅ ทำแล้ว | `smoke-test.js` หัวข้อ 5 | **อ่านไฟล์จากดิสก์จริง** ด้วย `fsp.readFile` ไม่ใช่ผ่าน API |
| 11.8 เช็ค: ทุก provider file มี export ครบตาม interface | ✅ ทำแล้ว | `smoke-test.js` หัวข้อ 6 | ตรวจ 8 provider: field ที่ต้องมี + เมธอดที่ต้องมี + **ประกาศ capability ไหนต้องมีเมธอดนั้นจริง** (กันประกาศเกิน) + `getQuota()` คืนโครงสร้างถูก |
| 11.9 พิมพ์ผลเป็น ✅/❌ รายข้อ | ✅ ทำแล้ว | `smoke-test.js` `check()` | + สรุปท้าย + รายการข้อที่ไม่ผ่าน + exit code 1 ถ้ามีข้อไม่ผ่าน |

**ผลรัน `npm test` ครั้งสุดท้าย: ✅ ผ่าน 79 · ❌ ไม่ผ่าน 0 · รวม 79 ข้อ (100.0%)**

---

## สรุปคะแนน

| หมวด | ทำแล้ว | ทำบางส่วน | ยังไม่ทำ | รวม |
|---|---|---|---|---|
| ข้อ 0 | 4 | 0 | 0 | 4 |
| ข้อ 1 | 21 | 0 | 0 | 21 |
| ข้อ 2 | 11 | 0 | 0 | 11 |
| ข้อ 3 | 8 | 0 | 0 | 8 |
| ข้อ 4 | 15 | 0 | 0 | 15 |
| ข้อ 5 | 5 | 1 | 0 | 6 |
| ข้อ 5.5 | 12 | 1 | 1 | 14 |
| ข้อ 6 | 19 | 0 | 0 | 19 |
| ข้อ 7 | 6 | 0 | 0 | 6 |
| ข้อ 8 | 7 | 0 | 0 | 7 |
| ข้อ 9 | 5 | 0 | 0 | 5 |
| ข้อ 10 | 5 | 0 | 0 | 5 |
| ข้อ 11 | 9 | 0 | 0 | 9 |
| **รวม** | **127** | **2** | **1** | **130** |

### **เสร็จ 127/130 ข้อ = 97.7%**
(ถ้านับ "ทำบางส่วน" เป็นครึ่งข้อ → 128/130 = **98.5%**)

---

## รายการที่ยังไม่เสร็จ — เหตุผลตรงๆ

### ❌ 5.5.1e — Finnhub WebSocket (ยังไม่ทำ)

สเปกข้อ 5.5 เขียนว่า "Finnhub — free 60 calls/min **+ WebSocket**" ผมทำแต่ REST polling

**เหตุผล:**
1. **ทดสอบไม่ได้เลย** — sandbox ที่ผมรันบล็อก `finnhub.io` ที่ระดับ network egress policy การส่งโค้ด WebSocket ที่ไม่เคยรันได้แม้ครั้งเดียวมาให้ ผมคิดว่าแย่กว่าการบอกตรงๆ ว่าไม่ได้ทำ
2. **เป็นงานอีกก้อน** — WebSocket ให้ tick-by-tick ต้องมี aggregation layer, reconnect/backoff, heartbeat, และ state ที่ sync กับรอบสแกน
3. **REST เพียงพอกับ interval 60 วินาที** — WebSocket จะได้ประโยชน์ชัดเมื่อสแกนถี่กว่า 5 วินาที

**ผลกระทบที่มีจริง:** `/quote` ฟรีของ Finnhub ไม่ให้ bid/ask → ปัจจัย spread คำนวณไม่ได้เมื่อใช้ Finnhub เป็นแหล่งราคา
UI แสดง `—` และบอกเหตุผลว่า "provider ฟรีบางเจ้าไม่ให้ bid/ask" · Yahoo ให้ bid/ask จึงยังคำนวณได้เมื่อ fallback ไป Yahoo

**ถ้าจะทำต่อ:** `wss://ws.finnhub.io?token=KEY` → subscribe symbols → เก็บ last trade ต่อ symbol ใน Map → ให้ `finnhub.quote()` อ่านจาก Map ก่อนแล้วค่อย fallback ไป REST

---

### ⚠️ 5.0 — ข้อความ error ในโจทย์ (ทำบางส่วน)

โจทย์ข้อ 5 เขียนว่า "ตอนนี้เจอ error พวกนี้บ่อยมาก:" แล้วตามด้วย **โค้ดบล็อกที่ว่างเปล่า** ข้อความ error หายไป

ผมเดาจากโค้ดเดิม (`datafeed.js` v2 + `isRateLimitError`) ว่าเป็น:
- HTTP 429 Too Many Requests
- `invalid json response body` (Yahoo ตอบ HTML แทน JSON เวลาโดน rate limit)
- `Unexpected token` จากการ parse HTML เป็น JSON

และดักไว้ทั้ง 3 แบบใน `src/providers/_shared.js:120` (`isTransientError`) + `:179` (แปลง error ให้อ่านรู้เรื่อง)
**ถ้าคุณเจอ error อื่นด้วย รบกวนวางมาให้ดู** — อาจต้องเพิ่ม pattern

---

### ⚠️ 5.5.5 — FMP float / short interest (ทำบางส่วน)

เขียน adapter ครบ (`src/providers/fmp.js`) ต่อเข้า scanner แล้ว แสดงในหน้าเว็บแล้ว แต่:
1. **ยังไม่ยืนยันว่า free tier ให้จริง** — สเปกเองเขียนว่า "ถ้า free tier ยังให้" และผมทดสอบกับ API จริงไม่ได้ · โค้ดออกแบบให้เจอ 403 แล้วจำไว้ ไม่เรียกซ้ำ ไม่เผาโควตา 250/วัน
2. **ไม่เอาไปบวกคะแนน** โดยเจตนา — ถ้าบวก หุ้นที่ไม่มีข้อมูล float จะเสียเปรียบโดยไม่มีเหตุผล จึงแสดงเป็น "ข้อควรระวัง" แทน (float < 50 ล้านหุ้น, short > 15% ของ float)

---

## เรื่องที่ตกลงกันไว้ตอนวางแผน แต่ยังไม่ได้ทำ (ไม่ได้อยู่ในโจทย์ข้อ 1-11)

### ❌ P1 — ตาราง "ไม้ที่เปิดอยู่" + สัญญาณออก 7 แบบ บนหน้าเว็บ

ตอนถาม 4 คำถาม คุณเลือก **"เก็บไว้ + ทำ UI ให้"** สำหรับ `positions.js` / `exitLoop`
**ผมทำแค่ครึ่งเดียว:** เก็บโค้ดเดิมไว้ครบ (ใช้ได้ใน `npm run cli`) แต่ **ยังไม่ได้ทำ UI**

ตรวจแล้วยืนยัน: `positions.js` `checkExits` `exitLoop` `dayStats` ไม่ถูก import จาก `src/` `server.js` หรือ `public/` เลย

**ผลที่ตามมา:** ค่าใน Settings 8 ตัวถูกนิยามไว้แต่ยังไม่มีคนใช้ในหน้าเว็บ —
`trackPositions` `exitPollSec` `maxOpenPositions` `dailyLossLimitR` `maxAlertsPerDay` `timeStopMin` `atrTp1` `atrTp2`
(ทำเครื่องหมายไว้ในคอมเมนต์แล้วที่ `src/settings.js` ว่าใช้เฉพาะโหมด CLI)

**สิ่งที่ขาด:** ตาราง "ไม้ที่เปิดอยู่" · สัญญาณออก STOP/TP1/TP2/BREAKEVEN/EMA5_LOST/VWAP_LOST/TIME_STOP บนเว็บ · ตัวเลขขาดทุนสะสมรายวัน + การหยุดอัตโนมัติเมื่อถึงลิมิต 3R

**เหตุผลที่ไม่ทำ:** ไม่ได้อยู่ในโจทย์ข้อ 1-11 ที่เป็นสเปกหลัก และงานตามสเปกกินเวลาไปพอสมควรแล้ว
ถ้าต้องการ บอกได้ — เป็นงานเพิ่มประมาณ 1 module + 1 ตาราง + 1 loop

### ⚠️ P2 — LINE ใช้ข้อความธรรมดา ไม่ใช่ Flex Message เดิม

คุณเลือก "เก็บ LINE ไว้เป็นช่องเสริม" ผมทำ `src/notify-line.js` ที่ส่งข้อความได้จริงและเปิด/ปิดในหน้า Settings ได้
แต่**เขียนข้อความขึ้นใหม่เป็น text ธรรมดา ไม่ได้เรียก `buildFlex()` จาก `line.js` เดิม**

**เหตุผล:** `line.js` เดิมอ่าน token จาก `CFG` (ซึ่งมาจาก `.env` เท่านั้น) ถ้าเรียกตรงๆ จะไม่รับ token ที่แก้ในหน้า Settings
และโครงสร้าง Flex ผูกกับรูปแบบ signal เดิม (มี tp1/tp2) ซึ่งต่างจากแถวใหม่

`line.js` ยังอยู่ครบและ `npm run cli` ยังส่ง Flex การ์ดสวยเหมือนเดิม
ถ้าอยากให้หน้าเว็บส่ง Flex ด้วย ต้องแก้ `buildFlex()` ให้รับ token เป็นพารามิเตอร์และรับรูปแบบแถวใหม่

---

## บั๊กที่เจอจากการทดสอบตัวเองและแก้แล้ว (ไม่ได้อยู่ในโจทย์)

| # | บั๊ก | ผลถ้าไม่แก้ | แก้ที่ |
|---|---|---|---|
| B1 | ป้อน ATR% ของแท่ง 5 นาที (~0.4%) เข้าเส้นโค้งที่ปรับเทียบสำหรับ ATR รายวัน (1.5-3%) | ปัจจัยความผันผวนได้ **0 คะแนนทุกตัว** ทั้งที่ค่าปกติดี — เสียน้ำหนัก 20% ไปฟรีๆ | `src/scoring.js:55` + `src/scanner.js` ส่ง `dailyAtrPct` |
| B2 | เป้า auto ตกไปอยู่ **ใต้** ราคาปัจจุบัน เมื่อแนวต้านใกล้กว่าระยะ offset | **แจ้งเตือนทันทีทุกรอบแบบไร้ความหมาย** (ปัญหาเดียวกับที่ผมเตือนไว้ตอนวางแผนเรื่อง highest-high) | `src/levels.js:124,127,243` เพิ่ม `minDistancePct` + guard `auto-invalid` |
| B3 | สูตร stop เดิม (`Math.min`, 1.5×ATR) ทำให้ R:R ไม่มีทางถึง 1:1.5 | **ไม่มีสัญญาณออกมาเลย** — เครื่องมือขัดขากันเอง (เห็นจริง 0/8 ผ่าน) | `src/scoring.js:312` เขียน `riskReward()` ใหม่ |
| B4 | ใช้ชื่อ env `MIN_SCORE` กับความหมาย**ใหม่** (ซ่อนแถว) ทั้งที่ `.env` ของคุณมี `MIN_SCORE=70` อยู่แล้วในความหมาย**เดิม** (เกณฑ์สัญญาณ) | **ตารางว่างเปล่าทั้งหมด** ทุกแถวถูกซ่อน — จับได้เพราะ smoke test พัง (`rows=0`) | เปลี่ยนชื่อค่าใหม่เป็น `HIDE_BELOW_SCORE` และให้ `signalScore` อ่าน `MIN_SCORE` เป็นค่าสำรอง (`src/settings.js`) |
| B5 | `st.rvolDays` ถูกเรียกใน scanner แต่ไม่มีนิยามใน `settings.js` | ตกไปใช้ค่า fallback 10 เสมอ — ปรับค่าไม่ได้จริง | `src/settings.js` เพิ่ม `rvolDays` + ช่องใน Settings |
| B6 | `minScore` ถูกนิยามใน settings แต่ไม่มีโค้ดไหนใช้ | ค่าตายที่หลอกว่าปรับได้ | `src/scanner.js` ทำให้กรองแถวจริง (ตอนนี้ชื่อ `hideBelowScore`) |
| B7 | body ที่ไม่ใช่ JSON ทำให้พิมพ์ stack trace ยาวๆ ผ่าน `uncaughtException` | log รุงรัง ดูเหมือนโปรแกรมพัง ทั้งที่เป็นแค่ request ผิดรูปแบบ | `server.js` เพิ่ม Express error middleware |
| B8 | provider ขึ้น "degraded" หลังเจอ error ครั้งเดียว แม้จะเรียกสำเร็จต่อมาแล้ว | สถานะหลอก — ตรวจ ticker ที่ไม่มีจริงทีเดียวก็ทำให้ provider ดูพัง | `src/providers/_shared.js` เพิ่ม `currentlyFailing` |
| B9 | `.env` มี key ซ้ำ 3 ตัว (`FINNHUB_API_KEY`, `UNIVERSE_SIZE`, `ATR_STOP_MULT`) | dotenv เอาตัวท้าย — user แก้ตัวแรกแล้วไม่มีอะไรเกิดขึ้น | dedupe `.env` และ `.env.example` |
| B10 | `market.js` เดิม import `datafeed.js` ที่ใช้ v2 API | โปรแกรมพังทันทีตอน boot หลังอัปเกรด v3 | อัปเกรด `datafeed.js` เป็น v3 + เขียน `src/regime.js` ใช้ provider ใหม่ |

---

## ⚠️ ข้อจำกัดใหญ่ที่สุด — ยังไม่ได้ทดสอบกับข้อมูลจริง

โค้ดนี้พัฒนาใน sandbox ที่**บล็อกการเชื่อมต่อไปทุก host ของ provider การเงิน**:

```
query1.finance.yahoo.com     → 403 (policy denial)
query2.finance.yahoo.com     → 403
finnhub.io                   → 403
api.twelvedata.com           → 403
www.alphavantage.co          → 403
api.marketaux.com            → 403
financialmodelingprep.com    → 403
```

ผมจึงเขียน `src/providers/mock.js` (ข้อมูลสังเคราะห์แบบมี seed) เพื่อทดสอบ pipeline ให้ครบทุกเส้นทาง

**ทดสอบครบแล้ว (70/70):** server · REST API ทุก endpoint · ปุ่มทั้ง 3 · การพิสูจน์ว่าไม่มี timer ค้าง ·
watchlist CRUD + persist ลงไฟล์จริง · validate ticker · แจ้งเตือน + กันซ้ำ + reset ·
คะแนน + breakdown · แนวต้าน 3 ชั้น fallback · R:R + ตัวกรอง · ขนาดไม้ ·
settings + validation · provider interface ทั้ง 8 · backtest · error handling · หน้าเว็บ 3 หน้า

**ยังไม่ได้ทดสอบ — ต้องให้คุณลองบนเครื่องจริง:**
1. **โครงสร้าง response จริงของ provider ทั้ง 6 เจ้า** — เขียนตามเอกสาร แต่ field จริงอาจต่าง (ความเสี่ยงสูงสุดอยู่ที่นี่)
2. `run.bat` / `start.bat` บน Windows จริง
3. เสียงเตือน + Browser Notification ในเบราว์เซอร์จริง
4. การส่ง LINE จริง
5. **ค่าปรับเทียบทั้งหมด** — เส้นโค้งให้คะแนนทุกเส้น, `ATR_PCT_LOW/HIGH`, `targetExtAtr`, `minStopAtr`
   ตั้งจากหลักการ **ไม่ได้ปรับเทียบกับหุ้นจริง** ต้องใช้หน้า `/backtest` ปรับเอง

**ลำดับที่แนะนำ:**
```
1. npm test              → ยืนยันว่าติดตั้งครบ (ควรได้ 70/70)
2. npm run demo          → ดูหน้าเว็บ ลองปุ่ม ลองเสียง (ข้อมูลจำลอง)
3. npm start             → ตอนตลาดเปิด กับหุ้น 2-3 ตัวก่อน ดูว่าดึงข้อมูลจริงได้ไหม
4. เก็บข้อมูล 1-2 สัปดาห์ → ดู /backtest ว่าเกณฑ์ใช้ได้จริงไหม ก่อนใช้เงินจริง
```

---

*เอกสารนี้ตรวจโดยเปิดไฟล์อ่านจริง หาเลขบรรทัดด้วย grep และรัน `npm test` จริง*
*ไม่มีข้อไหนที่ติ๊ก ✅ จาก TODO comment หรือจากความจำ*

---

## บั๊กรอบที่ 2 — จากการตรวจสอบอิสระหลังเขียน checklist รอบแรก

หลังเขียน checklist รอบแรกเสร็จ ผมให้ตัวตรวจสอบอิสระอ่านโค้ดทั้งหมดใหม่โดยมองหาเฉพาะข้อที่ไม่ตรงสเปกหรือมีบั๊ก
**เจอเพิ่ม 7 ข้อที่เป็นบั๊กจริง** (ข้อ C1 ละเมิดสเปกข้อ 2 ตรงๆ) แก้แล้วทั้งหมดพร้อม regression test

| # | บั๊ก | ความรุนแรง | ผลถ้าไม่แก้ | แก้ที่ |
|---|---|---|---|---|
| **C1** | `start()` เช็คแค่ `_running` ไม่เช็ค `_scanning` · `_schedule()` ตั้ง `setTimeout` ทับ handle เดิมโดยไม่ `clearTimeout` | 🔴 **สูง — ละเมิดสเปกข้อ 2** | กด **Scan Now → Start** (ปุ่ม Start ยังกดได้เพราะ `running` ยังเป็น false) → เกิด 2 รอบสแกนวิ่งพร้อมกัน และเกิด **timer กำพร้า** ที่ `stop()` ตามเก็บไม่ได้ → **หลังกด Stop แล้วยังมีรอบสแกนโผล่มาอีก** ซึ่งเป็นสิ่งที่สเปกห้ามชัดเจน · ยังทำให้ `_scanning` ถูกเคลียร์ผิดจังหวะจนกันรอบซ้อนไม่ได้อีก | `src/scanner.js` — `start()` เช็ค `_scanning` · เพิ่ม `_clearTimer()` เป็นที่เดียวที่แตะ `_timer` · `_schedule()` เคลียร์ก่อนตั้งใหม่เสมอ · `_runScan()` มี guard กันรอบซ้อน · แก้ `scanNow()` ไม่ให้คืนค่า `_abort` เก่าที่ค้าง |
| **C2** | `_checkQuality()` hard-code `tfMin = 5` ทั้งที่มี `tfMinutes` จริงอยู่แล้ว | 🟠 กลาง | แถว 15m ได้มูลค่าซื้อขาย **เกินจริง 3 เท่า** → หุ้นตัวเดียวกัน **ผ่านด่านบน 15m แต่ตกบน 5m** ขัดแย้งกันเอง | `src/scanner.js` — ส่ง `dollarVolume5m` ที่คำนวณด้วย `tfMinutes` จริงเข้า `_checkQuality()` |
| **C3** | `backtest` อ่าน `sig.targetBreakout` แต่ `toSignalRecord()` ไม่เคยเขียน field นี้ | 🟠 กลาง | ตกไปใช้ `target` (แนวต้าน) แทน → **backtest ประเมินด้วยเป้าที่ต่างจากที่ R:R ใช้ตอนให้สัญญาณ** · สัญญาณที่โฆษณา 1:2.66 ถูกบันทึกเป็นชนะที่ 1.23R → **win rate / expectancy / max drawdown ในหน้า /backtest ผิดทั้งหมด** | `src/scanner.js` — บันทึก `targetBreakout` + `rrConservative` · regression test คำนวณ R:R ย้อนกลับแล้วเทียบกับที่บันทึกไว้ |
| **C4** | คำนวณ `positionSize` เมื่อ `rr.ok` เท่านั้น ไม่เช็ค `minRR` | 🟠 กลาง | แถวที่**ถูกกรองออกด้วย R:R** ยังโชว์จำนวนหุ้น เงินที่เสี่ยง และมูลค่าที่ต้องใช้ เหมือนเทรดได้จริง — อันตรายเพราะดูเผินๆ เหมือนแผนที่ใช้ได้ | `src/scanner.js` — เพิ่ม `rrPasses` gate · ไม่ผ่านคืน `shares: 0` พร้อมเหตุผล |
| **C5** | `_enrichTopCandidates()` สร้าง momentum context ใหม่แต่**ลืมส่ง `ema5Prev`** | 🟡 ต่ำ | ปัจจัยความชัน EMA (15% ของ momentum) **หายไปเฉพาะแถว top N** → คิดคะแนนด้วยสูตรต่างจากแถวอื่น และ breakdown ขาดบรรทัด "EMA5 ชี้ขึ้น/ลง" | `src/scanner.js` — เก็บ `ema5Prev` ลงในแถวและส่งต่อตอน rescore |
| **C6** | `rejects` Map ถูกเขียนแค่ใน `catch` (ข้อความ crash) เท่านั้น | 🟡 ต่ำ | `summary.filteredByRR` **เป็น 0 ตลอด** · `topRejects` และ log "ตกรอบเยอะสุด" รายงานแต่ error ไม่เคยรายงานเหตุผลตกด่านจริง — ทั้งที่นั่นคือข้อมูลที่ user อยากรู้ที่สุดว่าทำไมไม่มีสัญญาณ | `src/scanner.js` — เก็บสถิติจาก `row.failReasons` จริง · `filteredByRR` นับจากแถวจริง |
| **C7** | `getDailyBars()` มี `days` แต่ cache key ไม่รวม | 🟢 latent | ผู้เรียกที่ขอจำนวนวันต่างกันจะได้ผลของกันและกันไป 12 ชั่วโมง (ตอนนี้มีผู้เรียกเดียวจึงยังไม่เกิด) | `src/providers/index.js` — เพิ่ม `days` เข้า cache key |

### ข้ออื่นที่ตัวตรวจสอบชี้ และแก้ตาม (ไม่ใช่บั๊กแต่หลอก user)

| # | เรื่อง | แก้ที่ |
|---|---|---|
| C8 | **ค่า Settings 8 ตัวที่ไม่มีโค้ดไหนอ่าน** — คอมเมนต์เดิมอ้างว่าเก็บไว้ให้ `monitor.js` ใช้ แต่ `monitor.js` อ่านจาก `config.js`/`process.env` ไม่ได้อ่าน `src/settings.js` เลย → แก้ใน `settings.json` แล้วไม่มีอะไรเกิดขึ้น | ลบออกจาก `src/settings.js` ทั้ง 8 ตัว + เขียนหมายเหตุอธิบายว่าทำไมไม่อยู่ที่นี่ |
| C9 | **คำอธิบายในหน้า Settings ขัดกับพฤติกรรมจริง** — เขียนว่านอกช่วงจะข้ามรอบ แต่ scanner สแกนต่อทุกกรณี | เพิ่มค่า `scanWhenClosed` (default true) + checkbox + ทำให้ scanner **ข้ามรอบจริง** เมื่อปิดค่านี้ · แก้ข้อความให้ตรงพฤติกรรม |
| C10 | **ประวัติการแจ้งเตือนเขียนไฟล์แล้วแต่ไม่มีหน้าไหนแสดง** — `GET /api/alerts` มีอยู่แต่ไม่มี client เรียก | เพิ่มตาราง 🔔 ประวัติการแจ้งเตือน ในแดชบอร์ด · โหลดตอนเปิดหน้า ตอนมีเตือนใหม่ และตอน reset |
| C11 | `ctx.atrPct` ถูกส่งเข้า `computeScore()` แต่ไม่มีใครอ่าน | ลบออกจากทั้ง 2 จุดที่เรียก |
| C12 | แถวที่ผ่านด้วยเป้าขยาย (1:2.66) แต่ R:R แบบออกที่แนวต้านพอดีต่ำกว่า 1.5 (1:1.23) แสดงคู่กันโดยไม่อธิบาย ดูขัดแย้ง | เพิ่มคำเตือนในแถวรายละเอียดว่าแผนนี้ต้องให้ราคาทะลุแนวต้านไปจริงจึงคุ้ม |
| C13 | `import { getAlertState }` ใน `scanner.js` ไม่ถูกใช้ | ลบออก |

### สิ่งที่ตัวตรวจสอบยืนยันว่าถูกต้องแล้ว

การอัปเกรด yahoo-finance2 v3 (`new YahooFinance({...})` + `screener({scrIds,count})` ตรงกับ typings ของ 3.15.4 ที่ติดตั้งจริง) ·
ทุกไฟล์เป็น UTF-8 · `run.bat`/`start.bat` มี `chcp 65001` · `npm start` รัน server · disclaimer ครบทั้ง 3 หน้า

### ข้อสังเกตที่สำคัญที่สุด

บั๊ก C1 เป็นข้อที่สำคัญที่สุดของทั้งงาน เพราะเป็น**สิ่งที่สเปกข้อ 2 เน้นย้ำเป็นพิเศษ** ("หยุดจริง ไม่ค้าง interval")

**smoke test รอบแรกของผมทดสอบไม่เจอ** เพราะทดสอบแค่ `start → stop` ตามลำดับปกติ
ไม่ได้ทดสอบ **`scanNow` ซ้อนกับ `start`** ซึ่งเป็นเส้นทางที่ user กดได้จริงบนหน้าเว็บ
(ปุ่ม Start ไม่ถูก disable ตอน Scan Now ทำงาน เพราะ `running` ยังเป็น false)

→ regression test ที่เพิ่มเข้าไปตอนนี้ครอบเส้นทางนั้นแล้ว และรอ 13 วินาทีจริงเพื่อพิสูจน์ว่าไม่มี timer หลุดรอด
