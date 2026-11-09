//! The ScreenPilot dashboard: a native Slint window (software renderer) over
//! `screenpilot-dashboard-core`. `model` is pure and unit-tested, `app` wires the window to the
//! core on worker threads, `fixture` makes deterministic data for screenshots and measurements.

pub mod app;
pub mod fixture;
pub mod model;

slint::include_modules!();
