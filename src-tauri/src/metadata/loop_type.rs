//! Is a sample a loop or a one-shot?
//!
//! This used to be one value among many in `subtype`, decided by a
//! first-token-wins scan. `KICK_loop_128.wav` resolved to "kick" and the loop
//! signal was lost, so only 17% of a real 90k-sample library carried the
//! distinction at all and the One-Shots & Loops filter looked broken
//! (github issue #11).
//!
//! Signals, strongest first:
//!
//! 1. The filename says so, then the folder does. Exact, and covers about a
//!    third of a real library.
//! 2. The length is a whole number of beats at the file's own tempo. A loop
//!    is bars; a one-shot is however long it rings out. 94% accurate against
//!    files whose path states the answer.
//! 3. Otherwise length alone. One-shots cluster around 1s and loops around
//!    8s; 3s splits them with 88% accuracy.

/// Whole-beat tolerance for the grid test, as a fraction of the beat count.
const GRID_TOLERANCE: f64 = 0.08;
/// Below this many beats a "grid" match is meaningless — a single hit lands on
/// a beat by definition.
const MIN_LOOP_BEATS: f64 = 2.0;
/// Fallback split. Measured median one-shot ≈ 1.0s, median loop ≈ 7.9s.
const DURATION_SPLIT_MS: i64 = 3_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopType {
    Loop,
    OneShot,
}

impl LoopType {
    pub fn as_str(self) -> &'static str {
        match self {
            LoopType::Loop => "loop",
            LoopType::OneShot => "oneshot",
        }
    }
}

/// Normalise to lowercase with every separator collapsed to a single space, so
/// "One-Shots", "one_shot" and "ONE SHOT" all become " one shot ".
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push(' ');
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else {
            out.push(' ');
        }
    }
    out.push(' ');
    out
}

/// A phrase surrounded by separators — so "loop" matches in "drum_loop_01"
/// but not in "blooper" or "looped".
fn has_phrase(haystack_normalized: &str, phrase: &str) -> bool {
    haystack_normalized.contains(&format!(" {} ", phrase))
}

fn explicit(text: &str) -> Option<LoopType> {
    let n = normalize(text);
    // One-shot wins a tie: "One Shots/Kick Loop.wav" is checked per-segment by
    // the caller, so a tie here means both words are in the same name, where
    // "one shot kick loop" is far more likely to be a one-shot of a loop-kit.
    for p in ["one shot", "one shots", "oneshot", "oneshots", "1 shot", "hits", "hit"] {
        if has_phrase(&n, p) {
            return Some(LoopType::OneShot);
        }
    }
    for p in ["loop", "loops", "looped"] {
        if has_phrase(&n, p) {
            return Some(LoopType::Loop);
        }
    }
    None
}

/// Does `duration_ms` cover a whole number of beats at `bpm`?
fn on_the_grid(bpm: f32, duration_ms: i64) -> bool {
    if bpm <= 0.0 || duration_ms <= 0 {
        return false;
    }
    let beat_ms = 60_000.0 / bpm as f64;
    let beats = duration_ms as f64 / beat_ms;
    let nearest = beats.round();
    nearest >= MIN_LOOP_BEATS && (beats - nearest).abs() < GRID_TOLERANCE * nearest
}

/// `filename` is the file's own name; `parent_dirs` are the folder names above
/// it, nearest first. The filename is trusted over the folder: a one-shot kit
/// may well sit in a pack whose root is called "Loops".
pub fn classify(
    filename: &str,
    parent_dirs: &[String],
    bpm: Option<f32>,
    duration_ms: Option<i64>,
) -> Option<LoopType> {
    if let Some(t) = explicit(filename) {
        return Some(t);
    }
    for dir in parent_dirs {
        if let Some(t) = explicit(dir) {
            return Some(t);
        }
    }

    let duration = duration_ms?;

    if let Some(b) = bpm {
        if on_the_grid(b, duration) {
            return Some(LoopType::Loop);
        }
    }

    Some(if duration < DURATION_SPLIT_MS {
        LoopType::OneShot
    } else {
        LoopType::Loop
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn filename_beats_everything() {
        // The regression from issue #11: "kick" used to win and the loop
        // signal was dropped.
        assert_eq!(
            classify("KICK_loop_128.wav", &dirs(&["One Shots"]), None, Some(500)),
            Some(LoopType::Loop)
        );
        assert_eq!(
            classify("Kick one shot 01.wav", &dirs(&["Loops"]), Some(128.0), Some(8000)),
            Some(LoopType::OneShot)
        );
    }

    #[test]
    fn folder_is_used_when_the_filename_is_silent() {
        assert_eq!(
            classify("Kick 01.wav", &dirs(&["One Shots", "Drums"]), None, Some(9000)),
            Some(LoopType::OneShot)
        );
        assert_eq!(
            classify("BD_03.wav", &dirs(&["Loops"]), None, Some(400)),
            Some(LoopType::Loop)
        );
    }

    #[test]
    fn separators_and_case_do_not_matter() {
        for name in ["kick-ONE_SHOT-01.wav", "Kick.One.Shot.wav", "kick oneshots 2.wav"] {
            assert_eq!(classify(name, &[], None, Some(9000)), Some(LoopType::OneShot), "{name}");
        }
    }

    #[test]
    fn a_word_merely_containing_loop_is_not_a_loop() {
        // "blooper" and "develop" must not trip the substring.
        assert_eq!(
            classify("blooper_fx.wav", &[], None, Some(500)),
            Some(LoopType::OneShot)
        );
    }

    #[test]
    fn four_bars_at_its_own_tempo_is_a_loop() {
        // 16 beats at 128 BPM = 7500ms.
        assert_eq!(classify("MELODY_A.wav", &[], Some(128.0), Some(7500)), Some(LoopType::Loop));
        // A 1.2s stab at the same tempo is not on the grid.
        assert_eq!(classify("STAB_A.wav", &[], Some(128.0), Some(1200)), Some(LoopType::OneShot));
    }

    #[test]
    fn length_decides_when_nothing_else_can() {
        assert_eq!(classify("Perc_07.wav", &[], None, Some(800)), Some(LoopType::OneShot));
        assert_eq!(classify("Perc_07.wav", &[], None, Some(6000)), Some(LoopType::Loop));
    }

    #[test]
    fn unknown_when_there_is_nothing_to_go_on() {
        assert_eq!(classify("Untitled.wav", &[], None, None), None);
    }
}
