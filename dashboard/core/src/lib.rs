//! Logic of the ScreenPilot dashboard. Pure functions that take explicit folders so the tests
//! use temp dirs. No GUI or async dependency: the Tauri shell (`../src-tauri`) only wires
//! these to commands. See `../API.md` for the contract with the UI.

pub mod cache;
pub mod cli;
pub mod history;
pub mod jobs;
pub mod open;
pub mod paths;
pub mod project;
pub mod providers;
pub mod stats;
pub mod thumbnail;

mod proc;
#[cfg(test)]
mod testutil;

pub use paths::Paths;
