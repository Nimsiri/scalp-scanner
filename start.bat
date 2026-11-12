@echo off
chcp 65001 >nul
REM ============================================================
REM  start.bat - รันโหมด CLI แบบเดิม (แสดงผลใน terminal เท่านั้น)
REM
REM  ถ้าต้องการหน้าเว็บ ให้ดับเบิลคลิก run.bat แทน
REM
REM  เพิ่ม "chcp 65001" เพื่อแก้ปัญหาภาษาไทยเป็นตัวขยะ
REM  (ไฟล์เป็น UTF-8 แต่ cmd อ่านด้วย codepage 874 โดยปริยาย)
REM ============================================================
setlocal
cd /d "%~dp0"
title Scalp Scanner (โหมด CLI)

where node >nul 2>nul
if errorlevel 1 (
  echo [ผิดพลาด] ไม่พบ Node.js ในเครื่องนี้
  echo กรุณาไปติดตั้งที่ https://nodejs.org ก่อน ^(เลือกเวอร์ชัน LTS^) แล้วค่อยรันไฟล์นี้ใหม่
  pause
  exit /b 1
)

if not exist "node_modules\dotenv" (
  echo กำลังติดตั้งไลบรารีที่จำเป็น ^(ทำครั้งแรกครั้งเดียว รอสักครู่^)...
  call npm install
  if errorlevel 1 (
    echo [ผิดพลาด] ติดตั้งไลบรารีไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo [ผิดพลาด] ไม่พบไฟล์ .env
  echo กรุณาคัดลอกไฟล์ .env.example แล้วเปลี่ยนชื่อเป็น .env จากนั้นกรอกข้อมูลตามคำแนะนำใน README.md
  pause
  exit /b 1
)

echo กำลังเริ่มโปรแกรมโหมด CLI...
echo ^(ปิดหน้าต่างนี้ หรือกด Ctrl+C เพื่อหยุดโปรแกรม^)
echo.
node monitor.js

pause
