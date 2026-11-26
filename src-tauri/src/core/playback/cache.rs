//! Decoded samples held in memory, capped by weight.
//!
//! The count is the wrong unit on its own: a decoded buffer is Float32 per
//! channel, so a five-minute stereo stem is well over a hundred megabytes
//! from an eighty-megabyte file, and a cap of twenty entries would authorise
//! gigabytes. Both limits are enforced, least-recently-used first.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use super::decode::Samples;

/// Most decoded samples to hold.
const MAX_ENTRIES: usize = 24;
/// And what they may weigh together.
const MAX_BYTES: usize = 512 * 1024 * 1024;

struct Entry {
    samples: Arc<Samples>,
    used: u64,
    bytes: usize,
}

pub struct Cache {
    entries: HashMap<PathBuf, Entry>,
    bytes: usize,
    clock: u64,
    /// The rate everything in here was resampled to. A device change that
    /// moves the rate invalidates the lot, because the audio callback copies
    /// frames rather than converting them.
    rate: u32,
}

impl Cache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            clock: 0,
            rate: 0,
        }
    }

    /// Drop everything decoded for a rate that is no longer the device's.
    pub fn retune(&mut self, rate: u32) {
        if self.rate != rate {
            self.entries.clear();
            self.bytes = 0;
            self.rate = rate;
        }
    }

    pub fn get(&mut self, path: &PathBuf) -> Option<Arc<Samples>> {
        self.clock += 1;
        let clock = self.clock;
        let entry = self.entries.get_mut(path)?;
        entry.used = clock;
        Some(entry.samples.clone())
    }

    pub fn insert(&mut self, path: PathBuf, samples: Arc<Samples>) {
        let bytes = samples.bytes();
        self.clock += 1;
        if let Some(old) = self.entries.remove(&path) {
            self.bytes -= old.bytes;
        }
        self.entries.insert(
            path,
            Entry {
                samples,
                used: self.clock,
                bytes,
            },
        );
        self.bytes += bytes;
        self.evict();
    }

    pub fn forget(&mut self, paths: &[PathBuf]) {
        for path in paths {
            if let Some(old) = self.entries.remove(path) {
                self.bytes -= old.bytes;
            }
        }
    }

    pub fn stats(&self) -> (usize, usize) {
        (self.entries.len(), self.bytes)
    }

    /// Shed least-recently-used entries while either limit is exceeded, and
    /// stop while one is left: a single sample larger than the whole ceiling
    /// is still the sample the user asked for.
    fn evict(&mut self) {
        while (self.entries.len() > MAX_ENTRIES || self.bytes > MAX_BYTES)
            && self.entries.len() > 1
        {
            let Some(victim) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(p, _)| p.clone())
            else {
                return;
            };
            if let Some(old) = self.entries.remove(&victim) {
                self.bytes -= old.bytes;
            }
        }
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}
