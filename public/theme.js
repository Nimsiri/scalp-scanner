/* theme.js — ธีม "Rosé Champagne" (โทนสว่าง อบอุ่น เรียบหรู) ใช้ร่วมกันทั้ง 3 หน้า
 *
 * โค้ดเดิม (ทั้ง HTML และ app.js) ใช้ class สีของ Tailwind ที่ออกแบบไว้สำหรับพื้นหลังมืด
 * เช่น bg-slate-900 = พื้นการ์ด, text-emerald-400 = ตัวเลขกำไร, bg-red-950/60 = กล่องเตือน
 * ไฟล์นี้ remap ชุดสีเหล่านั้นเป็นโทนสว่างโดย "คงความหมายเดิมของแต่ละเฉด":
 *   950 / 900 / 800  → พื้นอ่อน / ขอบบาง (เดิมคือพื้นเข้ม)
 *   700              → ขอบ / พื้นปุ่มแบบอ่อน
 *   600 / 500        → สีทึบ (ปุ่ม จุดสถานะ แถบกราฟ) ใช้คู่ตัวอักษรขาวได้
 *   400 / 300 / 200 / 100 / 50 → สีตัวอักษร ยิ่งเลขน้อยยิ่งเข้ม (เดิมยิ่งเลขน้อยยิ่งสว่าง)
 * → ไม่ต้องไล่แก้ class ทีละจุด และ logic ใน app.js ไม่ถูกแตะ
 *
 * ต้องโหลดหลัง https://cdn.tailwindcss.com
 */
(function () {
  // ลำดับค่า: [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
  const KEYS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const scale = (vals) => Object.fromEntries(KEYS.map((k, i) => [k, vals[i]]));

  // โทนกลาง: เทาอมชมพู-ม่วง (mauve) อบอุ่นกว่าเทาฟ้าของ slate เดิม
  const neutral = scale(['#2A1E24', '#33262D', '#43343B', '#574850', '#6D5C64', '#83717B', '#A08F97', '#E6DAD6', '#F1E8E5', '#FFFFFF', '#FBF7F5']);
  // กำไร / สำเร็จ: เขียวหยก
  const jade = scale(['#0E3326', '#123D2E', '#18503C', '#1F6A4F', '#2A8563', '#3C9A76', '#2F8264', '#BFE2D2', '#D5EDE2', '#E5F4EC', '#F2FAF6']);
  // ขาดทุน / อันตราย: แดงราสป์เบอร์รี
  const raspberry = scale(['#4A1220', '#5C1624', '#7A1F31', '#9E2B42', '#C03A53', '#D2526A', '#C23D55', '#F0C2CC', '#F6D6DD', '#FBE6EA', '#FDF3F5']);
  // แจ้งเตือน / เป้า: ทองแชมเปญ
  const champagne = scale(['#3F2C0C', '#4F3710', '#6B4B16', '#83601C', '#9A6F22', '#C29645', '#9E742A', '#EAD5AC', '#F2E4C7', '#F8EFDC', '#FCF7EC']);
  // สีหลักของแบรนด์ (แทน sky ที่เดิมเป็นสี accent): ชมพูโรสอมม่วง
  const rose = scale(['#3B1A2B', '#4A2236', '#5E2C45', '#7C3B5B', '#9A4F72', '#B7688A', '#A85478', '#E9C6D5', '#F3DCE6', '#F9EAF0', '#FDF5F8']);

  const PALETTE = {
    slate: neutral, gray: neutral, zinc: neutral, neutral, stone: neutral,
    emerald: jade, teal: jade,
    green: scale(['#1E3A18', '#27491F', '#335E29', '#437636', '#4E8243', '#6FA362', '#5C8F50', '#CFE3C6', '#DFEDD8', '#ECF5E8', '#F5FAF3']),
    lime: scale(['#1E3A18', '#27491F', '#335E29', '#437636', '#4E8243', '#6FA362', '#5C8F50', '#CFE3C6', '#DFEDD8', '#ECF5E8', '#F5FAF3']),
    red: raspberry,
    amber: champagne,
    yellow: scale(['#3E3208', '#4D3F0B', '#66540F', '#7A6414', '#8C7318', '#CFAE4A', '#A88A26', '#EBDDA8', '#F3EAC6', '#F8F2DC', '#FCF9EE']),
    orange: scale(['#3D1C0E', '#4D2412', '#6E3419', '#8E4424', '#B85D35', '#CF7A50', '#D98C66', '#F0CDB9', '#F5DCCD', '#F9E8DE', '#FDF4EE']),
    sky: rose, cyan: rose,
    blue: scale(['#2E1A2C', '#3A2138', '#4C2B49', '#653A60', '#8A5484', '#9D6A97', '#7E4C78', '#E2CCE0', '#EDDDEB', '#F5EBF4', '#FBF6FA']),
    violet: scale(['#2A1D3B', '#352548', '#46305E', '#5C3F7A', '#7A58A0', '#9272B6', '#8462A6', '#DCCDEB', '#E8DDF3', '#F2ECF9', '#F9F6FC']),
    purple: scale(['#2A1D3B', '#352548', '#46305E', '#5C3F7A', '#7A58A0', '#9272B6', '#8462A6', '#DCCDEB', '#E8DDF3', '#F2ECF9', '#F9F6FC']),
    indigo: scale(['#1F2144', '#282B55', '#35396E', '#454A8C', '#5D63A8', '#7A80BE', '#6268AD', '#D3D5EE', '#E1E3F4', '#EDEEF9', '#F6F7FC']),
    fuchsia: scale(['#3E1433', '#4D1A40', '#651F53', '#82306C', '#A34488', '#C4639F', '#B0508E', '#EDC4DE', '#F4D7E9', '#F9E7F2', '#FCF4F9']),
    pink: scale(['#3E1433', '#4D1A40', '#651F53', '#82306C', '#A34488', '#C4639F', '#B0508E', '#EDC4DE', '#F4D7E9', '#F9E7F2', '#FCF4F9']),
  };

  if (window.tailwind) {
    window.tailwind.config = {
      theme: {
        extend: {
          colors: PALETTE,
          fontFamily: {
            sans: ['"IBM Plex Sans Thai"', 'Sarabun', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
            serif: ['"Noto Serif Thai"', '"Cormorant Garamond"', 'Georgia', 'serif'],
            display: ['"Cormorant Garamond"', '"Noto Serif Thai"', 'Georgia', 'serif'],
          },
          borderRadius: { DEFAULT: '6px', md: '10px', lg: '14px', xl: '18px', '2xl': '22px' },
        },
      },
    };
  }

  // ---------- ไอคอนเส้นบาง (ดัดแปลงจาก Lucide, ISC license) ----------
  const ICONS = {
    gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
    layout: '<rect width="7" height="9" x="3" y="3" rx="1.5"/><rect width="7" height="5" x="14" y="3" rx="1.5"/><rect width="7" height="9" x="14" y="12" rx="1.5"/><rect width="7" height="5" x="3" y="16" rx="1.5"/>',
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    exchange: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    play: '<polygon points="7 4 19 12 7 20 7 4" fill="currentColor"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    calculator: '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',
    ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    flask: '<path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>',
    bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    pin: '<line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  };

  const svg = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ให้สคริปต์ของแต่ละหน้าเรียกใช้ตอนสร้าง HTML แบบไดนามิก
  window.themeIcon = svg;
  window.themeHIcon = (name, variant = '') => `<span class="h-icon ${variant}">${svg(name)}</span>`;

  // เติมไอคอนให้ทุก element ที่มี data-icon="ชื่อ" ใน HTML
  document.addEventListener('DOMContentLoaded', () => {
    for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = svg(el.dataset.icon);
  });
})();
