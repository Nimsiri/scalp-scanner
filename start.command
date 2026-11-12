#!/bin/bash
# start.command — ดับเบิลคลิกไฟล์นี้เพื่อรันโปรแกรม Scalp Scanner บน macOS
# ถ้าดับเบิลคลิกแล้วไม่ทำงาน ให้เปิด Terminal แล้วรันคำสั่ง: chmod +x start.command

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[ผิดพลาด] ไม่พบ Node.js ในเครื่องนี้"
  echo "กรุณาไปติดตั้งที่ https://nodejs.org ก่อน (เลือกเวอร์ชัน LTS) แล้วค่อยรันไฟล์นี้ใหม่"
  read -r -p "กด Enter เพื่อปิดหน้าต่างนี้..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "กำลังติดตั้งไลบรารีที่จำเป็น (ทำครั้งแรกครั้งเดียว รอสักครู่)..."
  npm install
  if [ $? -ne 0 ]; then
    echo "[ผิดพลาด] ติดตั้งไลบรารีไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่"
    read -r -p "กด Enter เพื่อปิดหน้าต่างนี้..."
    exit 1
  fi
fi

if [ ! -f .env ]; then
  echo "[ผิดพลาด] ไม่พบไฟล์ .env"
  echo "กรุณาคัดลอกไฟล์ .env.example แล้วเปลี่ยนชื่อเป็น .env จากนั้นกรอกข้อมูลให้ครบตามคำแนะนำใน README.md"
  read -r -p "กด Enter เพื่อปิดหน้าต่างนี้..."
  exit 1
fi

echo "กำลังเริ่มโปรแกรม Scalp Scanner..."
echo "(กด Ctrl+C เพื่อหยุดโปรแกรม)"
echo ""
npm start

read -r -p "กด Enter เพื่อปิดหน้าต่างนี้..."
