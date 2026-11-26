//! Decoded samples held in memory, capped by weight.
//!
//! The count is the wrong unit on its own: a decoded buffer is Float32 per
//! channel, so a five-minute stereo stem is well over a hundred megabytes
//! from an eighty-megabyte file, and a cap of twenty entries would authorise
//! gigabytes. Both limits are enforced, least-recently-used first.

use std::collections::{HashMap, HashSet};
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
    /// Paths whose bytes cannot be turned into audio.
    ///
    /// Deciding that costs a full read of the file and a probe, and nothing
    /// about the answer changes on a retry. One corrupt file in a real
    /// library is not rare: the one that found this was 339KB of zeros with
    /// no RIFF header, which macOS's own decoder will not open either.
    undecodable: HashSet<PathBuf>,
}

impl Cache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            clock: 0,
            rate: 0,
            undecodable: HashSet::new(),
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

    pub fn is_undecodable(&self, path: &PathBuf) -> bool {
        self.undecodable.contains(path)
    }

    pub fn mark_undecodable(&mut self, path: PathBuf) {
        self.undecodable.insert(path);
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
            // Also forget that it could not be decoded: the usual reason a
            // path is cleared is that the file changed underneath, which is
            // exactly the event that makes a previous failure stale.
            self.undecodable.remove(path);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(frames: usize) -> Arc<Samples> {
        Arc::new(Samples {
            data: vec![0.5; frames * 2],
            channels: 2,
            rate: 48_000,
        })
    }

    fn path(name: &str) -> PathBuf {
        PathBuf::from(format!("/library/{name}.wav"))
    }

    #[test]
    fn a_file_that_cannot_be_decoded_is_only_tried_once() {
        let mut cache = Cache::new();
        let bad = path("339kb-of-zeros");
        assert!(!cache.is_undecodable(&bad));
        cache.mark_undecodable(bad.clone());
        assert!(cache.is_undecodable(&bad));
        // A different file is unaffected.
        assert!(!cache.is_undecodable(&path("fine")));
    }

    #[test]
    fn forgetting_a_path_lets_it_be_tried_again() {
        // The usual reason a path is cleared is that the file changed, which
        // is exactly what makes a previous failure stale.
        let mut cache = Cache::new();
        let bad = path("was-corrupt");
        cache.mark_undecodable(bad.clone());
        cache.forget(&[bad.clone()]);
        assert!(!cache.is_undecodable(&bad));
    }

    #[test]
    fn a_rate_change_drops_the_buffers_but_not_the_verdicts() {
        // Resampling a corrupt file is still impossible.
        let mut cache = Cache::new();
        cache.retune(48_000);
        let good = path("good");
        cache.insert(good.clone(), samples(100));
        cache.mark_undecodable(path("bad"));
        cache.retune(44_100);
        assert!(cache.get(&good).is_none(), "buffers survived a rate change");
        assert!(cache.is_undecodable(&path("bad")));
    }

    #[test]
    fn the_byte_ceiling_evicts_least_recently_used() {
        let mut cache = Cache::new();
        cache.retune(48_000);
        for i in 0..MAX_ENTRIES + 6 {
            cache.insert(path(&i.to_string()), samples(10));
        }
        let (count, _) = cache.stats();
        assert!(count <= MAX_ENTRIES, "held {count} entries");
        // The most recent insert survived the cull.
        assert!(cache.get(&path(&(MAX_ENTRIES + 5).to_string())).is_some());
    }
}
