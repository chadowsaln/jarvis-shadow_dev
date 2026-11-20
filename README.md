<p align="center">
  <img src="showcase/tauri/src-tauri/icons/128x128@2x.png" width="128" alt="JARVIS V2 icon">
</p>

# JARVIS V2

**JARVIS V2** هو تطور لقاعدة Little Boy/Roamies الحالية ليصبح مساعداً مستقلاً (API-powered) للتحكم بالحاسوب، بهوية:

> **AI Agent + Computer Control + Perception + Memory + Skills + Security**

المواصفة المرجعية للتنفيذ: [`JARVIS_V2_SPEC.md`](JARVIS_V2_SPEC.md).

## الحالة الحالية (WIP)

إعادة التسمية (rebranding) والتنفيذ تسيران وفق المسودة، والمشروع ليس مكتملاً بعد:

- **V2.1 — Linux Computer Control (مسودة/جزئي):** وحدة `showcase/tauri/sidecar/computer-control/` وأدوات Linux في `showcase/tauri/sidecar/tools.mjs` (`linux_list_apps`, `linux_list_windows`, `linux_find_element`, `linux_click_element`, `linux_type_text`, `linux_press_key`, `linux_move_mouse`, `linux_capture_screen`, `linux_ocr`, `linux_focus_window`). التكامل والتحقق الطرف-إلى-طرف (AT-SPI2، ydotool/libei/uinput، XDG Portal، Tesseract) ما زالا يتطلبان إعداداً واختباراً على النظام.
- **V2.2–V2.6 (غير منفّذة):** Browser Intelligence (Playwright)، حلقة Execute→Observe→Verify→Recover المدمجة والتدقيق، نظام المهارات (تسجيل/إعادة تشغيل)، الذاكرة الدلالية (SQLite/FTS/ترحيل)، والمساعدة الاستباقية.

**هوية الحزم/التطبيق (قيد التحديث):** `productName` JARVIS V2، `identifier` `ai.jarvis.v2`، الإصدار `0.1.1` (Tauri)، الحزمة Rust `jarvis_v2`، وsidecar `jarvis-v2-sidekick`. قد تبقى أسماء/مسارات/نصوص قديمة في أجزاء من الواجهة والوثائق الأصلية حتى يكتمل الانتقال.

## البنية

- **Tauri 2** (Rust): `showcase/tauri/src-tauri`
- **Node sidecar (Agent Core + tools):** `showcase/tauri/sidecar`
- **واجهة/أصول مشتركة:** `showcase/roamies`, `showcase/panel`, `showcase/onboarding`, `showcase/desktop.html`

## التطوير والبناء

المتطلبات: Rust، Node.js 22+، ومتطلبات [Tauri](https://v2.tauri.app/start/prerequisites/).

```bash
cd showcase/tauri/sidecar
npm ci

cd ..
./build.sh dev        # بناء تطويري
./build.sh            # حزمة إصدار للنظام الحالي
```

ملاحظات:
- تتطلب مزايا التحكم/الرؤية على Linux (حسب الإعداد) وصولية AT-SPI، و`ydotool`/uinput أو libei، و`xdg-desktop-portal`، وTesseract.
- في هذه البيئة فشل تغليف AppImage عبر `linuxdeploy` أثناء المحاولة؛ تم إنتاج حزم `.deb`/`.rpm` (قد يختلف اسم ملف الحزمة وفق إعدادات التغليف الحالية). تغليف AppImage يحتاج بيئة/أدوات AppImage سليمة.

## القيود (وفق المسودة)

- الحفاظ على معمارية Tauri + Rust + Node.js الحالية وتطوير Agent Core القائم دون runtime ثانٍ أو تنسيق متعدد الوكلاء في هذه المرحلة.
- لا نماذج LLM/Vision محلية ولا خدمات خلفية ثقيلة؛ استخدام مزودين عبر API (مثل OpenRouter) عند الحاجة.
- استهداف Fedora GNOME Wayland مع مراعاة الموارد المحدودة.

## الترخيص

[AGPL-3.0](LICENSE). هذا المشروع مبني على قاعدة Roamies/Little Boy؛ راجع [CONTRIBUTING.md](CONTRIBUTING.md) و[SECURITY.md](SECURITY.md) و[PRIVACY.md](PRIVACY.md) للتفاصيل والسياسات ذات الصلة.
