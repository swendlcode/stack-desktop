//! The MIDI preview voice.
//!
//! A struck string rather than a beep: a stack of partials whose upper
//! members die away first, slight inharmonicity because real strings are
//! stiff, a frequency-tracking lowpass, and a short filtered noise burst for
//! the hammer. That sound was built in Web Audio nodes and is reproduced here
//! sample for sample, because the point of moving was the output device, not
//! the instrument.
//!
//! The whole performance is rendered up front into one buffer and handed to
//! the ordinary mixer. A preview is a few bars and a few dozen notes, so the
//! render costs milliseconds, and in exchange MIDI gets everything sample
//! playback already has: the start and stop ramps, an exact playhead, seek,
//! pause, device changes and a real end-of-sample event. A realtime voice
//! allocator would have been a second scheduler to keep correct for no gain.

use serde::Deserialize;

use super::decode::Samples;
use super::filter::Biquad;

/// Most notes sounding at once. Dense passages drop their quietest.
const MAX_VOICES: usize = 24;
/// Headroom before the limiter, matching the Web Audio master gain.
const MASTER_GAIN: f32 = 0.9;
/// The floor an exponential ramp approaches. Web Audio cannot ramp to zero.
const FLOOR: f32 = 0.0001;

/// Partial multiplier, its share of the level, and how fast it decays
/// relative to the note.
const PARTIALS: [(f32, f32, f32); 6] = [
    (1.0, 0.62, 1.0),
    (2.0, 0.26, 0.62),
    (3.0, 0.13, 0.45),
    (4.0, 0.08, 0.32),
    (5.0, 0.05, 0.24),
    (6.0, 0.03, 0.18),
];
const INHARMONICITY: f32 = 0.0004;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiNote {
    pub pitch: f64,
    pub start_tick: f64,
    pub duration_ticks: f64,
    pub velocity: f64,
}

#[derive(Debug, Clone)]
struct Scheduled {
    pitch: f64,
    start_sec: f64,
    play_duration_sec: f64,
    velocity: f32,
}

fn midi_to_frequency(pitch: f64) -> f32 {
    (440.0 * 2f64.powf((pitch - 69.0) / 12.0)) as f32
}

/// Web Audio's `exponentialRampToValueAtTime`, evaluated directly.
///
/// `v(t) = v0 * (v1/v0)^((t - t0) / (t1 - t0))`. Both ends must be above
/// zero, which is why every envelope here starts and finishes at `FLOOR`
/// rather than silence.
fn exp_ramp(v0: f32, v1: f32, progress: f32) -> f32 {
    if v0 <= 0.0 || v1 <= 0.0 {
        return v1;
    }
    v0 * (v1 / v0).powf(progress.clamp(0.0, 1.0))
}

/// Deterministic noise for the hammer strike. A fixed seed so the same MIDI
/// file previews identically every time, which matters when comparing a
/// change by ear.
struct Noise(u32);

impl Noise {
    fn new() -> Self {
        Self(0x2545_F491)
    }
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

/// Choose what to sound, keeping a bounded number of simultaneous voices and
/// letting louder notes displace quieter ones in a dense chord.
fn select_playable(notes: &[MidiNote], duration_sec: f64, offset_sec: f64) -> Vec<Scheduled> {
    let max_tick = notes
        .iter()
        .fold(0.0f64, |m, n| m.max(n.start_tick + n.duration_ticks));
    if max_tick <= 0.0 || duration_sec <= 0.0 {
        return Vec::new();
    }
    let tick_to_sec = duration_sec / max_tick;

    let mut normalized: Vec<Scheduled> = Vec::with_capacity(notes.len());
    for note in notes {
        let note_start = note.start_tick * tick_to_sec;
        let note_duration = (note.duration_ticks * tick_to_sec).max(0.03);
        if note_start + note_duration <= offset_sec {
            continue;
        }
        let cut = (offset_sec - note_start).max(0.0);
        let velocity_norm = (note.velocity / 127.0).clamp(0.05, 1.0);
        normalized.push(Scheduled {
            pitch: note.pitch,
            start_sec: (note_start - offset_sec).max(0.0),
            play_duration_sec: (note_duration - cut).max(0.02),
            velocity: (0.12 + velocity_norm.powf(1.35) * 0.52) as f32,
        });
    }

    normalized.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                b.velocity
                    .partial_cmp(&a.velocity)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    struct Active {
        end_sec: f64,
        velocity: f32,
        chosen_index: usize,
    }
    let mut chosen: Vec<Scheduled> = Vec::new();
    let mut active: Vec<Active> = Vec::new();

    for candidate in normalized {
        active.retain(|v| v.end_sec > candidate.start_sec);
        let end_sec = candidate.start_sec + candidate.play_duration_sec;

        if active.len() < MAX_VOICES {
            active.push(Active {
                end_sec,
                velocity: candidate.velocity,
                chosen_index: chosen.len(),
            });
            chosen.push(candidate);
            continue;
        }

        // Displace the weakest voice, but only for something louder.
        let weakest = active
            .iter()
            .enumerate()
            .min_by(|a, b| {
                a.1.velocity
                    .partial_cmp(&b.1.velocity)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(i, _)| i);
        let Some(weakest) = weakest else { continue };
        if candidate.velocity <= active[weakest].velocity {
            continue;
        }
        chosen[active[weakest].chosen_index].play_duration_sec = 0.0;
        active[weakest] = Active {
            end_sec,
            velocity: candidate.velocity,
            chosen_index: chosen.len(),
        };
        chosen.push(candidate);
    }

    chosen.retain(|n| n.play_duration_sec > 0.0);
    chosen
}

/// A soft-knee peak compressor standing in for `DynamicsCompressorNode`.
///
/// Dense chords of six partials each will clip the master without it, which
/// is exactly why the Web Audio graph had one.
fn limit(buffer: &mut [f32], rate: f32) {
    const THRESHOLD_DB: f32 = -6.0;
    const KNEE_DB: f32 = 12.0;
    const RATIO: f32 = 3.0;
    let attack = (-1.0 / (0.003 * rate)).exp();
    let release = (-1.0 / (0.12 * rate)).exp();
    let mut gain_db = 0.0f32;

    for sample in buffer.iter_mut() {
        let level_db = 20.0 * sample.abs().max(1e-9).log10();
        let over = level_db - THRESHOLD_DB;
        let target_db = if 2.0 * over < -KNEE_DB {
            0.0
        } else if 2.0 * over.abs() <= KNEE_DB {
            (1.0 / RATIO - 1.0) * (over + KNEE_DB / 2.0).powi(2) / (2.0 * KNEE_DB)
        } else {
            (1.0 / RATIO - 1.0) * over
        };
        // Attack when clamping down harder, release when easing off.
        let coeff = if target_db < gain_db { attack } else { release };
        gain_db = target_db + coeff * (gain_db - target_db);
        *sample *= 10f32.powf(gain_db / 20.0);
    }
}

/// Render a MIDI performance to mono samples at `rate`.
pub fn render(notes: &[MidiNote], duration_sec: f64, offset_sec: f64, rate: u32) -> Samples {
    let playable = select_playable(notes, duration_sec, offset_sec);
    let tail = (duration_sec - offset_sec).max(0.0);
    let rate_f = rate as f32;
    let total_frames = (((tail + 0.5) * f64::from(rate)) as usize).max(1);
    let mut master = vec![0.0f32; total_frames];

    // Polyphony compensation, measured the same way the Web Audio path did:
    // how many voices are sounding as each note begins.
    let mut active_ends: Vec<f64> = Vec::new();
    let mut noise = Noise::new();

    for note in &playable {
        active_ends.retain(|end| *end > note.start_sec);
        active_ends.push(note.start_sec + note.play_duration_sec);
        let poly_comp = (1.0 / (active_ends.len().max(1) as f32).powf(0.35)).max(0.55);

        let freq = midi_to_frequency(note.pitch);
        let start_frame = (note.start_sec * f64::from(rate)) as usize;
        if start_frame >= total_frames {
            continue;
        }
        // The note rings past its stop: the envelope decays for another
        // 300ms and the oscillators run 320ms beyond.
        let voice_frames = (((note.play_duration_sec + 0.32) * f64::from(rate)) as usize).max(1);
        let stop_sec = note.play_duration_sec as f32;

        let mut tone = Biquad::lowpass((3200.0 + freq * 3.2).min(11000.0), 0.3, rate_f);
        let mut strike_filter = Biquad::bandpass((freq * 4.0).min(7000.0), 0.8, rate_f);
        let strike_peak = 0.14 * note.velocity * poly_comp;

        for i in 0..voice_frames {
            let out_index = start_frame + i;
            if out_index >= total_frames {
                break;
            }
            let t = i as f32 / rate_f;

            // Partials, each with its own decay.
            let mut voice = 0.0f32;
            for (mult, level, decay) in PARTIALS {
                let pf = freq * mult * (1.0 + INHARMONICITY * mult * mult);
                if pf > 16000.0 {
                    continue;
                }
                let peak = (level * poly_comp).max(0.0002);
                let end = ((stop_sec + 0.32) * decay).max(0.12);
                let gain = if t < 0.005 {
                    exp_ramp(FLOOR, peak, t / 0.005)
                } else if t < end {
                    exp_ramp(peak, FLOOR, (t - 0.005) / (end - 0.005).max(1e-6))
                } else {
                    0.0
                };
                if gain <= 0.0 {
                    continue;
                }
                // A few cents of detune per partial, for the beating of real
                // strings. Cents to a frequency ratio: 2^(cents/1200).
                let detune = 2f32.powf(((mult - 1.0) * 1.6) / 1200.0);
                voice += (std::f32::consts::TAU * pf * detune * t).sin() * gain;
            }

            // Hammer strike: filtered noise, gone in 55ms.
            if t < 0.1 {
                let n = strike_filter.process(noise.next());
                voice += n * exp_ramp(strike_peak.max(FLOOR), FLOOR, (t / 0.055).min(1.0));
            }

            // Tone filter, then the note envelope.
            let shaped = tone.process(voice);
            let env = note_envelope(t, stop_sec, note.velocity);
            master[out_index] += shaped * env;
        }
    }

    for sample in &mut master {
        *sample *= MASTER_GAIN;
    }
    limit(&mut master, rate_f);

    Samples {
        data: master,
        channels: 1,
        rate,
    }
}

/// The four-stage envelope the Web Audio graph scheduled on each note.
fn note_envelope(t: f32, stop_sec: f32, velocity: f32) -> f32 {
    let p1 = (0.95 * velocity).max(0.05);
    let p2 = (0.42 * velocity).max(0.03);
    let p3 = (0.2 * velocity).max(0.015);
    let end = stop_sec + 0.3;
    if t < 0.006 {
        exp_ramp(FLOOR, p1, t / 0.006)
    } else if t < 0.18 {
        exp_ramp(p1, p2, (t - 0.006) / (0.18 - 0.006))
    } else if t < 0.7 {
        exp_ramp(p2, p3, (t - 0.18) / (0.7 - 0.18))
    } else if t < end {
        exp_ramp(p3, FLOOR, (t - 0.7) / (end - 0.7).max(1e-6))
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(pitch: f64, start: f64, dur: f64, vel: f64) -> MidiNote {
        MidiNote {
            pitch,
            start_tick: start,
            duration_ticks: dur,
            velocity: vel,
        }
    }

    #[test]
    fn renders_audible_mono_audio() {
        let notes = vec![note(60.0, 0.0, 480.0, 100.0), note(64.0, 0.0, 480.0, 90.0)];
        let out = render(&notes, 1.0, 0.0, 48_000);
        assert_eq!(out.channels, 1);
        assert_eq!(out.rate, 48_000);
        let peak = out.data.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.05, "peak was {peak}");
        assert!(out.data.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn the_limiter_keeps_dense_chords_inside_the_rails() {
        // Sixteen notes at full velocity, all struck together.
        let notes: Vec<MidiNote> = (0..16)
            .map(|i| note(48.0 + f64::from(i), 0.0, 960.0, 127.0))
            .collect();
        let out = render(&notes, 2.0, 0.0, 48_000);
        let peak = out.data.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak <= 1.0, "dense chord clipped at {peak}");
        assert!(peak > 0.1, "dense chord was inaudible at {peak}");
    }

    #[test]
    fn an_offset_skips_notes_that_have_already_finished() {
        let early = note(60.0, 0.0, 100.0, 100.0);
        let late = note(72.0, 900.0, 100.0, 100.0);
        let chosen = select_playable(&[early, late], 1.0, 0.95);
        assert_eq!(chosen.len(), 1);
        assert!((chosen[0].pitch - 72.0).abs() < f64::EPSILON);
    }

    #[test]
    fn polyphony_is_capped_and_prefers_the_loudest() {
        // Forty simultaneous notes against a cap of twenty-four.
        let notes: Vec<MidiNote> = (0..40)
            .map(|i| note(40.0 + f64::from(i), 0.0, 480.0, 20.0 + f64::from(i) * 2.0))
            .collect();
        let chosen = select_playable(&notes, 1.0, 0.0);
        assert!(chosen.len() <= MAX_VOICES, "kept {} voices", chosen.len());
        // The quietest note cannot have survived a cull that tight.
        assert!(chosen.iter().all(|n| n.pitch > 40.0));
    }

    #[test]
    fn no_notes_renders_silence_rather_than_failing() {
        let out = render(&[], 1.0, 0.0, 48_000);
        assert!(out.data.iter().all(|s| *s == 0.0));
    }
}
