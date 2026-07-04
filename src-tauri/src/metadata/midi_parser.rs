use std::fs;
use std::path::Path;

use midly::{MetaMessage, Smf, TrackEventKind};
use serde::{Deserialize, Serialize};

use crate::error::{Result, StackError};
use crate::models::MidiNote;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MidiMetadata {
    pub bpm: Option<f32>,
    pub time_signature: Option<String>,
    pub key_signature: Option<String>,
    pub bar_count: u32,
    pub note_count: u32,
    pub note_range_low: u8,
    pub note_range_high: u8,
    pub tracks: u8,
    pub duration_ms: u64,
    pub piano_roll: Vec<MidiNote>,
}

/// Real MIDI files are a few KB; anything beyond this is malformed or
/// mislabeled and would otherwise be buffered whole into memory.
const MAX_MIDI_BYTES: u64 = 16 * 1024 * 1024;

/// Upper bound on notes kept for the piano-roll preview. A pathological file
/// with hundreds of thousands of note-ons would otherwise bloat the asset's
/// meta JSON and every IPC payload that carries it.
const MAX_PIANO_ROLL_NOTES: usize = 10_000;

pub fn parse(path: &Path) -> Result<MidiMetadata> {
    let size = fs::metadata(path)?.len();
    if size > MAX_MIDI_BYTES {
        return Err(StackError::Other(format!(
            "midi: file too large ({} bytes, cap {})",
            size, MAX_MIDI_BYTES
        )));
    }
    let bytes = fs::read(path)?;
    let smf = Smf::parse(&bytes).map_err(|e| StackError::Other(format!("midi: {}", e)))?;

    let mut meta = MidiMetadata {
        tracks: smf.tracks.len().min(u8::MAX as usize) as u8,
        note_range_low: 127,
        note_range_high: 0,
        ..Default::default()
    };

    let ticks_per_beat = match smf.header.timing {
        midly::Timing::Metrical(n) => u16::from(n) as u32,
        _ => 480,
    };

    let mut us_per_beat: u32 = 500_000;
    let mut numer: u8 = 4;
    let mut max_end_tick: u32 = 0;
    let mut piano_roll: Vec<MidiNote> = Vec::new();

    for track in &smf.tracks {
        let mut tick: u32 = 0;
        // Note-on pending: pitch -> (start_tick, velocity)
        let mut pending: [Option<(u32, u8)>; 128] = [None; 128];

        for event in track {
            tick += u32::from(event.delta);
            match event.kind {
                TrackEventKind::Meta(MetaMessage::Tempo(t)) => {
                    us_per_beat = u32::from(t);
                    if meta.bpm.is_none() {
                        meta.bpm = Some(60_000_000.0 / us_per_beat as f32);
                    }
                }
                TrackEventKind::Meta(MetaMessage::TimeSignature(n, d, _, _)) => {
                    numer = n;
                    let denom: u8 = 1 << d;
                    meta.time_signature = Some(format!("{}/{}", numer, denom));
                }
                TrackEventKind::Meta(MetaMessage::KeySignature(sf, mi)) => {
                    meta.key_signature = Some(format_key_signature(sf, mi));
                }
                TrackEventKind::Midi { message, .. } => match message {
                    midly::MidiMessage::NoteOn { key, vel } if u8::from(vel) > 0 => {
                        let k = u8::from(key) as usize;
                        if k < 128 {
                            pending[k] = Some((tick, u8::from(vel)));
                        }
                    }
                    midly::MidiMessage::NoteOn { key, .. } => {
                        finish_note(&mut pending, &mut piano_roll, &mut meta, key.into(), tick);
                    }
                    midly::MidiMessage::NoteOff { key, .. } => {
                        finish_note(&mut pending, &mut piano_roll, &mut meta, key.into(), tick);
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        if tick > max_end_tick {
            max_end_tick = tick;
        }
    }

    if meta.note_range_low > meta.note_range_high {
        meta.note_range_low = 0;
    }

    let beats = max_end_tick as f32 / ticks_per_beat as f32;
    let bars = beats / numer.max(1) as f32;
    meta.bar_count = bars.ceil() as u32;

    let total_us = (max_end_tick as u64 * us_per_beat as u64) / ticks_per_beat.max(1) as u64;
    meta.duration_ms = total_us / 1000;

    meta.piano_roll = piano_roll;
    Ok(meta)
}

fn finish_note(
    pending: &mut [Option<(u32, u8)>; 128],
    roll: &mut Vec<MidiNote>,
    meta: &mut MidiMetadata,
    pitch: u8,
    tick: u32,
) {
    let idx = pitch as usize;
    if let Some((start, vel)) = pending[idx].take() {
        let duration = tick.saturating_sub(start);
        if duration > 0 {
            if pitch < meta.note_range_low {
                meta.note_range_low = pitch;
            }
            if pitch > meta.note_range_high {
                meta.note_range_high = pitch;
            }
            // note_count reflects every real note; the stored roll is capped
            // so a pathological file can't bloat the meta JSON.
            meta.note_count = meta.note_count.saturating_add(1);
            if roll.len() < MAX_PIANO_ROLL_NOTES {
                roll.push(MidiNote {
                    pitch,
                    start_tick: start,
                    duration_ticks: duration,
                    velocity: vel,
                });
            }
        }
    }
}

fn format_key_signature(sf: i8, minor: bool) -> String {
    const MAJOR: [&str; 15] = [
        "Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#",
    ];
    const MINOR: [&str; 15] = [
        "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#",
    ];
    let idx = (sf + 7).clamp(0, 14) as usize;
    let note = if minor { MINOR[idx] } else { MAJOR[idx] };
    format!("{} {}", note, if minor { "minor" } else { "major" })
}
