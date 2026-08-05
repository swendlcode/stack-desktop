//! Plugin discovery, leftover analysis, and removal.
//!
//! Stateless by design: the filesystem is the source of truth and results are
//! never persisted — the frontend caches scans via react-query.

pub mod deletion;
pub mod elevation;
pub mod leftovers;
pub mod metadata;
pub mod scanner;

pub use scanner::{default_roots, normalize_name, scan, PluginRoot};
