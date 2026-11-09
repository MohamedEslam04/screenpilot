//! View-models of the dashboard: plain Rust, no Slint types, so every wording and rule is
//! unit-tested. `app.rs` only copies these into the Slint structs. Wording follows the old
//! webview UI (`ui/util.js`, `ui/app.js`, `ui/panels.js`).

use screenpilot_dashboard_core::jobs::{parse_iso_secs, JobInfo, Step};
use screenpilot_dashboard_core::project::Project;
use screenpilot_dashboard_core::providers::ProviderInfo;
use screenpilot_dashboard_core::stats::SpeedStat;
use serde_json::Value;

/// Rows per `list_history` page.
pub const PAGE: usize = 50;

/// How many narration lines the detail panel lists (as the old UI).
pub const MAX_NARRATION: usize = 300;

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

/// True when the first strong character of `text` is from a right-to-left script (Hebrew,
/// Arabic, Syriac, Thaana, NKo and the Arabic presentation forms). Digits and punctuation are
/// neutral. This picks the alignment of a title in its own cell.
pub fn is_rtl(text: &str) -> bool {
    for c in text.chars() {
        let u = c as u32;
        if (0x0590..=0x08FF).contains(&u)
            || (0xFB1D..=0xFDFF).contains(&u)
            || (0xFE70..=0xFEFF).contains(&u)
        {
            return true;
        }
        if c.is_alphabetic() {
            return false;
        }
    }
    false
}

pub fn basename(p: &str) -> &str {
    p.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
}

fn parent_name(p: &str) -> &str {
    let trimmed = p.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(i) => basename(&trimmed[..i]),
        None => "",
    }
}

/// Display title of a path: the file name of a storyboard or sequence, the folder name for
/// `storyboard.json` / `sequence.json`, the folder name for a session directory.
pub fn title_of(path: &str) -> String {
    let b = basename(path);
    let lower = b.to_ascii_lowercase();
    if lower == "storyboard.json" || lower == "sequence.json" {
        let parent = parent_name(path);
        return if parent.is_empty() { b } else { parent }.to_string();
    }
    let stem = match b.len().checked_sub(5) {
        Some(i) if b.is_char_boundary(i) && b[i..].eq_ignore_ascii_case(".json") => &b[..i],
        _ => b,
    };
    if stem.is_empty() { path } else { stem }.to_string()
}

/// `45 s`, `1:33`, `1:02:03`; empty for a missing or non-finite value.
pub fn fmt_dur(s: Option<f64>) -> String {
    let Some(s) = s.filter(|s| s.is_finite()) else {
        return String::new();
    };
    let s = s.round().max(0.0) as u64;
    if s < 60 {
        return format!("{s} s");
    }
    let (m, r) = (s / 60, s % 60);
    if m < 60 {
        format!("{m}:{r:02}")
    } else {
        format!("{}:{:02}:{r:02}", m / 60, m % 60)
    }
}

/// `m:ss` (elapsed time, narration times).
pub fn fmt_clock(s: f64) -> String {
    let s = if s.is_finite() {
        s.round().max(0.0) as u64
    } else {
        0
    };
    format!("{}:{:02}", s / 60, s % 60)
}

/// `42 s`, `1 min 48 s`.
pub fn fmt_wall(s: Option<f64>) -> String {
    let Some(s) = s.filter(|s| s.is_finite()) else {
        return String::new();
    };
    let s = s.round().max(0.0) as u64;
    if s < 60 {
        format!("{s} s")
    } else {
        format!("{} min {:02} s", s / 60, s % 60)
    }
}

/// `3 min ago` style; `just now` under 45 s; a date after two weeks. `now` is epoch seconds.
pub fn rel(iso: &str, now: i64) -> String {
    let Some(t) = parse_iso_secs(iso) else {
        return String::new();
    };
    let d = (now - t) as f64;
    if d < 45.0 {
        "just now".into()
    } else if d < 3600.0 {
        format!("{} min ago", (d / 60.0).round())
    } else if d < 86400.0 {
        format!("{} h ago", (d / 3600.0).round())
    } else if d < 14.0 * 86400.0 {
        format!("{} d ago", (d / 86400.0).round())
    } else {
        let (y, m, day) = civil_from_days(t.div_euclid(86400));
        const MONTHS: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        format!("{} {day}, {y}", MONTHS[(m - 1) as usize])
    }
}

/// (year, month 1..=12, day) of a day count since 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-11-09T12:30:45.000Z` for epoch seconds (what the CLI writes to the history).
pub fn iso_from_secs(t: i64) -> String {
    let (y, m, d) = civil_from_days(t.div_euclid(86400));
    let rem = t.rem_euclid(86400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// `2026-11-09 12:30 UTC` (the history stores UTC; no time zone data is shipped).
pub fn fmt_date(iso: &str) -> String {
    if parse_iso_secs(iso).is_none() {
        return String::new();
    }
    format!("{} {} UTC", &iso[..10], &iso[11..16])
}

/// `1.5 MB` (binary units, like the old UI).
pub fn bytes(n: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else if v < 10.0 {
        format!("{v:.1} {}", U[i])
    } else {
        format!("{v:.0} {}", U[i])
    }
}

pub fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// Shell-quote one argument for the "Copy command" line (bash-like).
pub fn shell_quote(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./\\-".contains(c));
    if plain {
        return s.to_string();
    }
    let mut out = String::from("\"");
    for c in s.chars() {
        if matches!(c, '"' | '\\' | '$' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

// ---------------------------------------------------------------------------------------------
// History events and library rows
// ---------------------------------------------------------------------------------------------

/// Kinds that have their own icon and filter chip, in chip order.
pub const KINDS: [&str; 4] = ["record", "take", "render", "sequence"];

pub fn kind_index(kind: &str) -> usize {
    KINDS.iter().position(|k| *k == kind).unwrap_or(KINDS.len())
}

pub fn kind_label(kind: &str) -> String {
    match kind {
        "record" => "Record".into(),
        "take" => "Take".into(),
        "render" => "Render".into(),
        "sequence" => "Sequence".into(),
        other => other.to_string(),
    }
}

/// One `history.jsonl` line, with only the fields the dashboard uses.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub at: String,
    pub kind: String,
    pub failed: bool,
    pub path: String,
    pub storyboard: Option<String>,
    pub output: Option<String>,
    pub duration_sec: Option<f64>,
    pub quality: Option<String>,
    pub wall_seconds: Option<f64>,
    pub error: Option<String>,
    pub imported: bool,
}

impl Event {
    /// None unless `at`, `path` and `kind` are strings (core already drops such lines).
    pub fn from_value(v: &Value) -> Option<Event> {
        let s = |k: &str| v.get(k).and_then(Value::as_str);
        let owned = |k: &str| s(k).filter(|x| !x.is_empty()).map(str::to_string);
        let num = |k: &str| v.get(k).and_then(Value::as_f64).filter(|n| n.is_finite());
        Some(Event {
            at: s("at")?.to_string(),
            kind: s("kind")?.to_string(),
            failed: s("status") == Some("failed"),
            path: s("path")?.to_string(),
            storyboard: owned("storyboard"),
            output: owned("output"),
            duration_sec: num("durationSec"),
            quality: owned("quality"),
            wall_seconds: num("wallSeconds"),
            error: owned("error"),
            imported: v.get("imported").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    /// The path the title comes from (`path`, as the old UI did).
    pub fn title(&self) -> String {
        let p = if self.path.is_empty() {
            self.storyboard.as_deref().unwrap_or("")
        } else {
            &self.path
        };
        title_of(p)
    }

    /// Storyboard a render can be started from: the render's own, or the one a take wrote.
    pub fn render_source(&self) -> Option<&str> {
        match self.kind.as_str() {
            "render" => Some(&self.path),
            "take" | "record" => self.storyboard.as_deref(),
            _ => None,
        }
    }
}

/// What the Library list shows for one event.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// Index into the loaded events.
    pub idx: usize,
    pub kind: String,
    pub failed: bool,
    pub title: String,
    pub title_rtl: bool,
    pub sub: String,
    /// The failure's error on one line (empty when none).
    pub error: String,
    pub error_rtl: bool,
    pub quality: String,
    pub when: String,
    /// Screen-reader label.
    pub aria: String,
    /// Lower-case text the search box looks in.
    pub search: String,
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The second line of a row: `Render · 1:33 · took 1 min 48 s`, or `Failed` (the error is its own
/// field: it may be in another script and must not mix with this label).
pub fn sub_text(ev: &Event) -> String {
    if ev.failed {
        return "Failed".into();
    }
    let mut parts = vec![kind_label(&ev.kind)];
    if ev.duration_sec.is_some() {
        parts.push(fmt_dur(ev.duration_sec));
    }
    if ev.wall_seconds.is_some() {
        parts.push(format!("took {}", fmt_wall(ev.wall_seconds)));
    }
    if ev.imported {
        parts.push("imported".into());
    }
    parts.join(" \u{b7} ")
}

pub fn build_row(idx: usize, ev: &Event, now: i64) -> Row {
    let title = ev.title();
    let when = rel(&ev.at, now);
    let status = if ev.failed { "failed" } else { "ok" };
    let search = format!(
        "{} {} {} {}",
        title,
        ev.path,
        ev.quality.as_deref().unwrap_or(""),
        ev.error.as_deref().unwrap_or("")
    )
    .to_lowercase();
    let error = if ev.failed {
        one_line(ev.error.as_deref().unwrap_or(""))
    } else {
        String::new()
    };
    Row {
        idx,
        kind: ev.kind.clone(),
        failed: ev.failed,
        error_rtl: is_rtl(&error),
        error,
        title_rtl: is_rtl(&title),
        aria: format!("{} {title}, {status}, {when}", kind_label(&ev.kind)),
        sub: sub_text(ev),
        quality: ev.quality.clone().unwrap_or_default(),
        when,
        title,
        search,
    }
}

/// Kind chips, the failed chip and the search text.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Filter {
    pub kinds: [bool; 4],
    pub failed: bool,
    /// Trimmed and lower-case; empty means no search.
    pub query: String,
}

impl Filter {
    pub fn set_query(&mut self, raw: &str) {
        self.query = raw.trim().to_lowercase();
    }

    pub fn is_active(&self) -> bool {
        self.failed || self.kinds.iter().any(|k| *k) || !self.query.is_empty()
    }

    pub fn matches(&self, row: &Row) -> bool {
        if self.kinds.iter().any(|k| *k) {
            let i = kind_index(&row.kind);
            if i >= KINDS.len() || !self.kinds[i] {
                return false;
            }
        }
        if self.failed && !row.failed {
            return false;
        }
        self.query.is_empty() || row.search.contains(&self.query)
    }
}

/// Positions in `rows` that pass the filter, in order.
pub fn visible(rows: &[Row], filter: &Filter) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(_, r)| filter.matches(r))
        .map(|(i, _)| i)
        .collect()
}

/// The loaded part of the history, newest first, and the paging state.
#[derive(Debug, Default)]
pub struct History {
    pub events: Vec<Event>,
    pub rows: Vec<Row>,
    pub exhausted: bool,
    pub loading: bool,
}

impl History {
    /// `before` argument of the next `list_history` call: the `at` of the last loaded event.
    pub fn cursor(&self) -> Option<&str> {
        self.events.last().map(|e| e.at.as_str())
    }

    /// Add the next (older) page. A short or empty page means there is nothing older.
    pub fn append_page(&mut self, page: &[Value], limit: usize, now: i64) {
        if page.is_empty() {
            self.exhausted = true;
            return;
        }
        if page.len() < limit {
            self.exhausted = true;
        }
        for v in page {
            if let Some(ev) = Event::from_value(v) {
                self.rows.push(build_row(self.events.len(), &ev, now));
                self.events.push(ev);
            }
        }
    }

    /// Put events newer than the newest loaded one in front; returns how many were added.
    /// Row indexes and relative times are rebuilt.
    pub fn prepend_fresh(&mut self, page: &[Value], now: i64) -> usize {
        let top = self.events.first().map(|e| e.at.clone());
        let mut fresh: Vec<Event> = page
            .iter()
            .filter_map(Event::from_value)
            .filter(|e| top.as_deref().is_none_or(|t| e.at.as_str() > t))
            .collect();
        let n = fresh.len();
        if n > 0 {
            fresh.append(&mut self.events);
            self.events = fresh;
            self.rebuild_rows(now);
        }
        n
    }

    /// Recompute every row (relative times go stale).
    pub fn rebuild_rows(&mut self, now: i64) {
        self.rows = self
            .events
            .iter()
            .enumerate()
            .map(|(i, e)| build_row(i, e, now))
            .collect();
    }
}

/// Text under an empty list: (title, hint).
pub fn empty_state(
    loaded: usize,
    shown: usize,
    exhausted: bool,
    loading: bool,
) -> Option<(String, String)> {
    if shown > 0 {
        return None;
    }
    let (t, h) = if loading || (!exhausted && loaded == 0) {
        ("Loading history", "")
    } else if loaded == 0 {
        (
            "Nothing here yet",
            "Recordings, takes and renders appear after you make one with ScreenPilot.",
        )
    } else if exhausted {
        ("No matches", "Try another search or clear the filters.")
    } else {
        (
            "No matches",
            "Nothing matches in the rows loaded so far. Load older rows to search further.",
        )
    };
    Some((t.into(), h.into()))
}

/// `1234567` becomes `1,234,567`.
pub fn group_digits(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `120 of 400 loaded+`.
pub fn count_text(loaded: usize, shown: usize, exhausted: bool, loading: bool) -> String {
    if loading && loaded == 0 {
        return String::new();
    }
    let base = if shown != loaded {
        format!("{} of {} loaded", group_digits(shown), group_digits(loaded))
    } else {
        format!("{} loaded", group_digits(loaded))
    };
    if exhausted {
        base
    } else {
        base + "+"
    }
}

// ---------------------------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Kv {
    pub key: String,
    pub value: String,
    pub mono: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NarLine {
    pub clock: String,
    pub text: String,
    pub rtl: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Detail {
    pub title: String,
    pub title_rtl: bool,
    /// The failed event's error.
    pub error: String,
    pub error_rtl: bool,
    /// Why the project could not be read.
    pub project_error: String,
    pub kv: Vec<Kv>,
    pub narration: Vec<NarLine>,
    pub parts: Vec<NarLine>,
    pub files: Vec<Kv>,
    /// The video, when the event has one (thumbnail, Open video).
    pub output: Option<String>,
    /// What "Show in folder" reveals.
    pub reveal: String,
    /// Storyboard the render buttons run (render, or a take that wrote one).
    pub render_source: Option<String>,
    /// The CLI line "Copy command" offers.
    pub command: String,
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn out_size(o: Option<&Value>) -> String {
    let Some(o) = o else { return String::new() };
    let num = |k: &str| o.get(k).and_then(scalar);
    if let (Some(w), Some(h)) = (num("width"), num("height")) {
        return match num("fps") {
            Some(f) => format!("{w}\u{d7}{h} @ {f} fps"),
            None => format!("{w}\u{d7}{h}"),
        };
    }
    match o.get("size") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(scalar)
            .collect::<Vec<_>>()
            .join("\u{d7}"),
        Some(v) => scalar(v).unwrap_or_default(),
        None => String::new(),
    }
}

fn count(sb: &Value, key: &str, word: &str) -> Option<String> {
    sb.get(key)
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .map(|a| plural(a.len(), word))
}

/// Everything the detail panel shows. `proj` is None while loading or when it could not be read
/// (`err` says why).
pub fn build_detail(ev: &Event, proj: Option<&Project>, err: Option<&str>) -> Detail {
    let title = ev.title();
    let mut d = Detail {
        title_rtl: is_rtl(&title),
        title,
        error: if ev.failed {
            ev.error.clone().unwrap_or_default()
        } else {
            String::new()
        },
        project_error: err
            .map(|e| format!("Could not read the project: {e}"))
            .unwrap_or_default(),
        output: ev.output.clone(),
        reveal: ev.output.clone().unwrap_or_else(|| ev.path.clone()),
        render_source: ev.render_source().map(str::to_string),
        ..Detail::default()
    };
    d.error_rtl = is_rtl(&d.error);

    let add = |key: &str, value: String, mono: bool, kv: &mut Vec<Kv>| {
        if !value.is_empty() {
            kv.push(Kv {
                key: key.into(),
                value,
                mono,
            });
        }
    };
    let mut kv = Vec::new();
    add("Kind", kind_label(&ev.kind), false, &mut kv);
    add("When", fmt_date(&ev.at), false, &mut kv);
    let status = if ev.failed {
        "Failed".to_string()
    } else if ev.imported {
        "OK (imported)".to_string()
    } else {
        "OK".to_string()
    };
    add("Status", status, false, &mut kv);
    add("Duration", fmt_dur(ev.duration_sec), false, &mut kv);
    add(
        "Quality",
        ev.quality.clone().unwrap_or_default(),
        false,
        &mut kv,
    );
    add("Wall time", fmt_wall(ev.wall_seconds), false, &mut kv);
    add("Path", ev.path.clone(), true, &mut kv);
    add(
        "Output",
        ev.output.clone().unwrap_or_default(),
        true,
        &mut kv,
    );

    if let Some(p) = proj {
        if let Some(sb) = &p.storyboard {
            add("Output size", out_size(sb.get("output")), false, &mut kv);
            if let Some(v) = sb.get("voice") {
                let provider = v
                    .get("provider")
                    .and_then(scalar)
                    .unwrap_or_else(|| "edge".into());
                let name = v.get("name").and_then(scalar);
                let joined = [Some(provider), name]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>();
                add("Voice", joined.join(" \u{b7} "), false, &mut kv);
            }
            add(
                "Source",
                sb.get("source").and_then(scalar).unwrap_or_default(),
                true,
                &mut kv,
            );
            let counts: Vec<String> = [
                count(sb, "narration", "narration line"),
                count(sb, "captions", "caption"),
                count(sb, "zooms", "zoom"),
                count(sb, "highlights", "highlight"),
                count(sb, "segments", "segment"),
                count(sb, "parts", "part"),
            ]
            .into_iter()
            .flatten()
            .collect();
            add("Contains", counts.join(", "), false, &mut kv);

            if let Some(lines) = sb.get("narration").and_then(Value::as_array) {
                d.narration = lines
                    .iter()
                    .take(MAX_NARRATION)
                    .map(|l| {
                        let text = l
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        NarLine {
                            clock: fmt_clock(l.get("at").and_then(Value::as_f64).unwrap_or(0.0)),
                            rtl: is_rtl(&text),
                            text,
                        }
                    })
                    .collect();
            }
            if let Some(parts) = sb.get("parts").and_then(Value::as_array) {
                d.parts = parts
                    .iter()
                    .map(|p| {
                        let num = |k: &str| p.get(k).and_then(scalar);
                        let (from, to) = (num("from"), num("to"));
                        let clock = if from.is_some() || to.is_some() {
                            format!(
                                "{}\u{2013}{}",
                                from.unwrap_or_else(|| "0".into()),
                                to.unwrap_or_else(|| "end".into())
                            )
                        } else {
                            "all".into()
                        };
                        let text = ["storyboard", "sequence", "video"]
                            .iter()
                            .find_map(|k| p.get(k).and_then(scalar))
                            .unwrap_or_default();
                        NarLine {
                            clock,
                            text,
                            rtl: false,
                        }
                    })
                    .collect();
            }
        }
        if let Some(Value::Object(m)) = &p.meta {
            for (k, v) in m.iter().take(8) {
                if let Some(s) = scalar(v) {
                    add(k, s, false, &mut kv);
                }
            }
        }
        d.files = p
            .files
            .iter()
            .take(40)
            .map(|f| Kv {
                key: f.name.clone(),
                value: bytes(f.size),
                mono: true,
            })
            .collect();
    }
    d.kv = kv;

    let cmd_path = d.render_source.clone().unwrap_or_else(|| ev.path.clone());
    d.command = if ev.kind == "sequence" {
        format!("screenpilot sequence {} -q draft", shell_quote(&cmd_path))
    } else {
        format!("screenpilot render {} -q draft", shell_quote(&cmd_path))
    };
    d
}

// ---------------------------------------------------------------------------------------------
// Live jobs
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct JobRow {
    pub id: String,
    pub title: String,
    pub title_rtl: bool,
    pub kind: String,
    pub quality: String,
    /// `<path>  ·  pid 123`
    pub path_line: String,
    /// Step label, or `Starting`.
    pub label: String,
    /// `3/12 · 25%`
    pub count: String,
    /// 0..=1, or None while the render does not know its steps yet.
    pub progress: Option<f32>,
    /// Epoch seconds of the start.
    pub started: Option<i64>,
}

pub fn job_progress(step: Option<&Step>) -> Option<f32> {
    let s = step.filter(|s| s.total > 0)?;
    Some((s.index as f32 / s.total as f32).clamp(0.0, 1.0))
}

pub fn job_row(job: &JobInfo) -> JobRow {
    let title = title_of(&job.path);
    let progress = job_progress(job.step.as_ref());
    let (label, count) = match (&job.step, progress) {
        (Some(s), Some(p)) => (
            s.label.clone(),
            format!(
                "{}/{} \u{b7} {}%",
                s.index,
                s.total,
                (p * 100.0).round() as u32
            ),
        ),
        _ => ("Starting".to_string(), String::new()),
    };
    JobRow {
        id: job.id.clone(),
        title_rtl: is_rtl(&title),
        title,
        kind: job.kind.clone(),
        quality: job.quality.clone().unwrap_or_default(),
        path_line: format!("{}  \u{b7}  pid {}", job.path, job.pid),
        label,
        count,
        progress,
        started: parse_iso_secs(&job.started_at),
    }
}

/// `m:ss` since the job started (`0:00` when the start time is unreadable).
pub fn elapsed_text(started: Option<i64>, now: i64) -> String {
    started.map_or_else(|| fmt_clock(0.0), |s| fmt_clock((now - s) as f64))
}

// ---------------------------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyState {
    NotNeeded,
    Missing,
    Env,
    File,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderView {
    pub id: String,
    pub label: String,
    pub needs_key: bool,
    pub key: KeyState,
    /// `Key saved`, `No key`, ...
    pub status: String,
    /// Where the narration text goes.
    pub note: String,
    /// The key comes from the environment: it cannot be changed here.
    pub env_note: bool,
    /// Password field and Save button.
    pub can_edit: bool,
    pub can_remove: bool,
    /// `screenpilot secret set gemini`, empty when no key is needed.
    pub cli_line: String,
}

fn service_note(id: &str) -> &'static str {
    match id {
        "edge" => "Narration text is sent to Microsoft's online Edge voice service to make audio.",
        "elevenlabs" => "Narration text is sent to ElevenLabs to make audio.",
        "gemini" => "Narration text is sent to Google (Gemini API) to make audio.",
        "local" => "Runs on this computer with models you installed. Nothing leaves it.",
        "command" => "Runs a program you defined in voices.json. What it sends, and where, is up to that program.",
        _ => "",
    }
}

pub const ENV_KEY_NOTE: &str = "The key comes from an environment variable, so the dashboard cannot change or remove it. Unset the variable to manage a key here.";
pub const CLI_KEY_NOTE: &str = "Or set it from a terminal. The command reads the key from standard input, so it never appears in your shell history:";
pub const PRIVACY_NOTE: &str = "Online voices (Edge, ElevenLabs, Gemini) receive the narration text of every line they speak. Free plans can forbid commercial use, so check the terms before you publish a video made with them.";

pub fn provider_view(p: &ProviderInfo) -> ProviderView {
    let key = match (p.needs_key, p.key.as_deref()) {
        (false, _) => KeyState::NotNeeded,
        (true, Some("env")) => KeyState::Env,
        (true, Some("file")) => KeyState::File,
        (true, _) => KeyState::Missing,
    };
    let status = match key {
        KeyState::Env => "Key set by environment variable",
        KeyState::File => "Key saved",
        KeyState::Missing => "No key",
        KeyState::NotNeeded => "No key needed",
    };
    ProviderView {
        id: p.id.to_string(),
        label: p.label.to_string(),
        needs_key: p.needs_key,
        key,
        status: status.into(),
        note: service_note(p.id).into(),
        env_note: key == KeyState::Env,
        can_edit: p.needs_key && key != KeyState::Env,
        can_remove: key == KeyState::File,
        cli_line: if p.needs_key {
            format!("screenpilot secret set {}", p.id)
        } else {
            String::new()
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct SpeedRow {
    pub quality: String,
    /// `3.4×`
    pub ratio: String,
    /// `5 runs · 1 min video ≈ 18 s`
    pub detail: String,
    /// Bar length, 0.02..=1 relative to the fastest quality.
    pub fraction: f32,
}

pub fn speed_rows(speed: &[SpeedStat]) -> Vec<SpeedRow> {
    let max = speed.iter().map(|r| r.realtime).fold(1.0_f64, f64::max);
    speed
        .iter()
        .map(|r| SpeedRow {
            quality: r.quality.clone(),
            ratio: format!("{:.*}\u{d7}", usize::from(r.realtime < 10.0), r.realtime),
            detail: format!(
                "{} \u{b7} 1 min video \u{2248} {}",
                plural(r.runs, "run"),
                fmt_wall(Some(60.0 / r.realtime))
            ),
            fraction: ((r.realtime / max) as f32).max(0.02),
        })
        .collect()
}

pub const NO_SPEED_NOTE: &str = "No timed renders yet. Renders of 5 s or more are measured.";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000; // 2027-01-15T08:00:00Z

    fn iso(t: i64) -> String {
        iso_from_secs(t)
    }

    fn ev(v: Value) -> Event {
        Event::from_value(&v).unwrap()
    }

    #[test]
    fn iso_helper_roundtrips() {
        assert_eq!(parse_iso_secs(&iso(NOW)), Some(NOW));
        assert_eq!(iso(NOW), "2027-01-15T08:00:00.000Z");
    }

    #[test]
    fn rtl_detection_uses_the_first_strong_character() {
        assert!(is_rtl("عرض المنتج"));
        assert!(is_rtl("123 - عرض"));
        assert!(is_rtl("\u{5e9}\u{5dc}\u{5d5}\u{5dd}"));
        assert!(!is_rtl("Product demo"));
        assert!(!is_rtl("demo عرض"));
        assert!(!is_rtl(""));
        assert!(!is_rtl("1234 - 56"));
    }

    #[test]
    fn titles_follow_the_old_ui() {
        assert_eq!(title_of("/home/a/demo/storyboard.json"), "demo");
        assert_eq!(title_of("/home/a/demo/sequence.json"), "demo");
        assert_eq!(title_of("/home/a/intro.json"), "intro");
        assert_eq!(title_of("/home/a/sessions/2026-01-01/"), "2026-01-01");
        assert_eq!(title_of("C:\\Users\\me\\clip\\storyboard.json"), "clip");
        assert_eq!(title_of("storyboard.json"), "storyboard.json");
        assert_eq!(title_of("/x/عرض تجريبي/storyboard.json"), "عرض تجريبي");
        assert_eq!(title_of("/x/ملف.JSON"), "ملف");
        assert_eq!(title_of(".json"), ".json");
        assert_eq!(title_of(""), "");
    }

    #[test]
    fn durations_and_clocks() {
        assert_eq!(fmt_dur(Some(5.4)), "5 s");
        assert_eq!(fmt_dur(Some(93.0)), "1:33");
        assert_eq!(fmt_dur(Some(3723.0)), "1:02:03");
        assert_eq!(fmt_dur(None), "");
        assert_eq!(fmt_dur(Some(f64::NAN)), "");
        assert_eq!(fmt_wall(Some(108.0)), "1 min 48 s");
        assert_eq!(fmt_wall(Some(42.0)), "42 s");
        assert_eq!(fmt_wall(Some(60.0)), "1 min 00 s");
        assert_eq!(fmt_wall(None), "");
        assert_eq!(fmt_clock(75.4), "1:15");
        assert_eq!(fmt_clock(-3.0), "0:00");
        assert_eq!(fmt_clock(f64::INFINITY), "0:00");
    }

    #[test]
    fn relative_times() {
        let ago = |s: i64| rel(&iso(NOW - s), NOW);
        assert_eq!(ago(10), "just now");
        assert_eq!(ago(-500), "just now");
        assert_eq!(ago(60), "1 min ago");
        assert_eq!(ago(12 * 60), "12 min ago");
        assert_eq!(ago(3 * 3600), "3 h ago");
        assert_eq!(ago(2 * 86400), "2 d ago");
        assert_eq!(ago(20 * 86400), "Dec 26, 2026");
        assert_eq!(rel("garbage", NOW), "");
        assert_eq!(rel("", NOW), "");
    }

    #[test]
    fn dates_bytes_plural_quote() {
        assert_eq!(fmt_date("2026-11-09T12:30:45.123Z"), "2026-11-09 12:30 UTC");
        assert_eq!(fmt_date("nope"), "");
        assert_eq!(bytes(0), "0 B");
        assert_eq!(bytes(1023), "1023 B");
        assert_eq!(bytes(1536), "1.5 KB");
        assert_eq!(bytes(52_428_800), "50 MB");
        assert_eq!(plural(1, "line"), "1 line");
        assert_eq!(plural(2, "line"), "2 lines");
        assert_eq!(shell_quote("/a/b-c.json"), "/a/b-c.json");
        assert_eq!(shell_quote("/a b/$x\"y.json"), "\"/a b/\\$x\\\"y.json\"");
        assert_eq!(shell_quote("/عرض/x.json"), "\"/عرض/x.json\"");
        assert_eq!(shell_quote(""), "\"\"");
    }

    #[test]
    fn event_parses_and_ignores_bad_fields() {
        let e = ev(json!({
            "v": 1, "at": "2026-11-09T12:00:00.000Z", "kind": "render", "status": "ok",
            "path": "/p/demo/storyboard.json", "output": "/p/demo/demo.mp4",
            "durationSec": 93.2, "quality": "draft", "wallSeconds": 108.0, "imported": true,
            "error": ""
        }));
        assert_eq!(e.kind, "render");
        assert!(!e.failed && e.imported);
        assert_eq!(e.output.as_deref(), Some("/p/demo/demo.mp4"));
        assert_eq!(e.error, None);
        assert!(Event::from_value(&json!({"at": "x", "kind": "render"})).is_none());
        assert!(Event::from_value(&json!({"at": 5, "kind": "render", "path": "p"})).is_none());
        let odd = ev(
            json!({"at": "a", "kind": "take", "path": "p", "durationSec": "long", "wallSeconds": null}),
        );
        assert_eq!((odd.duration_sec, odd.wall_seconds), (None, None));
    }

    #[test]
    fn rows_for_each_state() {
        let ok = build_row(
            3,
            &ev(
                json!({"at": iso(NOW - 720), "kind": "render", "status": "ok", "path": "/p/demo/storyboard.json",
                "durationSec": 93.0, "wallSeconds": 108.0, "quality": "delivery"}),
            ),
            NOW,
        );
        assert_eq!(ok.idx, 3);
        assert_eq!(ok.title, "demo");
        assert_eq!(ok.sub, "Render \u{b7} 1:33 \u{b7} took 1 min 48 s");
        assert_eq!(ok.quality, "delivery");
        assert_eq!(ok.when, "12 min ago");
        assert!(!ok.failed && !ok.title_rtl);
        assert_eq!(ok.aria, "Render demo, ok, 12 min ago");

        let bad = build_row(
            0,
            &ev(
                json!({"at": iso(NOW), "kind": "render", "status": "failed", "path": "/p/عرض المنتج/storyboard.json",
                "error": "ffmpeg exited 1\nno such file"}),
            ),
            NOW,
        );
        assert!(bad.failed && bad.title_rtl);
        assert_eq!(bad.title, "عرض المنتج");
        let ar = build_row(
            0,
            &ev(
                json!({"at": iso(NOW), "kind": "take", "status": "failed", "path": "/p/x", "error": "فشل التصيير"}),
            ),
            NOW,
        );
        assert!(ar.error_rtl && ar.error == "فشل التصيير");
        assert_eq!(bad.sub, "Failed");
        assert_eq!(bad.error, "ffmpeg exited 1 no such file");
        assert!(!bad.error_rtl);
        assert!(bad.aria.contains("failed"));

        let bare = build_row(
            0,
            &ev(json!({"at": "bad", "kind": "weird", "path": "/x/y"})),
            NOW,
        );
        assert_eq!(bare.sub, "weird");
        assert_eq!(bare.when, "");
        assert_eq!(bare.title, "y");
        assert_eq!(
            sub_text(&ev(
                json!({"at":"a","kind":"take","path":"p","status":"failed"})
            )),
            "Failed"
        );
        assert!(sub_text(&ev(
            json!({"at":"a","kind":"record","path":"p","imported":true})
        ))
        .ends_with("imported"));
    }

    fn rows_of(events: &[Value]) -> Vec<Row> {
        events
            .iter()
            .enumerate()
            .map(|(i, v)| build_row(i, &Event::from_value(v).unwrap(), NOW))
            .collect()
    }

    #[test]
    fn filters_combine_and_search_in_arabic() {
        let events = vec![
            json!({"at": "a1", "kind": "render", "status": "failed", "path": "/p/عرض المنتج/storyboard.json", "error": "boom"}),
            json!({"at": "a2", "kind": "render", "status": "ok", "path": "/p/demo/storyboard.json", "quality": "draft"}),
            json!({"at": "a3", "kind": "take", "status": "ok", "path": "/s/take-1"}),
            json!({"at": "a4", "kind": "record", "status": "failed", "path": "/s/rec-1", "error": "No Monitor"}),
            json!({"at": "a5", "kind": "weird", "status": "ok", "path": "/s/odd"}),
        ];
        let rows = rows_of(&events);
        let mut f = Filter::default();
        assert!(!f.is_active());
        assert_eq!(visible(&rows, &f), vec![0, 1, 2, 3, 4]);
        f.failed = true;
        assert_eq!(visible(&rows, &f), vec![0, 3]);
        f.kinds[2] = true; // render
        assert_eq!(visible(&rows, &f), vec![0]);
        f.failed = false;
        assert_eq!(visible(&rows, &f), vec![0, 1]);
        f.kinds[1] = true; // + take
        assert_eq!(visible(&rows, &f), vec![0, 1, 2]);
        f.kinds = [false; 4];
        f.set_query("  عرض ");
        assert_eq!(visible(&rows, &f), vec![0]);
        f.set_query("NO MONITOR");
        assert_eq!(visible(&rows, &f), vec![3]);
        f.set_query("draft");
        assert_eq!(visible(&rows, &f), vec![1]);
        f.set_query("/s/");
        assert_eq!(visible(&rows, &f), vec![2, 3, 4]);
        f.set_query("zzz");
        assert!(visible(&rows, &f).is_empty());
        assert!(f.is_active());
    }

    fn page(n: usize, start: usize) -> Vec<Value> {
        // newest first: at = 2026-01-01T00:00:<n-i>
        (0..n)
            .map(|i| {
                let t = 1_000_000 - (start + i) as i64;
                json!({"at": iso(t), "kind": "render", "status": "ok", "path": format!("/p/{}/storyboard.json", start + i)})
            })
            .collect()
    }

    #[test]
    fn paging_appends_until_a_short_page() {
        let mut h = History::default();
        assert_eq!(h.cursor(), None);
        h.append_page(&page(PAGE, 0), PAGE, NOW);
        assert_eq!(h.events.len(), PAGE);
        assert!(!h.exhausted);
        assert_eq!(h.cursor(), Some(h.events[PAGE - 1].at.as_str()));
        h.append_page(&page(10, PAGE), PAGE, NOW);
        assert_eq!(h.events.len(), PAGE + 10);
        assert!(h.exhausted);
        assert_eq!(h.rows.last().unwrap().idx, PAGE + 9);
        let mut e = History::default();
        e.append_page(&[], PAGE, NOW);
        assert!(e.exhausted && e.events.is_empty());
    }

    #[test]
    fn fresh_events_go_in_front_and_reindex() {
        let mut h = History::default();
        h.append_page(&page(5, 3), PAGE, NOW); // t = 999997 .. 999993
        let newer = page(3, 0); // 1_000_000 .. 999998, all newer than the top
        let mut mix = newer.clone();
        mix.extend(page(5, 3)); // plus ones already loaded
        assert_eq!(h.prepend_fresh(&mix, NOW), 3);
        assert_eq!(h.events.len(), 8);
        assert_eq!(
            h.rows.iter().map(|r| r.idx).collect::<Vec<_>>(),
            (0..8).collect::<Vec<_>>()
        );
        assert_eq!(h.prepend_fresh(&mix, NOW), 0);
        let mut empty = History::default();
        assert_eq!(empty.prepend_fresh(&newer, NOW), 3);
    }

    #[test]
    fn ten_thousand_events_stay_cheap() {
        let page = page(10_000, 0);
        let mut h = History::default();
        let t = std::time::Instant::now();
        h.append_page(&page, 10_000, NOW);
        assert_eq!(h.rows.len(), 10_000);
        let mut f = Filter::default();
        f.set_query("/p/99");
        assert_eq!(visible(&h.rows, &f).len(), 111); // 99, 990-999, 9900-9999
        assert!(t.elapsed().as_secs() < 5);
    }

    #[test]
    fn empty_state_and_counts() {
        assert_eq!(empty_state(5, 1, true, false), None);
        assert_eq!(empty_state(0, 0, false, true).unwrap().0, "Loading history");
        assert_eq!(
            empty_state(0, 0, false, false).unwrap().0,
            "Loading history"
        );
        assert_eq!(
            empty_state(0, 0, true, false).unwrap().0,
            "Nothing here yet"
        );
        assert_eq!(
            empty_state(5, 0, true, false).unwrap().1,
            "Try another search or clear the filters."
        );
        assert!(empty_state(5, 0, false, false)
            .unwrap()
            .1
            .contains("Load older"));
        assert_eq!(count_text(0, 0, false, true), "");
        assert_eq!(count_text(50, 50, false, false), "50 loaded+");
        assert_eq!(count_text(1234, 3, true, false), "3 of 1,234 loaded");
        assert_eq!(count_text(10_000, 10_000, true, false), "10,000 loaded");
    }

    fn project(sb: Value) -> Project {
        Project {
            storyboard: Some(sb),
            meta: Some(json!({"screens": [], "fps": 30, "app": "Files", "nothing": null})),
            files: vec![screenpilot_dashboard_core::project::FileEntry {
                name: "a.mp4".into(),
                size: 1536,
            }],
        }
    }

    #[test]
    fn detail_of_a_failed_arabic_render() {
        let e = ev(
            json!({"at": "2026-11-09T12:30:45.000Z", "kind": "render", "status": "failed",
            "path": "/p/عرض/storyboard.json", "quality": "draft", "error": "فشل التصيير"}),
        );
        let sb = json!({
            "source": "rec.mp4",
            "output": {"width": 1920, "height": 1080, "fps": 30},
            "voice": {"provider": "local", "name": "voicetut:Sarah"},
            "narration": [{"at": 1.2, "text": "مرحبا بكم"}, {"at": 75, "text": "Hello"}],
            "captions": [{}], "zooms": [{}, {}], "segments": []
        });
        let d = build_detail(&e, Some(&project(sb)), None);
        assert_eq!(d.title, "عرض");
        assert!(d.title_rtl && d.error_rtl);
        assert_eq!(d.error, "فشل التصيير");
        let get = |k: &str| d.kv.iter().find(|x| x.key == k).map(|x| x.value.clone());
        assert_eq!(get("Status").as_deref(), Some("Failed"));
        assert_eq!(
            get("Output size").as_deref(),
            Some("1920\u{d7}1080 @ 30 fps")
        );
        assert_eq!(get("Voice").as_deref(), Some("local \u{b7} voicetut:Sarah"));
        assert_eq!(get("Source").as_deref(), Some("rec.mp4"));
        assert_eq!(
            get("Contains").as_deref(),
            Some("2 narration lines, 1 caption, 2 zooms")
        );
        assert_eq!(get("fps").as_deref(), Some("30"));
        assert_eq!(get("app").as_deref(), Some("Files"));
        assert_eq!(get("nothing"), None);
        assert_eq!(get("When").as_deref(), Some("2026-11-09 12:30 UTC"));
        assert_eq!(d.narration.len(), 2);
        assert_eq!(d.narration[0].clock, "0:01");
        assert!(d.narration[0].rtl && !d.narration[1].rtl);
        assert_eq!(d.narration[1].clock, "1:15");
        assert_eq!(
            d.files,
            vec![Kv {
                key: "a.mp4".into(),
                value: "1.5 KB".into(),
                mono: true
            }]
        );
        assert_eq!(d.render_source.as_deref(), Some("/p/عرض/storyboard.json"));
        assert_eq!(
            d.command,
            "screenpilot render \"/p/عرض/storyboard.json\" -q draft"
        );
        assert_eq!(d.reveal, "/p/عرض/storyboard.json");
        assert_eq!(d.output, None);
    }

    #[test]
    fn detail_for_take_sequence_and_unreadable_project() {
        let take = ev(
            json!({"at": "2026-11-09T12:30:45.000Z", "kind": "take", "path": "/s/take-1",
            "storyboard": "/s/take-1/storyboard.json", "output": "/s/take-1/rec.mp4"}),
        );
        let d = build_detail(&take, None, Some("not found"));
        assert_eq!(
            d.render_source.as_deref(),
            Some("/s/take-1/storyboard.json")
        );
        assert_eq!(d.reveal, "/s/take-1/rec.mp4");
        assert_eq!(d.output.as_deref(), Some("/s/take-1/rec.mp4"));
        assert_eq!(d.project_error, "Could not read the project: not found");
        assert!(d.narration.is_empty() && d.files.is_empty());

        let seq = ev(
            json!({"at": "2026-11-09T12:30:45.000Z", "kind": "sequence", "path": "/s/all/sequence.json"}),
        );
        let sb = json!({"parts": [{"storyboard": "a.json", "to": 42}, {"video": "c.mp4"}, {"sequence": "g.json", "from": 5}]});
        let d = build_detail(&seq, Some(&project(sb)), None);
        assert_eq!(d.render_source, None);
        assert_eq!(
            d.command,
            "screenpilot sequence /s/all/sequence.json -q draft"
        );
        assert_eq!(
            d.parts
                .iter()
                .map(|p| (p.clock.as_str(), p.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("0\u{2013}42", "a.json"),
                ("all", "c.mp4"),
                ("5\u{2013}end", "g.json")
            ]
        );
        assert!(d
            .kv
            .iter()
            .any(|k| k.key == "Contains" && k.value == "3 parts"));
        let rec = ev(json!({"at": "2026-11-09T12:30:45.000Z", "kind": "record", "path": "/s/rec"}));
        let d = build_detail(&rec, None, None);
        assert_eq!(d.render_source, None);
        assert_eq!(d.command, "screenpilot render /s/rec -q draft");
    }

    #[test]
    fn narration_is_capped() {
        let lines: Vec<Value> = (0..500).map(|i| json!({"at": i, "text": "x"})).collect();
        let e = ev(
            json!({"at": "2026-11-09T12:30:45.000Z", "kind": "render", "path": "/p/storyboard.json"}),
        );
        let d = build_detail(&e, Some(&project(json!({"narration": lines}))), None);
        assert_eq!(d.narration.len(), MAX_NARRATION);
    }

    fn job(step: Option<(&str, u64, u64)>) -> JobInfo {
        JobInfo {
            id: "j1".into(),
            pid: 4242,
            kind: "render".into(),
            path: "/p/عرض/storyboard.json".into(),
            quality: Some("draft".into()),
            started_at: iso(NOW - 125),
            updated_at: iso(NOW),
            step: step.map(|(l, i, t)| Step {
                label: l.into(),
                index: i,
                total: t,
            }),
        }
    }

    #[test]
    fn job_rows_and_progress() {
        let r = job_row(&job(Some(("chunk", 3, 12))));
        assert_eq!(r.title, "عرض");
        assert!(r.title_rtl);
        assert_eq!(r.progress, Some(0.25));
        assert_eq!(r.label, "chunk");
        assert_eq!(r.count, "3/12 \u{b7} 25%");
        assert_eq!(r.path_line, "/p/عرض/storyboard.json  \u{b7}  pid 4242");
        assert_eq!(r.quality, "draft");
        assert_eq!(elapsed_text(r.started, NOW), "2:05");

        let start = job_row(&job(None));
        assert_eq!(
            (start.progress, start.label.as_str(), start.count.as_str()),
            (None, "Starting", "")
        );
        assert_eq!(job_row(&job(Some(("x", 0, 0)))).progress, None);
        assert_eq!(job_row(&job(Some(("x", 9, 3)))).progress, Some(1.0));
        assert_eq!(elapsed_text(None, NOW), "0:00");
        assert_eq!(elapsed_text(Some(NOW + 50), NOW), "0:00");
    }

    fn info(id: &'static str, needs: bool, key: Option<&str>) -> ProviderInfo {
        ProviderInfo {
            id,
            label: "L",
            needs_key: needs,
            key: key.map(str::to_string),
        }
    }

    #[test]
    fn provider_states() {
        let none = provider_view(&info("gemini", true, None));
        assert_eq!(
            (none.key, none.status.as_str()),
            (KeyState::Missing, "No key")
        );
        assert!(none.can_edit && !none.can_remove && !none.env_note);
        assert_eq!(none.cli_line, "screenpilot secret set gemini");
        assert!(none.note.contains("Google (Gemini API)"));

        let file = provider_view(&info("elevenlabs", true, Some("file")));
        assert_eq!(
            (file.key, file.status.as_str()),
            (KeyState::File, "Key saved")
        );
        assert!(file.can_edit && file.can_remove);

        let env = provider_view(&info("elevenlabs", true, Some("env")));
        assert_eq!(env.status, "Key set by environment variable");
        assert!(env.env_note && !env.can_edit && !env.can_remove);

        let edge = provider_view(&info("edge", false, None));
        assert_eq!(
            (edge.key, edge.status.as_str()),
            (KeyState::NotNeeded, "No key needed")
        );
        assert!(!edge.can_edit && edge.cli_line.is_empty());
        assert!(provider_view(&info("local", false, None))
            .note
            .contains("Nothing leaves"));
        assert!(provider_view(&info("command", false, None))
            .note
            .contains("voices.json"));
    }

    #[test]
    fn speed_rows_scale_to_the_fastest() {
        let rows = speed_rows(&[
            SpeedStat {
                quality: "draft".into(),
                runs: 5,
                realtime: 3.4,
            },
            SpeedStat {
                quality: "delivery".into(),
                runs: 1,
                realtime: 0.5,
            },
            SpeedStat {
                quality: "looks".into(),
                runs: 2,
                realtime: 12.0,
            },
        ]);
        assert_eq!(rows[0].ratio, "3.4\u{d7}");
        assert_eq!(rows[0].detail, "5 runs \u{b7} 1 min video \u{2248} 18 s");
        assert_eq!(
            rows[1].detail,
            "1 run \u{b7} 1 min video \u{2248} 2 min 00 s"
        );
        assert_eq!(rows[2].ratio, "12\u{d7}");
        assert_eq!(rows[2].fraction, 1.0);
        assert!(rows[1].fraction >= 0.02 && rows[1].fraction < 0.1);
        assert!(speed_rows(&[]).is_empty());
    }
}
