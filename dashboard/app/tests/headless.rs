//! The window glue against a headless Slint platform and fixture data. One test function: a
//! process may set the platform once.

use screenpilot_dashboard::{app, fixture};
use slint::platform::software_renderer::MinimalSoftwareWindow;
use slint::platform::{Platform, WindowAdapter};
use slint::{ComponentHandle, Model};
use std::rc::Rc;

struct Headless(Rc<MinimalSoftwareWindow>);

impl Platform for Headless {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, slint::PlatformError> {
        Ok(self.0.clone())
    }
}

#[test]
fn window_follows_the_history_filters_and_tabs() {
    let dir = std::env::temp_dir().join(format!("sp-headless-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let fx = fixture::write(&dir, 120, now, r#"{"elevenlabs":"env","gemini":null}"#).unwrap();
    fixture::write_jobs(&fx.paths, now).unwrap();

    let win = MinimalSoftwareWindow::new(
        slint::platform::software_renderer::RepaintBufferType::NewBuffer,
    );
    slint::platform::set_platform(Box::new(Headless(win))).unwrap();
    let ui = app::build_inline(fx.paths.clone(), fx.cli.clone());
    let w = ui.window.clone_strong();
    w.show().unwrap();

    // First page: 50 of 120, more to load; the newest is the failed Arabic render.
    assert_eq!(w.get_rows().row_count(), 50);
    assert!(w.get_can_load_more());
    assert_eq!(w.get_count_text().as_str(), "50 loaded+");
    let first = w.get_rows().row_data(0).unwrap();
    assert_eq!(first.title.as_str(), "عرض المنتج-0");
    assert!(first.failed && first.title_rtl && first.error_rtl);

    // Paging to the end.
    w.invoke_load_more();
    w.invoke_load_more();
    assert_eq!(w.get_rows().row_count(), 120);
    assert!(!w.get_can_load_more());
    assert_eq!(w.get_count_text().as_str(), "120 loaded");

    // Filters and search.
    w.invoke_toggle_failed();
    let failed = w.get_rows().row_count();
    assert!(failed > 1 && failed < 120);
    assert!((0..failed).all(|i| w.get_rows().row_data(i).unwrap().failed));
    w.invoke_toggle_failed();
    assert_eq!(w.get_rows().row_count(), 120);
    ui.set_search("عرض");
    let arabic = w.get_rows().row_count();
    assert!(arabic > 0 && arabic < 120);
    ui.set_search("zzz-no-such-title");
    assert_eq!(w.get_rows().row_count(), 0);
    assert_eq!(w.get_empty_title().as_str(), "No matches");
    ui.set_search("");

    // Detail of the failed Arabic render, then closed.
    w.invoke_select(0);
    assert!(w.get_detail_open());
    assert_eq!(w.get_detail_title().as_str(), "عرض المنتج-0");
    assert_eq!(
        w.get_detail_error().as_str(),
        "فشل التصيير: لم يتم العثور على ملف المصدر"
    );
    assert!(w.get_detail_can_render());
    assert!(!w.get_detail_has_output());
    assert!(w.get_detail_narration().row_count() >= 4);
    assert_eq!(w.get_selected(), 0);
    w.invoke_close_detail();
    assert!(!w.get_detail_open());
    assert_eq!(w.get_selected(), -1);

    // Tabs: live jobs, voices, stats.
    assert_eq!(w.get_live_count(), 2);
    w.invoke_show_tab(1);
    assert_eq!(w.get_jobs().row_count(), 2);
    w.invoke_show_tab(2);
    assert_eq!(w.get_providers().row_count(), 5);
    let eleven = w.get_providers().row_data(3).unwrap();
    assert_eq!(eleven.key_state, 2);
    assert!(!eleven.can_edit && eleven.env_note);
    let gemini = w.get_providers().row_data(4).unwrap();
    assert_eq!(gemini.key_state, 1);
    assert!(gemini.can_edit && !gemini.can_remove);
    // Base URLs from the stand-in `endpoint status`: a saved ElevenLabs one, a read-only Gemini one.
    assert!(eleven.has_endpoint && eleven.endpoint_regions && eleven.endpoint_can_reset);
    assert_eq!(
        eleven.endpoint_url.as_str(),
        "https://api.eu.residency.elevenlabs.io"
    );
    assert_eq!(eleven.endpoint_source.as_str(), "Saved in voices.json");
    assert!(gemini.has_endpoint && gemini.endpoint_env && !gemini.endpoint_can_reset);
    assert!(!w.get_providers().row_data(0).unwrap().has_endpoint);
    w.invoke_show_tab(3);
    assert_eq!(w.get_history_count().as_str(), "120");
    assert_eq!(w.get_speed().row_count(), 3);
    assert_eq!(w.get_cache_text().as_str(), "37 MB");
    let _ = std::fs::remove_dir_all(&dir);
}
