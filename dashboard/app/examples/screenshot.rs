//! Headless screenshots of the real window code: the software renderer draws into a pixel buffer
//! that is written as PNG. Data comes from `fixture` (about 10 000 events), the window from
//! `app::build_inline`, so this is the same code path as the shipping binary.
//!
//! `cargo run --example screenshot -- <out dir> [work dir]`

use screenpilot_dashboard::{app, fixture, model};
use slint::platform::software_renderer::{
    MinimalSoftwareWindow, PremultipliedRgbaColor, RepaintBufferType, TargetPixel,
};
use slint::platform::{Platform, WindowAdapter};
use slint::{ComponentHandle, PhysicalSize};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Default)]
struct Px(u8, u8, u8, u8);

impl TargetPixel for Px {
    fn blend(&mut self, c: PremultipliedRgbaColor) {
        let ia = u16::from(255 - c.alpha);
        self.0 = (u16::from(self.0) * ia / 255) as u8 + c.red;
        self.1 = (u16::from(self.1) * ia / 255) as u8 + c.green;
        self.2 = (u16::from(self.2) * ia / 255) as u8 + c.blue;
        self.3 = 255;
    }
    fn from_rgb(r: u8, g: u8, b: u8) -> Self {
        Px(r, g, b, 255)
    }
}

struct Headless(Rc<MinimalSoftwareWindow>);

impl Platform for Headless {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, slint::PlatformError> {
        Ok(self.0.clone())
    }
}

fn render(win: &MinimalSoftwareWindow, w: u32, h: u32) -> Vec<Px> {
    win.set_size(PhysicalSize::new(w, h));
    // Change handlers (the narrow flag) and animations run here.
    for _ in 0..3 {
        slint::platform::update_timers_and_animations();
    }
    let (wu, hu) = (w as usize, h as usize);
    let mut buf = vec![Px::default(); wu * hu];
    // A second frame shows whether the layout needed more than one pass to settle.
    for _ in 0..2 {
        slint::platform::update_timers_and_animations();
        win.request_redraw();
        win.draw_if_needed(|r| {
            r.render(&mut buf, wu);
        });
    }
    buf
}

fn shot(win: &MinimalSoftwareWindow, w: u32, h: u32, out: &Path, name: &str) {
    let buf = render(win, w, h);
    let mut raw = Vec::with_capacity(buf.len() * 4);
    for p in &buf {
        raw.extend_from_slice(&[p.0, p.1, p.2, p.3]);
    }
    let path = out.join(format!("{name}.png"));
    let f = std::fs::File::create(&path).expect("create png");
    let mut enc = png::Encoder::new(f, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()
        .and_then(|mut wr| wr.write_image_data(&raw))
        .expect("write png");
    println!("{}", path.display());
}

fn make_video(path: &Path) {
    let ok = std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=10",
            "-t",
            "2",
        ])
        .args(["-pix_fmt", "yuv420p"])
        .arg(path)
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        eprintln!("ffmpeg not available: no thumbnail in the shots");
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let out = PathBuf::from(args.next().expect("usage: screenshot <out dir> [work dir]"));
    let work = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("sp-shots-{}", std::process::id())));
    std::fs::create_dir_all(&out).unwrap();
    let _ = std::fs::remove_dir_all(&work);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let fx = fixture::write(&work, 10_000, now, r#"{"elevenlabs":"env","gemini":null}"#)
        .expect("write fixture");
    fixture::write_jobs(&fx.paths, now).expect("write jobs");
    make_video(&work.join("sessions").join("demo-signup-1").join("demo.mp4"));

    let win = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
    slint::platform::set_platform(Box::new(Headless(win.clone()))).expect("platform");
    let ui = app::build_inline(fx.paths.clone(), fx.cli.clone());
    let w = ui.window.clone_strong();
    w.show().expect("show");

    // Library, light, 1100 px, list only.
    w.invoke_set_dark(false);
    shot(&win, 1100, 720, &out, "01-library-light-1100");

    // Detail of the newest event: a failed render with an Arabic title.
    w.invoke_select(0);
    w.invoke_set_dark(true);
    shot(
        &win,
        1100,
        720,
        &out,
        "02-library-dark-detail-failed-arabic",
    );

    // A render that worked, with its thumbnail (light).
    w.invoke_set_dark(false);
    w.invoke_select(1);
    shot(&win, 1100, 720, &out, "03-library-light-detail-ok-thumb");

    // 480 px: list, then the detail replacing it.
    w.invoke_close_detail();
    shot(&win, 480, 720, &out, "04-library-480");
    w.invoke_select(0);
    shot(&win, 480, 720, &out, "05-library-480-detail");
    w.invoke_close_detail();

    // Filters and search: failed Arabic renders only.
    w.invoke_toggle_failed();
    w.invoke_toggle_kind(2);
    ui.set_search("عرض");
    shot(&win, 1100, 720, &out, "06-library-filtered-arabic");
    ui.set_search("");
    w.invoke_toggle_failed();
    w.invoke_toggle_kind(2);

    // Scrolled far down the list.
    // The list measures itself while it is drawn: draw once before scrolling.
    render(&win, 1100, 520);
    w.invoke_scroll_library_to(20);
    shot(&win, 1100, 520, &out, "07-library-scrolled");
    w.invoke_scroll_library_to(0);

    // Live with two jobs.
    w.invoke_show_tab(1);
    shot(&win, 1100, 720, &out, "08-live-2-jobs");
    w.invoke_set_dark(true);
    shot(&win, 700, 560, &out, "09-live-dark-700");

    // Voices: ElevenLabs from the environment, Gemini without a key; then both saved.
    w.invoke_set_dark(false);
    w.invoke_show_tab(2);
    shot(&win, 1000, 900, &out, "10-voices-env-none");
    std::fs::write(
        work.join("bin").join("status.json"),
        r#"{"elevenlabs":"file","gemini":"file"}"#,
    )
    .unwrap();
    ui.reload_providers();
    shot(&win, 1000, 900, &out, "11-voices-saved");

    // Stats.
    w.invoke_show_tab(3);
    shot(&win, 1000, 800, &out, "12-stats");
    w.invoke_set_dark(true);
    shot(&win, 1000, 800, &out, "13-stats-dark");
    let _ = model::PAGE;
}
