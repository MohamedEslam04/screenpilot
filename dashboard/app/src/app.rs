//! Glue between the Slint window and `screenpilot-dashboard-core`.
//!
//! The UI thread never blocks: every file read, spawn and decode runs on a worker thread that
//! returns a `Msg`, which is handled back on the UI thread (`post`). `build_inline` runs the
//! workers on the calling thread instead (headless screenshots, tests).

use crate::model::{self, Detail, Event, Filter, History, JobRow, ProviderView, PAGE};
use crate::{JobData, KvData, MainWindow, NarData, ProviderData, RowData, SpeedData};
use screenpilot_dashboard_core as sp;
use slint::{ComponentHandle, Model, ModelRc, SharedString, Timer, TimerMode, VecModel};
use sp::cli::Cli;
use sp::jobs::JobInfo;
use sp::project::Project;
use sp::providers::ProviderInfo;
use sp::stats::Stats;
use sp::Paths;
use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SEARCH_DEBOUNCE: Duration = Duration::from_millis(120);
const JOBS_DEBOUNCE: Duration = Duration::from_millis(250);
const TOAST_FOR: Duration = Duration::from_millis(3200);

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Results of worker threads, handled on the UI thread.
enum Msg {
    Page(Vec<serde_json::Value>),
    Head(Vec<serde_json::Value>),
    Project {
        tok: u64,
        result: Result<Project, String>,
    },
    Thumb {
        tok: u64,
        rgb: Option<(u32, u32, Vec<u8>)>,
    },
    JobsChanged,
    Jobs(Vec<JobInfo>),
    Providers(Vec<ProviderInfo>),
    Stats(Stats),
    Cache(u64),
    Toast(String),
    /// A key or base URL was saved or removed: show the message and the providers as they are now.
    KeyDone {
        toast: String,
        providers: Option<Vec<ProviderInfo>>,
    },
}

thread_local! {
    /// The app of the UI thread, for `post`.
    static APP: RefCell<Option<Rc<App>>> = const { RefCell::new(None) };
}

/// Hand a result to the UI thread.
fn post(msg: Msg) {
    let _ = slint::invoke_from_event_loop(move || {
        let app = APP.with(|a| a.borrow().clone());
        if let Some(app) = app {
            app.handle(msg);
        }
    });
}

struct State {
    history: History,
    row_data: Vec<RowData>,
    filter: Filter,
    /// Event index of the open row.
    selected: Option<usize>,
    detail: Option<Detail>,
    detail_event: Option<Event>,
    detail_tok: u64,
    jobs: Vec<JobRow>,
    jobs_dirty: bool,
    providers_loaded: bool,
    stats_loaded: bool,
    watcher: Option<notify::RecommendedWatcher>,
    search_timer: Timer,
    tick_timer: Timer,
    toast_timer: Timer,
}

pub struct App {
    me: std::rc::Weak<App>,
    win: MainWindow,
    paths: Paths,
    cli: Cli,
    inline: bool,
    rows: Rc<VecModel<RowData>>,
    jobs_model: Rc<VecModel<JobData>>,
    st: RefCell<State>,
}

/// What `build` returns: the window and what drives it.
pub struct UiHandle {
    pub window: MainWindow,
    app: Rc<App>,
}

impl UiHandle {
    /// Show the window and run until it closes.
    pub fn run(&self) -> Result<(), slint::PlatformError> {
        self.window.run()
    }

    /// Watch `<cache>/jobs/` (the real app does this; headless runs do not).
    pub fn start_watcher(&self) {
        self.app.start_watcher();
    }

    /// Read the voice providers again (after the key state changed outside the window).
    pub fn reload_providers(&self) {
        self.app.load_providers();
    }

    /// Apply the filters and search now (headless runs have no debounce timer).
    pub fn set_search(&self, text: &str) {
        self.window.set_search_text(text.into());
        self.app.search_edited(text);
    }
}

/// Build the window with workers on threads.
pub fn build(paths: Paths, cli: Cli) -> UiHandle {
    App::create(paths, cli, false)
}

/// Build the window with every worker run on the calling thread, for headless runs.
pub fn build_inline(paths: Paths, cli: Cli) -> UiHandle {
    App::create(paths, cli, true)
}

/// Open the dashboard and run until the window closes (or `exit_after` has passed).
pub fn run(
    paths: Paths,
    cli: Cli,
    exit_after: Option<Duration>,
) -> Result<(), slint::PlatformError> {
    let ui = build(paths, cli);
    ui.start_watcher();
    if let Some(after) = exit_after {
        Timer::single_shot(after, || {
            let _ = slint::quit_event_loop();
        });
    }
    ui.run()
}

fn shared(s: &str) -> SharedString {
    s.into()
}

fn row_data(r: &model::Row) -> RowData {
    RowData {
        idx: r.idx as i32,
        kind: model::kind_index(&r.kind) as i32,
        failed: r.failed,
        title: shared(&r.title),
        title_rtl: r.title_rtl,
        sub: shared(&r.sub),
        error: shared(&r.error),
        error_rtl: r.error_rtl,
        quality: shared(&r.quality),
        when: shared(&r.when),
        aria: shared(&r.aria),
    }
}

fn kv_model(items: &[model::Kv]) -> ModelRc<KvData> {
    ModelRc::new(VecModel::from(
        items
            .iter()
            .map(|k| KvData {
                key: shared(&k.key),
                value: shared(&k.value),
                mono: k.mono,
            })
            .collect::<Vec<_>>(),
    ))
}

fn nar_model(items: &[model::NarLine]) -> ModelRc<NarData> {
    ModelRc::new(VecModel::from(
        items
            .iter()
            .map(|n| NarData {
                clock: shared(&n.clock),
                text: shared(&n.text),
                rtl: n.rtl,
            })
            .collect::<Vec<_>>(),
    ))
}

fn job_data(j: &JobRow, now: i64) -> JobData {
    JobData {
        id: shared(&j.id),
        title: shared(&j.title),
        title_rtl: j.title_rtl,
        kind: shared(&j.kind),
        quality: shared(&j.quality),
        path_line: shared(&j.path_line),
        label: shared(&j.label),
        count: shared(&j.count),
        progress: j.progress.unwrap_or(-1.0),
        elapsed: shared(&model::elapsed_text(j.started, now)),
    }
}

fn provider_data(p: &ProviderView) -> ProviderData {
    ProviderData {
        id: shared(&p.id),
        label: shared(&p.label),
        status: shared(&p.status),
        note: shared(&p.note),
        key_state: match p.key {
            model::KeyState::NotNeeded => 0,
            model::KeyState::Missing => 1,
            model::KeyState::Env => 2,
            model::KeyState::File => 3,
        },
        env_note: p.env_note,
        can_edit: p.can_edit,
        can_remove: p.can_remove,
        cli_line: shared(&p.cli_line),
        has_endpoint: p.has_endpoint,
        endpoint_url: shared(&p.endpoint_url),
        endpoint_source: shared(&p.endpoint_source),
        endpoint_error: shared(&p.endpoint_error),
        endpoint_env: p.endpoint_env,
        endpoint_can_reset: p.endpoint_can_reset,
        endpoint_regions: p.endpoint_regions,
        endpoint_default: shared(&p.endpoint_default),
    }
}

/// A thumbnail JPG as RGB bytes. Runs on a worker thread.
pub fn decode_jpeg(path: &Path) -> Option<(u32, u32, Vec<u8>)> {
    let file = std::fs::File::open(path).ok()?;
    let mut dec = jpeg_decoder::Decoder::new(std::io::BufReader::new(file));
    let pixels = dec.decode().ok()?;
    let info = dec.info()?;
    let (w, h) = (u32::from(info.width), u32::from(info.height));
    let rgb = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|&g| [g, g, g]).collect(),
        _ => return None,
    };
    (rgb.len() == (w * h * 3) as usize).then_some((w, h, rgb))
}

impl App {
    fn create(paths: Paths, cli: Cli, inline: bool) -> UiHandle {
        let win = MainWindow::new().expect("create the window");
        let rows = Rc::new(VecModel::<RowData>::default());
        let jobs_model = Rc::new(VecModel::<JobData>::default());
        win.set_rows(ModelRc::from(rows.clone()));
        win.set_jobs(ModelRc::from(jobs_model.clone()));
        win.set_kinds(ModelRc::new(VecModel::from(vec![false; 4])));
        win.set_env_key_note(shared(model::ENV_KEY_NOTE));
        win.set_cli_key_note(shared(model::CLI_KEY_NOTE));
        win.set_env_url_note(shared(model::ENV_URL_NOTE));
        win.set_url_help(shared(model::URL_HELP));
        win.set_privacy_note(shared(model::PRIVACY_NOTE));
        win.set_no_speed_note(shared(model::NO_SPEED_NOTE));

        let app = Rc::new_cyclic(|me| App {
            me: me.clone(),
            win: win.clone_strong(),
            paths,
            cli,
            inline,
            rows,
            jobs_model,
            st: RefCell::new(State {
                history: History::default(),
                row_data: Vec::new(),
                filter: Filter::default(),
                selected: None,
                detail: None,
                detail_event: None,
                detail_tok: 0,
                jobs: Vec::new(),
                jobs_dirty: false,
                providers_loaded: false,
                stats_loaded: false,
                watcher: None,
                search_timer: Timer::default(),
                tick_timer: Timer::default(),
                toast_timer: Timer::default(),
            }),
        });
        app.wire();
        APP.with(|a| *a.borrow_mut() = Some(app.clone()));

        app.load_more();
        app.read_jobs();
        UiHandle { window: win, app }
    }

    fn wire(self: &Rc<Self>) {
        let w = &self.win;
        macro_rules! on {
            ($setter:ident, |$app:ident $(, $arg:ident)*| $body:expr) => {{
                let weak = Rc::downgrade(self);
                w.$setter(move |$($arg),*| {
                    if let Some($app) = weak.upgrade() {
                        $body
                    }
                });
            }};
        }
        on!(on_show_tab, |app, n| app.show_tab(n));
        on!(on_select, |app, i| app.select(i));
        on!(on_close_detail, |app| app.close_detail());
        on!(on_open_video, |app| app.open_video());
        on!(on_show_folder, |app| app.show_folder());
        on!(on_render, |app, q| app.render(q.as_str()));
        on!(on_load_more, |app| app.load_more());
        on!(on_search_edited, |app, t| app.search_edited(t.as_str()));
        on!(on_toggle_kind, |app, i| app.toggle_kind(i));
        on!(on_toggle_failed, |app| app.toggle_failed());
        on!(on_save_key, |app, id, key| app
            .save_key(id.as_str(), key.as_str()));
        on!(on_remove_key, |app, id| app.remove_key(id.as_str()));
        on!(on_save_endpoint, |app, id, url| app
            .save_endpoint(id.as_str(), url.as_str()));
        on!(on_reset_endpoint, |app, id| app.reset_endpoint(id.as_str()));
        on!(on_calc_cache, |app| app.calc_cache());
    }

    /// Run `work` on a worker thread and handle its message on the UI thread.
    fn spawn(&self, work: impl FnOnce() -> Msg + Send + 'static) {
        if self.inline {
            let msg = work();
            self.handle(msg);
        } else {
            std::thread::spawn(move || post(work()));
        }
    }

    fn shown(&self) -> bool {
        let w = self.win.window();
        w.is_visible() && !w.is_minimized()
    }

    fn handle(&self, msg: Msg) {
        match msg {
            Msg::Page(page) => self.on_page(&page),
            Msg::Head(page) => self.on_head(&page),
            Msg::Project { tok, result } => {
                if tok != self.st.borrow().detail_tok {
                    return;
                }
                let ev = self.st.borrow().detail_event.clone();
                if let Some(ev) = ev {
                    let d = match &result {
                        Ok(p) => model::build_detail(&ev, Some(p), None),
                        Err(e) => model::build_detail(&ev, None, Some(e)),
                    };
                    self.apply_detail(&d, false);
                    self.st.borrow_mut().detail = Some(d);
                }
            }
            Msg::Thumb { tok, rgb } => {
                if tok != self.st.borrow().detail_tok {
                    return;
                }
                if let Some((w, h, bytes)) = rgb {
                    let buf = slint::SharedPixelBuffer::<slint::Rgb8Pixel>::clone_from_slice(
                        &bytes, w, h,
                    );
                    self.win.set_detail_thumb(slint::Image::from_rgb8(buf));
                    self.win.set_detail_has_thumb(true);
                }
            }
            Msg::JobsChanged => {
                if self.shown() {
                    self.read_jobs();
                } else {
                    self.st.borrow_mut().jobs_dirty = true;
                }
            }
            Msg::Jobs(jobs) => self.on_jobs(&jobs),
            Msg::Providers(list) => self.set_providers(&list),
            Msg::Stats(s) => {
                self.win
                    .set_history_count(shared(&model::group_digits(s.history_count)));
                self.win.set_speed(ModelRc::new(VecModel::from(
                    model::speed_rows(&s.speed)
                        .iter()
                        .map(|r| SpeedData {
                            quality: shared(&r.quality),
                            ratio: shared(&r.ratio),
                            detail: shared(&r.detail),
                            fraction: r.fraction,
                        })
                        .collect::<Vec<_>>(),
                )));
            }
            Msg::Cache(n) => {
                self.win.set_cache_text(shared(&model::bytes(n)));
                self.win.set_cache_busy(false);
            }
            Msg::Toast(t) => self.toast(&t),
            Msg::KeyDone { toast, providers } => {
                if let Some(list) = providers {
                    self.set_providers(&list);
                }
                self.toast(&toast);
            }
        }
    }

    // ----- library ---------------------------------------------------------------------

    fn load_more(&self) {
        {
            let mut st = self.st.borrow_mut();
            if st.history.loading || st.history.exhausted {
                return;
            }
            st.history.loading = true;
        }
        self.sync_list_texts();
        let file = self.paths.history_file();
        let before = self.st.borrow().history.cursor().map(str::to_string);
        self.spawn(move || Msg::Page(sp::history::list_history(&file, before.as_deref(), PAGE)));
    }

    fn on_page(&self, page: &[serde_json::Value]) {
        let first_new;
        {
            let mut st = self.st.borrow_mut();
            st.history.loading = false;
            first_new = st.history.rows.len();
            st.history.append_page(page, PAGE, now());
            let new: Vec<RowData> = st.history.rows[first_new..].iter().map(row_data).collect();
            st.row_data.extend(new);
            // Append the new rows that pass the filter without resetting the list's scroll.
            for i in first_new..st.history.rows.len() {
                if st.filter.matches(&st.history.rows[i]) {
                    self.rows.push(st.row_data[i].clone());
                }
            }
        }
        if first_new == 0 && self.win.get_current() < 0 && self.rows.row_count() > 0 {
            self.win.set_current(0);
        }
        self.sync_list_texts();
    }

    fn on_head(&self, page: &[serde_json::Value]) {
        let added = self.st.borrow_mut().history.prepend_fresh(page, now());
        if added == 0 {
            return;
        }
        {
            let mut st = self.st.borrow_mut();
            st.row_data = st.history.rows.iter().map(row_data).collect();
            if let Some(sel) = st.selected.as_mut() {
                *sel += added;
            }
        }
        self.refilter(false);
    }

    /// Rebuild the list from the filter. `to_top` resets the scroll and the cursor.
    fn refilter(&self, to_top: bool) {
        let (items, selected) = {
            let st = self.st.borrow();
            let items: Vec<RowData> = st
                .history
                .rows
                .iter()
                .zip(&st.row_data)
                .filter(|(r, _)| st.filter.matches(r))
                .map(|(_, d)| d.clone())
                .collect();
            let selected = st
                .selected
                .and_then(|s| items.iter().position(|d| d.idx as usize == s));
            (items, selected)
        };
        let n = items.len();
        self.rows.set_vec(items);
        self.win.set_selected(selected.map_or(-1, |p| p as i32));
        if to_top {
            self.win.set_current(if n > 0 { 0 } else { -1 });
            self.win.invoke_scroll_library_to(0);
        } else if self.win.get_current() >= n as i32 {
            self.win.set_current(n as i32 - 1);
        }
        self.sync_list_texts();
    }

    fn sync_list_texts(&self) {
        let st = self.st.borrow();
        let (loaded, shown) = (st.history.rows.len(), self.rows.row_count());
        let (ex, ld) = (st.history.exhausted, st.history.loading);
        self.win
            .set_count_text(shared(&model::count_text(loaded, shown, ex, ld)));
        let (t, h) = model::empty_state(loaded, shown, ex, ld).unwrap_or_default();
        self.win.set_empty_title(shared(&t));
        self.win.set_empty_hint(shared(&h));
        self.win.set_can_load_more(!ex);
        self.win.set_history_loading(ld);
    }

    fn search_edited(&self, text: &str) {
        let text = text.to_string();
        let me = self.me.clone();
        let apply = move || {
            if let Some(app) = me.upgrade() {
                app.st.borrow_mut().filter.set_query(&text);
                app.refilter(true);
            }
        };
        if self.inline {
            apply();
        } else {
            self.st
                .borrow()
                .search_timer
                .start(TimerMode::SingleShot, SEARCH_DEBOUNCE, apply);
        }
    }

    fn toggle_kind(&self, i: i32) {
        let Some(i) = usize::try_from(i).ok().filter(|i| *i < 4) else {
            return;
        };
        let on = {
            let mut st = self.st.borrow_mut();
            st.filter.kinds[i] = !st.filter.kinds[i];
            st.filter.kinds
        };
        self.win
            .set_kinds(ModelRc::new(VecModel::from(on.to_vec())));
        self.refilter(true);
    }

    fn toggle_failed(&self) {
        let on = {
            let mut st = self.st.borrow_mut();
            st.filter.failed = !st.filter.failed;
            st.filter.failed
        };
        self.win.set_failed_only(on);
        self.refilter(true);
    }

    // ----- detail ----------------------------------------------------------------------

    fn select(&self, view_pos: i32) {
        let Some(row) = usize::try_from(view_pos)
            .ok()
            .and_then(|i| self.rows.row_data(i))
        else {
            return;
        };
        let idx = row.idx as usize;
        let (ev, tok) = {
            let mut st = self.st.borrow_mut();
            let Some(ev) = st.history.events.get(idx).cloned() else {
                return;
            };
            st.selected = Some(idx);
            st.detail_tok += 1;
            st.detail_event = Some(ev.clone());
            (ev, st.detail_tok)
        };
        self.win.set_selected(view_pos);
        self.win.set_detail_open(true);
        self.win.set_confirm_delivery(false);
        self.win.set_detail_thumb(slint::Image::default());
        self.win.set_detail_has_thumb(false);
        let d = model::build_detail(&ev, None, None);
        self.apply_detail(&d, true);
        self.st.borrow_mut().detail = Some(d);

        let path = ev.path.clone();
        self.spawn(move || Msg::Project {
            tok,
            result: sp::project::get_project(Path::new(&path)),
        });
        if let Some(video) = ev.output.clone() {
            let cache = self.paths.cache.clone();
            self.spawn(move || {
                let rgb = sp::thumbnail::thumbnail(Path::new(&video), &cache, "ffmpeg")
                    .and_then(|p| decode_jpeg(&p));
                Msg::Thumb { tok, rgb }
            });
        }
    }

    fn apply_detail(&self, d: &Detail, loading: bool) {
        let w = &self.win;
        w.set_detail_title(shared(&d.title));
        w.set_detail_title_rtl(d.title_rtl);
        w.set_detail_error(shared(&d.error));
        w.set_detail_error_rtl(d.error_rtl);
        w.set_detail_project_error(shared(&d.project_error));
        w.set_detail_loading(loading);
        w.set_detail_kv(kv_model(&d.kv));
        w.set_detail_narration(nar_model(&d.narration));
        w.set_detail_parts(nar_model(&d.parts));
        w.set_detail_files(kv_model(&d.files));
        w.set_detail_has_output(d.output.is_some());
        w.set_detail_can_render(d.render_source.is_some());
        w.set_detail_command(shared(&d.command));
    }

    fn close_detail(&self) {
        {
            let mut st = self.st.borrow_mut();
            st.selected = None;
            st.detail = None;
            st.detail_event = None;
            st.detail_tok += 1;
        }
        self.win.set_detail_open(false);
        self.win.set_selected(-1);
        self.win.set_detail_thumb(slint::Image::default());
        self.win.set_detail_has_thumb(false);
        self.win.set_confirm_delivery(false);
    }

    fn open_video(&self) {
        let Some(video) = self
            .st
            .borrow()
            .detail
            .as_ref()
            .and_then(|d| d.output.clone())
        else {
            return;
        };
        self.spawn(
            move || match sp::open::open_path(Path::new(&video), false) {
                Ok(()) => Msg::Toast("Opening video".into()),
                Err(e) => Msg::Toast(e),
            },
        );
    }

    fn show_folder(&self) {
        let Some(target) = self.st.borrow().detail.as_ref().map(|d| d.reveal.clone()) else {
            return;
        };
        self.spawn(
            move || match sp::open::open_path(Path::new(&target), true) {
                Ok(()) => Msg::Toast("Opened folder".into()),
                Err(e) => Msg::Toast(e),
            },
        );
    }

    fn render(&self, quality: &str) {
        let Some(sb) = self
            .st
            .borrow()
            .detail
            .as_ref()
            .and_then(|d| d.render_source.clone())
        else {
            return;
        };
        let cli = self.cli.clone();
        let quality = quality.to_string();
        self.spawn(move || match sp::cli::run_render(&cli, &sb, &quality) {
            Ok(()) => {
                let mut q = quality.clone();
                q[..1].make_ascii_uppercase();
                Msg::Toast(format!("{q} render started. Follow it on the Live tab."))
            }
            Err(e) => Msg::Toast(e),
        });
    }

    // ----- tabs ------------------------------------------------------------------------

    fn show_tab(&self, n: i32) {
        self.win.set_tab(n);
        match n {
            1 => {
                self.read_jobs();
                self.sync_tick();
            }
            2 => {
                let first = !std::mem::replace(&mut self.st.borrow_mut().providers_loaded, true);
                if first {
                    self.load_providers();
                }
            }
            3 => {
                let first = !std::mem::replace(&mut self.st.borrow_mut().stats_loaded, true);
                if first {
                    let (h, s) = (self.paths.history_file(), self.paths.speed_file());
                    self.spawn(move || Msg::Stats(sp::stats::stats(&h, &s)));
                    self.calc_cache();
                }
            }
            _ => {}
        }
        if n != 1 {
            self.st.borrow().tick_timer.stop();
        }
    }

    // ----- live jobs -------------------------------------------------------------------

    fn read_jobs(&self) {
        let dir = self.paths.jobs_dir();
        self.st.borrow_mut().jobs_dirty = false;
        self.spawn(move || Msg::Jobs(sp::jobs::jobs(&dir)));
    }

    fn on_jobs(&self, jobs: &[JobInfo]) {
        let rows: Vec<JobRow> = jobs.iter().map(model::job_row).collect();
        let ended = {
            let mut st = self.st.borrow_mut();
            let ended = st
                .jobs
                .iter()
                .any(|old| !rows.iter().any(|new| new.id == old.id));
            st.jobs = rows;
            ended
        };
        let t = now();
        let data: Vec<JobData> = self
            .st
            .borrow()
            .jobs
            .iter()
            .map(|j| job_data(j, t))
            .collect();
        self.win.set_live_count(data.len() as i32);
        self.jobs_model.set_vec(data);
        self.sync_tick();
        if ended {
            // A render finished: its history entry is new.
            let file = self.paths.history_file();
            self.spawn(move || Msg::Head(sp::history::list_history(&file, None, PAGE)));
        }
    }

    /// The elapsed-time clock runs only while the Live tab shows jobs in a visible window.
    fn sync_tick(&self) {
        let st = self.st.borrow();
        if self.inline || self.win.get_tab() != 1 || st.jobs.is_empty() {
            st.tick_timer.stop();
            return;
        }
        if st.tick_timer.running() {
            return;
        }
        let me = self.me.clone();
        st.tick_timer
            .start(TimerMode::Repeated, Duration::from_secs(1), move || {
                if let Some(app) = me.upgrade() {
                    app.tick();
                }
            });
    }

    fn tick(&self) {
        if !self.shown() {
            self.st.borrow().tick_timer.stop();
            return;
        }
        let t = now();
        for (i, j) in self.st.borrow().jobs.iter().enumerate() {
            if let Some(mut d) = self.jobs_model.row_data(i) {
                d.elapsed = shared(&model::elapsed_text(j.started, t));
                self.jobs_model.set_row_data(i, d);
            }
        }
    }

    /// A file watcher on the jobs folder; its events are debounced and only read the folder when
    /// the window is shown. No polling.
    fn start_watcher(&self) {
        use notify::{RecursiveMode, Watcher};
        if self.st.borrow().watcher.is_some() {
            return;
        }
        let dir = self.paths.jobs_dir();
        let _ = std::fs::create_dir_all(&dir);
        let (tx, rx) = mpsc::channel::<()>();
        let Ok(mut watcher) =
            notify::recommended_watcher(move |_e: notify::Result<notify::Event>| {
                let _ = tx.send(());
            })
        else {
            return;
        };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        // The thread ends when the watcher is dropped: that drops the only sender.
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                let deadline = Instant::now() + JOBS_DEBOUNCE;
                loop {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(left) {
                        Ok(()) => {}
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                post(Msg::JobsChanged);
            }
        });
        self.st.borrow_mut().watcher = Some(watcher);
    }

    // ----- voices ----------------------------------------------------------------------

    fn load_providers(&self) {
        let cli = self.cli.clone();
        self.spawn(move || Msg::Providers(sp::cli::providers(&cli)));
    }

    fn set_providers(&self, list: &[ProviderInfo]) {
        self.win.set_providers_error(shared(""));
        self.win.set_providers(ModelRc::new(VecModel::from(
            list.iter()
                .map(|p| provider_data(&model::provider_view(p)))
                .collect::<Vec<_>>(),
        )));
    }

    fn save_key(&self, id: &str, key: &str) {
        if key.trim().is_empty() {
            return;
        }
        let (cli, id, key) = (self.cli.clone(), id.to_string(), key.to_string());
        self.spawn(move || match sp::cli::set_secret(&cli, &id, &key) {
            Ok(()) => Msg::KeyDone {
                toast: format!("{} key saved", label_of(&id)),
                providers: Some(sp::cli::providers(&cli)),
            },
            Err(e) => Msg::Toast(e),
        });
    }

    fn remove_key(&self, id: &str) {
        let (cli, id) = (self.cli.clone(), id.to_string());
        self.spawn(move || match sp::cli::remove_secret(&cli, &id) {
            Ok(_) => Msg::KeyDone {
                toast: format!("{} key removed", label_of(&id)),
                providers: Some(sp::cli::providers(&cli)),
            },
            Err(e) => Msg::Toast(e),
        });
    }

    fn save_endpoint(&self, id: &str, url: &str) {
        let url = match sp::cli::check_endpoint_value(url) {
            Ok(url) => url,
            Err(e) => return self.toast(&e),
        };
        let (cli, id) = (self.cli.clone(), id.to_string());
        self.spawn(move || match sp::cli::set_endpoint(&cli, &id, &url) {
            Ok(saved) => Msg::KeyDone {
                toast: format!("{} base URL saved: {saved}", label_of(&id)),
                providers: Some(sp::cli::providers(&cli)),
            },
            Err(e) => Msg::Toast(e),
        });
    }

    fn reset_endpoint(&self, id: &str) {
        let (cli, id) = (self.cli.clone(), id.to_string());
        self.spawn(move || match sp::cli::clear_endpoint(&cli, &id) {
            Ok(_) => Msg::KeyDone {
                toast: format!("{} base URL reset to the default", label_of(&id)),
                providers: Some(sp::cli::providers(&cli)),
            },
            Err(e) => Msg::Toast(e),
        });
    }

    // ----- stats -----------------------------------------------------------------------

    fn calc_cache(&self) {
        self.win.set_cache_busy(true);
        self.win.set_cache_text(shared("calculating\u{2026}"));
        let dir = self.paths.extract_cache.clone();
        self.spawn(move || Msg::Cache(sp::cache::cache_size(&dir)));
    }

    // ----- toast -----------------------------------------------------------------------

    fn toast(&self, text: &str) {
        self.win.set_toast_text(shared(text));
        self.win.set_toast_visible(true);
        if self.inline {
            return;
        }
        let weak = self.win.as_weak();
        self.st
            .borrow()
            .toast_timer
            .start(TimerMode::SingleShot, TOAST_FOR, move || {
                if let Some(w) = weak.upgrade() {
                    w.set_toast_visible(false);
                }
            });
    }
}

fn label_of(id: &str) -> String {
    match id {
        "elevenlabs" => "ElevenLabs".into(),
        "gemini" => "Gemini".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::decode_jpeg;

    #[test]
    fn decodes_a_jpg_made_by_ffmpeg_and_rejects_garbage() {
        let dir = std::env::temp_dir().join(format!("sp-jpeg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("bad.jpg");
        std::fs::write(&bad, b"not a jpeg").unwrap();
        assert!(decode_jpeg(&bad).is_none());
        assert!(decode_jpeg(&dir.join("missing.jpg")).is_none());

        let good = dir.join("good.jpg");
        let made = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x36:rate=1",
            ])
            .args(["-frames:v", "1"])
            .arg(&good)
            .status()
            .is_ok_and(|s| s.success());
        if made {
            let (w, h, rgb) = decode_jpeg(&good).expect("decodes");
            assert_eq!((w, h), (64, 36));
            assert_eq!(rgb.len(), 64 * 36 * 3);
        } else {
            eprintln!("ffmpeg not installed: skipped the positive case");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
