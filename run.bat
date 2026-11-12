@echo off
chcp 65001 >nul
REM ============================================================
REM  run.bat - ดับเบิลคลิกไฟล์นี้เพื่อเปิด Scalp Scanner (Web UI)
REM
REM  บรรทัด "chcp 65001" ต้องอยู่บนสุดเสมอ
REM  เพราะไฟล์นี้บันทึกเป็น UTF-8 แต่ cmd ของ Windows ไทย
REM  อ่านด้วย codepage 874 โดยปริยาย ทำให้ภาษาไทยกลายเป็นตัวขยะ
REM  (นี่คือสาเหตุที่ start.bat เดิมแสดงภาษาไทยไม่ได้)
REM
REM  ไฟล์นี้ทำให้ทุกอย่างพร้อมใช้เองทั้งหมด:
REM    1) ตรวจ Node.js
REM    2) ติดตั้งไลบรารีถ้ายังไม่ครบ (มี auto-recovery ถ้าพัง)
REM    3) ตรวจและอัปเดตไฟล์ .env ให้พร้อมใช้ (setup-env.js)
REM    4) เปิดเบราว์เซอร์
REM    5) เริ่ม server
REM ============================================================
setlocal
cd /d "%~dp0"
title Scalp Scanner

echo ============================================================
echo   Scalp Scanner - เครื่องมือช่วยคัดกรองหุ้นอเมริกา
echo ============================================================
echo.

REM ---------- 1) ตรวจว่ามี Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ผิดพลาด] ไม่พบ Node.js ในเครื่องนี้
  echo.
  echo   กรุณาติดตั้ง Node.js เวอร์ชัน LTS ก่อน
  echo   ดาวน์โหลดที่ https://nodejs.org
  echo   ติดตั้งเสร็จแล้วปิดหน้าต่างนี้ แล้วดับเบิลคลิก run.bat อีกครั้ง
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [1/4] พบ Node.js เวอร์ชัน %NODEVER%

REM ---------- 2) ติดตั้งไลบรารีถ้ายังไม่ครบ ----------
REM เช็ค express เป็นตัวแทน (ถ้ามี express แปลว่า npm install ผ่านแล้ว)
if not exist "node_modules\express" goto :doinstall
if not exist "node_modules\socket.io" goto :doinstall
goto :installdone

:doinstall
echo.
echo [2/4] กำลังติดตั้งไลบรารีที่จำเป็น ^(ครั้งแรกใช้เวลา 1-2 นาที^)...
echo       express, socket.io, yahoo-finance2 v3, dotenv
echo.
call npm install
if not errorlevel 1 goto :installdone

REM ---------- ติดตั้งพลาด: ลองล้าง node_modules แล้วติดตั้งใหม่ 1 ครั้ง ----------
echo.
echo [เตือน] ติดตั้งไม่สำเร็จ - อาจเป็นเพราะไลบรารีเก่าค้างอยู่
echo         กำลังล้าง node_modules แล้วลองใหม่อีกครั้ง...
echo.
if exist "node_modules" rmdir /s /q "node_modules"
call npm install
if not errorlevel 1 goto :installdone

echo.
echo [ผิดพลาด] ติดตั้งไลบรารีไม่สำเร็จ
echo   - ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต
echo   - ถ้าอยู่หลัง proxy ขององค์กร อาจต้องตั้งค่า npm proxy ก่อน
echo   - ลองรัน  npm install  เองใน Command Prompt เพื่อดูข้อความผิดพลาดเต็ม
echo.
pause
exit /b 1

:installdone
echo [2/4] ไลบรารีครบแล้ว

REM ---------- 3) ตรวจและอัปเดตไฟล์ .env ----------
echo [3/4] ตรวจไฟล์ตั้งค่า .env
call node setup-env.js
if errorlevel 1 (
  echo.
  echo [ผิดพลาด] ตั้งค่าไฟล์ .env ไม่สำเร็จ - ดูข้อความด้านบน
  echo.
  pause
  exit /b 1
)

REM ---------- 4) เปิดเบราว์เซอร์ ----------
REM หน่วง 3 วินาที เพื่อให้ server พร้อมก่อนเบราว์เซอร์จะเปิด
echo [4/4] กำลังเปิดเบราว์เซอร์ไปที่ http://localhost:3000 ...
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:3000"

REM ---------- เริ่ม server ----------
echo.
echo ============================================================
echo   server กำลังทำงาน - อย่าปิดหน้าต่างนี้
echo   ปิดโปรแกรม: กด Ctrl+C หรือปิดหน้าต่างนี้
echo.
echo   scanner ยังไม่เริ่มทำงาน - กดปุ่ม "Start Scanner" ในหน้าเว็บ
echo ============================================================
echo.

node server.js

echo.
echo server หยุดทำงานแล้ว
pause
