// The landing page body, in both languages. build.mjs wraps it with the header, footer and <head>.

export const T = {
  en: {
    h1: "Ask your AI app for a screen video.",
    lead: "ScreenPilot records your screen, or uses your apps itself, then cuts the footage into a finished MP4 with zooms, captions and a voiceover. Your AI app does the thinking. Everything runs on your computer.",
    install: "Install ScreenPilot", docs: "Read the docs",
    fine: "Free and open source (MIT). No account and no API key.",
    edAria: "A live storyboard: scrub the timeline or switch between raw and edited footage",
    raw: "Raw", edited: "Edited", modeLabel: "Footage", capLang: "Caption language",
    play: "Play", pause: "Pause", skipped: "skipped", waiting: "waiting",
    rows: ["Video", "Zoom", "Caption", "Highlight", "Voice"],
    hint: "A real storyboard, running live. Switch to Raw to see the footage as recorded, drag the playhead, or hover a block to read the JSON behind it.",
    chapters: ["Intro", "What", "Demo", "Steps", "Install", "Apps"],
    whatH: "What you get",
    whatIntro: "A recorder and a video editor that your AI app can drive.",
    what: [
      ["Records any app", "Windows, macOS and Linux. Native apps, editors and terminals, not only a browser."],
      ["Performs the demo for you", "The AI can click and type in your app with your real mouse and keyboard, so you do not have to rehearse."],
      ["Edits like an editor", "Zooms in on clicks, adds captions and highlights, cuts idle time and speeds up the waiting."],
      ["Joins clips, in any size", "Insert a new feature into an existing demo without re-recording it, and export 16:9, 9:16 and 1:1 from one edit."],
      ["Speaks your language", "Voiceover in English, Arabic and many other languages, with a different voice per line if you want one."],
      ["Needs no API key", "Your AI app writes the edit. ScreenPilot gives it the screen, the recorder and the video editor."],
    ],
    watchH: "Made by ScreenPilot",
    watchP: "The AI opened this page, clicked through the install steps and recorded it. Then it chose the look and edited the video.",
    watchCap: "A real render, not a mock-up. The page it recorded is the one you are reading.",
    stepsH: "How it works",
    steps: [
      ["Record, or let the AI drive", "Ask for a recording, or let your AI app perform the steps itself.", "record_start"],
      ["Look at the footage", "It reads a contact sheet and frames with a coordinate grid to see what happened.", "analyze"],
      ["Write the storyboard", "Cuts, zooms, captions, highlights and voiceover go into one JSON file.", "storyboard.json"],
      ["Render", "A draft to check, then the final MP4.", "render"],
    ],
    installH: "Install",
    installIntro: "Install your AI app first and open it once. The installer then adds ScreenPilot to every AI app it finds.",
    tabs: { windows: "Windows", linux: "Linux", macos: "macOS" },
    dlWin: "Download for Windows", dlLinux: "Download for Linux", fileWin: "ScreenPilot-windows-setup.exe", fileLinux: "ScreenPilot-linux.tar.gz",
    win: ["Double-click the installer.", "If Windows says “Windows protected your PC”, click More info, then Run anyway. The installer is not signed yet.", "Click Install. The first time it also downloads the video renderer (about 100 MB).", "Quit your AI app completely and open it again."],
    linux: ["Extract the archive. You get a ScreenPilot folder.", "Double-click install.sh, or run ./install.sh in a terminal. Do not use sudo.", "Restart your AI app.", "The first time you record, your desktop asks once to allow screen sharing. Allow it."],
    macNote: "The Mac builds are not part of version 0.4.0. Get them from version 0.2.3; they come back in the next release.",
    mac: ["Download the zip for your Mac and unzip it.", "Open the folder and double-click Install ScreenPilot.command.", "Restart your AI app, then allow it in System Settings, Privacy & Security when macOS asks."],
    dlMac: "Mac builds in version 0.2.3", installMore: "Full install guide, other AI apps and troubleshooting",
    worksH: "Works with the AI app you already use",
    worksMore: "and any app that supports MCP servers",
    foot: { about: "ScreenPilot is open source under the MIT license.", names: "Product names belong to their owners. ScreenPilot is an independent project.", learn: "Learn", project: "Project", issues: "Report an issue", releases: "Releases", license: "License", notices: "Third-party notices", security: "Security", contributing: "Contributing" },
    ogTitle: "ScreenPilot: ask your AI app for a screen video", ogDesc: "ScreenPilot records your screen, or uses your apps itself, and edits the footage into a finished MP4 with zooms, captions and a voiceover.",
  },
  ar: {
    h1: "اطلب من تطبيق الذكاء الاصطناعي فيديو للشاشة.",
    lead: "ScreenPilot يسجّل شاشتك أو يشغّل تطبيقاتك بنفسه، ثم يقصّ المقطع إلى فيديو MP4 جاهز بتكبير وتعليقات وصوت. تطبيق الذكاء الاصطناعي هو الذي يفكّر، وكل شيء يعمل على جهازك.",
    install: "ثبّت ScreenPilot", docs: "اقرأ التوثيق",
    fine: "مجاني ومفتوح المصدر (MIT). بدون حساب وبدون مفتاح API.",
    edAria: "storyboard حيّ: حرّك الشريط الزمني أو بدّل بين اللقطات الخام والمعدّلة",
    raw: "خام", edited: "معدّل", modeLabel: "اللقطات", capLang: "لغة التعليق",
    play: "تشغيل", pause: "إيقاف", skipped: "تم تخطّيه", waiting: "انتظار",
    rows: ["الفيديو", "التكبير", "التعليق", "التمييز", "الصوت"],
    hint: "storyboard حقيقي يعمل الآن. بدّل إلى «خام» لترى اللقطات كما سُجّلت، أو حرّك مؤشر التشغيل، أو مرّر على أي مقطع لتقرأ الـ JSON الذي صنعه.",
    chapters: ["مقدمة", "ماذا", "عرض", "خطوات", "تثبيت", "تطبيقات"],
    whatH: "ماذا تحصل عليه",
    whatIntro: "مسجّل شاشة ومحرّر فيديو يقودهما تطبيق الذكاء الاصطناعي.",
    what: [
      ["يسجّل أي تطبيق", "على Windows وmacOS وLinux. تطبيقات سطح المكتب والمحررات والطرفيات، وليس المتصفح فقط."],
      ["ينفّذ العرض بدلًا منك", "يضغط الذكاء الاصطناعي ويكتب في تطبيقك بالماوس ولوحة المفاتيح الحقيقيين، فلا تحتاج إلى تدريب مسبق."],
      ["يعدّل كما يفعل محرّر", "يكبّر عند الضغطات، ويضيف التعليقات والتمييز، ويقصّ الوقت الميت ويسرّع الانتظار."],
      ["يدمج المقاطع ويصدّر بأي حجم", "أدخل ميزة جديدة في عرض موجود دون إعادة تسجيله، وصدّر 16:9 و9:16 و1:1 من تعديل واحد."],
      ["يتحدث بلغتك", "تعليق صوتي بالعربية والإنجليزية ولغات كثيرة أخرى، وبصوت مختلف لكل سطر إن أردت."],
      ["لا يحتاج مفتاح API", "تطبيقك الذكي يكتب المونتاج. وScreenPilot يعطيه الشاشة والمسجّل ومحرّر الفيديو."],
    ],
    watchH: "صُنع بواسطة ScreenPilot",
    watchP: "فتح الذكاء الاصطناعي هذه الصفحة، وضغط على خطوات التثبيت وسجّلها. ثم اختار الشكل وعدّل الفيديو.",
    watchCap: "هذا عرض حقيقي وليس نموذجًا. والصفحة التي سجّلها هي التي تقرؤها الآن.",
    stepsH: "كيف يعمل",
    steps: [
      ["سجّل، أو دعه يقود", "اطلب تسجيلًا، أو دع تطبيقك الذكي ينفّذ الخطوات بنفسه.", "record_start"],
      ["ينظر إلى اللقطات", "يقرأ ورقة مصغّرات وإطارات عليها شبكة إحداثيات ليفهم ما حدث.", "analyze"],
      ["يكتب الـ storyboard", "القصّ والتكبير والتعليقات والتمييز والتعليق الصوتي في ملف JSON واحد.", "storyboard.json"],
      ["يصيّر الفيديو", "مسودة للمراجعة، ثم ملف MP4 النهائي.", "render"],
    ],
    installH: "التثبيت",
    installIntro: "ثبّت تطبيق الذكاء الاصطناعي أولًا وافتحه مرة. ثم يضيف المثبّت ScreenPilot إلى كل تطبيق ذكاء اصطناعي يجده.",
    tabs: { windows: "Windows", linux: "Linux", macos: "macOS" },
    dlWin: "حمّل لنظام Windows", dlLinux: "حمّل لنظام Linux", fileWin: "ScreenPilot-windows-setup.exe", fileLinux: "ScreenPilot-linux.tar.gz",
    win: ["انقر مرتين على المثبّت.", "إذا قال Windows «Windows protected your PC» فاختر More info ثم Run anyway. المثبّت غير موقّع بعد.", "اضغط Install. في أول مرة ينزّل أيضًا محرّك التصيير (حوالي 100 MB).", "أغلق تطبيق الذكاء الاصطناعي تمامًا ثم افتحه من جديد."],
    linux: ["فكّ ضغط الأرشيف. ستحصل على مجلد ScreenPilot.", "انقر مرتين على install.sh، أو شغّل ‎./install.sh في الطرفية. لا تستخدم sudo.", "أعد تشغيل تطبيق الذكاء الاصطناعي.", "في أول تسجيل يطلب سطح المكتب مرة واحدة السماح بمشاركة الشاشة. اسمح له."],
    macNote: "نسخ Mac ليست ضمن الإصدار 0.4.0. حمّلها من الإصدار 0.2.3، وستعود في الإصدار القادم.",
    mac: ["حمّل ملف zip الخاص بجهازك وفكّ ضغطه.", "افتح المجلد وانقر مرتين على Install ScreenPilot.command.", "أعد تشغيل تطبيق الذكاء الاصطناعي، ثم اسمح له في System Settings ثم Privacy & Security حين يطلب macOS ذلك."],
    dlMac: "نسخ Mac في الإصدار 0.2.3", installMore: "دليل التثبيت الكامل وتطبيقات أخرى وحل المشكلات",
    worksH: "يعمل مع تطبيق الذكاء الاصطناعي الذي تستخدمه",
    worksMore: "وأي تطبيق يدعم خوادم MCP",
    foot: { about: "ScreenPilot مفتوح المصدر برخصة MIT.", names: "أسماء المنتجات ملك لأصحابها. ScreenPilot مشروع مستقل.", learn: "تعلّم", project: "المشروع", issues: "أبلغ عن مشكلة", releases: "الإصدارات", license: "الرخصة", notices: "إشعارات الأطراف الثالثة", security: "الأمان", contributing: "المساهمة" },
    ogTitle: "ScreenPilot: اطلب من تطبيق الذكاء الاصطناعي فيديو للشاشة", ogDesc: "ScreenPilot يسجّل شاشتك أو يشغّل تطبيقاتك بنفسه، ويحوّل المقطع إلى فيديو MP4 جاهز بتكبير وتعليقات وصوت.",
  },
};

const APPS = ["Claude Desktop", "Claude Code", "Codex", "Cursor", "OpenCode", "Gemini CLI", "GitHub Copilot", "Windsurf", "VS Code", "Zed", "Goose", "Warp", "Cline", "Roo Code", "Kiro", "Antigravity", "LM Studio", "Qwen Code"];
const REL = "https://github.com/MohamedEslam04/screenpilot/releases";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function landing(lang, { guide, media }) {
  const t = T[lang];
  const lanes = ["ruler", "video", "zoom", "cap", "hl", "voice"];
  const rows = [""].concat(t.rows).map((label, i) => {
    const k = lanes[i];
    const extra = k === "ruler" ? ` scrub" role="slider" tabindex="0" aria-label="${esc(t.edAria)}" aria-valuemin="0" aria-valuemax="18" aria-valuenow="0` : "";
    return `<div class="t-row"><span>${esc(label)}</span><div class="lane ${k === "ruler" ? "ruler" : ""}${extra}" data-lane="${k}"></div></div>`;
  }).join("");
  const ol = (items) => `<ol>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
  return `
<section class="hero wrap" data-chapter="${t.chapters[0]}">
  <h1>${esc(t.h1)}</h1>
  <p class="lead">${esc(t.lead)}</p>
  <div class="cta"><a class="btn btn-primary" href="#install">${esc(t.install)}</a><a class="btn btn-quiet" href="${guide}index.html">${esc(t.docs)}</a></div>
  <p class="fine">${esc(t.fine)}</p>
  <section class="editor" id="editor" data-lang="${lang}" data-mode="edited" data-t-cut="${esc(t.skipped)}" data-t-wait="${esc(t.waiting)}" aria-label="${esc(t.edAria)}">
    <div class="ed-bar"><div class="ed-dots" aria-hidden="true"><i></i><i></i><i></i></div><span class="ed-name">northwind-demo/storyboard.json</span>
      <div class="seg" role="group" aria-label="${esc(t.modeLabel)}"><button type="button" data-mode="raw" aria-pressed="false">${esc(t.raw)}</button><button type="button" data-mode="edited" aria-pressed="true">${esc(t.edited)}</button></div>
      <div class="seg" role="group" aria-label="${esc(t.capLang)}"><button type="button" data-cl="en" aria-pressed="${lang === "en"}">EN</button><button type="button" data-cl="ar" aria-pressed="${lang === "ar"}">ع</button></div>
    </div>
    <div class="monitor"><div class="stage-wrap"><div class="stage" aria-hidden="true"></div><div class="cap" aria-live="off"><span></span></div><div class="badge-speed" aria-hidden="true">8×</div></div></div>
    <div class="transport"><button type="button" class="play" data-play="${esc(t.play)}" data-pause="${esc(t.pause)}" aria-label="${esc(t.pause)}"></button><span class="tc"><span class="tcn">00:00.0</span> <em>/ <span class="tct">00:10.1</span></em></span><span class="ed-note" dir="auto">${esc(t.hint)}</span></div>
    <div class="timeline">${rows}<div class="ph-area"><div class="ph"></div></div></div>
    <div class="tip" role="tooltip"></div>
  </section>
</section>

<section class="sec" data-chapter="${t.chapters[1]}"><div class="wrap split">
  <div class="stick"><h2>${esc(t.whatH)}</h2><p class="intro">${esc(t.whatIntro)}</p></div>
  <dl class="ledger">${t.what.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join("")}</dl>
</div></section>

<section class="sec watch" data-chapter="${t.chapters[2]}"><div class="wrap">
  <h2>${esc(t.watchH)}</h2><p class="intro">${esc(t.watchP)}</p>
  <div class="screen"><video controls preload="none" playsinline poster="${media}screenpilot-demo-poster.jpg" src="${media}screenpilot-demo.mp4"></video></div>
  <p class="cap-line">${esc(t.watchCap)}</p>
</div></section>

<section class="sec" data-chapter="${t.chapters[3]}"><div class="wrap">
  <h2>${esc(t.stepsH)}</h2>
  <ol class="clips">${t.steps.map(([h, p, c]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p><code>${esc(c)}</code></li>`).join("")}</ol>
</div></section>

<section class="sec" id="install" data-chapter="${t.chapters[4]}"><div class="wrap">
  <h2>${esc(t.installH)}</h2><p class="intro">${esc(t.installIntro)}</p>
  <div class="tabs">
    <div class="tablist" role="tablist">${["windows", "linux", "macos"].map((os) => `<button type="button" role="tab" id="tab-${os}" data-os="${os}" aria-controls="p-${os}" aria-selected="false" tabindex="-1">${t.tabs[os]}</button>`).join("")}</div>
    <div class="tabpanel" role="tabpanel" id="p-windows" aria-labelledby="tab-windows" hidden><div class="dl"><a class="btn btn-primary" href="${REL}/latest/download/${t.fileWin}">${esc(t.dlWin)}</a><small>${t.fileWin}</small></div>${ol(t.win)}</div>
    <div class="tabpanel" role="tabpanel" id="p-linux" aria-labelledby="tab-linux" hidden><div class="dl"><a class="btn btn-primary" href="${REL}/latest/download/${t.fileLinux}">${esc(t.dlLinux)}</a><small>${t.fileLinux}</small></div>${ol(t.linux)}</div>
    <div class="tabpanel" role="tabpanel" id="p-macos" aria-labelledby="tab-macos" hidden><div class="dl"><a class="btn btn-quiet" href="${REL}/tag/v0.2.3">${esc(t.dlMac)}</a></div><div><p class="mac-note">${esc(t.macNote)}</p>${ol(t.mac)}</div></div>
  </div>
  <p style="margin-top:22px"><a href="${guide}install.html">${esc(t.installMore)}</a></p>
</div></section>

<section class="sec" data-chapter="${t.chapters[5]}"><div class="wrap">
  <h2>${esc(t.worksH)}</h2>
  <ul class="wall">${APPS.map((a) => `<li>${esc(a)}</li>`).join("")}<li class="more">${esc(t.worksMore)}</li></ul>
</div></section>`;
}
