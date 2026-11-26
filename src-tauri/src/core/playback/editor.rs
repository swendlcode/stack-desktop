//! The sample editor's audio.
//!
//! It holds two buffers: the file as decoded, which is never touched, and a
//! working copy carrying the destructive edits — reverse, normalize, delete.
//! Everything else (speed, pitch, high cut, low cut, loop, gain) is applied
//! live by the editor voice in the mixer, so a slider moves the sound without
//! anything being re-rendered.
//!
//! Two behaviours are carried over deliberately rather than improved, because
//! changing them is a product decision and this was a migration:
//!
//! - **Pitch is a varispeed.** `effective_rate` is `rate * 2^(semitones/12)`
//!   and moves the playhead as well as the pitch, exactly as resampling an
//!   `AudioBufferSourceNode` through `playbackRate` did. A true pitch shift
//!   that holds the length is a phase vocoder and a different feature.
//! - **Normalize stacks on reverse**, and reverse toggles back to the
//!   original, discarding a normalize applied on top of it.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use serde::Serialize;

use super::decode::{decode, Samples};
use super::filter::Biquad;
use super::output::{Cmd, EditorParams, Shared};
use crate::error::{Result, StackError};

/// Full scale for a 16-bit export, matching the encoder this replaced.
const I16_SCALE: f32 = 32_767.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorState {
    pub loaded_path: Option<String>,
    pub playing: bool,
    pub current_time: f64,
    pub duration: f64,
    pub volume: f32,
    pub rate: f32,
    pub pitch_semitones: f32,
    pub reversed: bool,
    pub loop_on: bool,
    pub loop_start: f64,
    pub loop_end: f64,
    pub high_cut_hz: f32,
    pub low_cut_hz: f32,
    pub channels: usize,
    pub sample_rate: u32,
}

struct Inner {
    loaded_path: Option<PathBuf>,
    /// As decoded. Never modified, so reverse can be undone.
    original: Option<Arc<Samples>>,
    /// Carries the destructive edits. `None` means the original is current.
    work: Option<Arc<Samples>>,
    reversed: bool,
    volume: f32,
    rate: f32,
    pitch_semitones: f32,
    low_cut: f32,
    high_cut: f32,
    loop_on: bool,
    loop_start: f64,
    loop_end: f64,
    /// Where the playhead sits while stopped.
    position: f64,
    playing: bool,
    generation: u64,
}

impl Inner {
    fn new() -> Self {
        Self {
            loaded_path: None,
            original: None,
            work: None,
            reversed: false,
            volume: 1.0,
            rate: 1.0,
            pitch_semitones: 0.0,
            low_cut: 20.0,
            high_cut: 22_050.0,
            loop_on: false,
            loop_start: 0.0,
            loop_end: 0.0,
            position: 0.0,
            playing: false,
            generation: 0,
        }
    }

    fn current(&self) -> Option<&Arc<Samples>> {
        self.work.as_ref().or(self.original.as_ref())
    }

    fn duration(&self) -> f64 {
        self.current().map_or(0.0, |s| s.duration_secs())
    }

    fn effective_rate(&self) -> f32 {
        (self.rate * 2f32.powf(self.pitch_semitones / 12.0)).max(0.01)
    }

    fn params(&self) -> EditorParams {
        let rate = self.current().map_or(48_000, |s| s.rate);
        let to_frames = |sec: f64| (sec.max(0.0) * f64::from(rate)) as usize;
        EditorParams {
            rate: self.effective_rate(),
            volume: self.volume,
            low_cut: self.low_cut,
            high_cut: self.high_cut,
            loop_on: self.loop_on,
            loop_start: to_frames(self.loop_start),
            loop_end: to_frames(self.loop_end),
        }
    }
}

pub struct Editor {
    cmd: Sender<Cmd>,
    shared: Arc<Shared>,
    inner: Mutex<Inner>,
}

impl Editor {
    pub fn new(cmd: Sender<Cmd>, shared: Arc<Shared>) -> Self {
        Self {
            cmd,
            shared,
            inner: Mutex::new(Inner::new()),
        }
    }

    fn send(&self, cmd: Cmd) -> Result<()> {
        self.cmd
            .try_send(cmd)
            .map_err(|e| StackError::Other(format!("audio command queue: {e}")))
    }

    /// Is the editor the thing currently sounding?
    ///
    /// Asked of the mixer, not of our own flag: starting a sample preview
    /// takes the output away from the editor without telling it, and an
    /// editor that still believed it was playing would report a playhead
    /// driven by somebody else's audio.
    fn owns_output(&self) -> bool {
        self.shared.editor_owns.load(Ordering::Acquire)
    }

    /// The playhead: the mixer's read head while playing, the stored position
    /// otherwise.
    fn position_of(&self, inner: &Inner) -> f64 {
        if !inner.playing || !self.owns_output() {
            return inner.position;
        }
        let rate = inner.current().map_or(48_000, |s| s.rate).max(1);
        self.shared.frame.load(Ordering::Acquire) as f64 / f64::from(rate)
    }

    pub fn state(&self) -> EditorState {
        let inner = self.inner.lock();
        let current = inner.current();
        EditorState {
            loaded_path: inner
                .loaded_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            // The editor's own intent, not the mixer's ownership flag.
            // `EditorPlay` is queued and the flag is not set until the audio
            // thread picks it up a few milliseconds later, so reading it
            // here answered "not playing" to every caller that asked right
            // after starting — which is every caller, because the command
            // returns the state.
            playing: inner.playing,
            current_time: self.position_of(&inner),
            duration: inner.duration(),
            volume: inner.volume,
            rate: inner.rate,
            pitch_semitones: inner.pitch_semitones,
            reversed: inner.reversed,
            loop_on: inner.loop_on,
            loop_start: inner.loop_start,
            loop_end: inner.loop_end,
            high_cut_hz: inner.high_cut,
            low_cut_hz: inner.low_cut,
            channels: current.map_or(0, |s| s.channels),
            sample_rate: current.map_or(0, |s| s.rate),
        }
    }

    /// Peak since the last call, per channel, and reset.
    ///
    /// Reading clears, so a peak that happened between two animation frames
    /// is reported rather than averaged away — a meter exists to warn about
    /// clipping, and an averaged one hides exactly the transients that clip.
    pub fn levels(&self) -> (f32, f32) {
        let left = f32::from_bits(self.shared.peak_left.swap(0, Ordering::AcqRel));
        let right = f32::from_bits(self.shared.peak_right.swap(0, Ordering::AcqRel));
        (left, right)
    }

    pub fn load(&self, path: &Path, device_rate: u32) -> Result<EditorState> {
        {
            let inner = self.inner.lock();
            if inner.loaded_path.as_deref() == Some(path) && inner.original.is_some() {
                drop(inner);
                return Ok(self.state());
            }
        }
        let samples = decode(path, device_rate)?;
        let duration = samples.duration_secs();
        self.send(Cmd::Stop)?;
        let mut inner = self.inner.lock();
        *inner = Inner::new();
        inner.loaded_path = Some(path.to_path_buf());
        inner.original = Some(samples);
        inner.loop_end = duration;
        drop(inner);
        Ok(self.state())
    }

    pub fn unload(&self) -> Result<EditorState> {
        self.send(Cmd::Stop)?;
        *self.inner.lock() = Inner::new();
        Ok(self.state())
    }

    /// Back to defaults. Destructive edits go too, so the file is as decoded.
    pub fn reset_edits(&self) -> Result<EditorState> {
        let mut inner = self.inner.lock();
        let path = inner.loaded_path.clone();
        let original = inner.original.clone();
        let duration = original.as_ref().map_or(0.0, |s| s.duration_secs());
        *inner = Inner::new();
        inner.loaded_path = path;
        inner.original = original;
        inner.loop_end = duration;
        let was_playing = false;
        drop(inner);
        if !was_playing {
            self.send(Cmd::Stop)?;
        }
        Ok(self.state())
    }

    pub fn play(&self, from_sec: Option<f64>) -> Result<EditorState> {
        let mut inner = self.inner.lock();
        let Some(samples) = inner.current().cloned() else {
            return Ok(self.state_unlocked(inner));
        };
        let start_sec = from_sec.unwrap_or(inner.position).max(0.0);
        let rate = samples.rate.max(1);
        let start_frame = (start_sec * f64::from(rate)) as usize;
        let params = inner.params();
        inner.generation += 1;
        inner.playing = true;
        inner.position = start_sec;
        let generation = inner.generation;
        drop(inner);
        self.send(Cmd::EditorPlay {
            samples,
            start_frame,
            params,
            generation,
        })?;
        Ok(self.state())
    }

    fn state_unlocked(&self, inner: parking_lot::MutexGuard<'_, Inner>) -> EditorState {
        drop(inner);
        self.state()
    }

    pub fn pause(&self) -> Result<EditorState> {
        let mut inner = self.inner.lock();
        if inner.playing {
            inner.position = self.position_of(&inner);
            inner.playing = false;
        }
        drop(inner);
        self.send(Cmd::Stop)?;
        Ok(self.state())
    }

    pub fn stop(&self) -> Result<EditorState> {
        let mut inner = self.inner.lock();
        inner.playing = false;
        inner.position = 0.0;
        drop(inner);
        self.send(Cmd::Stop)?;
        Ok(self.state())
    }

    pub fn seek(&self, sec: f64) -> Result<EditorState> {
        let (playing, target) = {
            let mut inner = self.inner.lock();
            let bounded = sec.clamp(0.0, inner.duration());
            inner.position = bounded;
            (inner.playing, bounded)
        };
        if playing {
            self.play(Some(target))
        } else {
            Ok(self.state())
        }
    }

    /// Push the live parameters at the mixer without restarting the voice.
    fn repush(&self) -> Result<EditorState> {
        let params = self.inner.lock().params();
        if self.owns_output() {
            self.send(Cmd::EditorParams(params))?;
        }
        Ok(self.state())
    }

    pub fn set_volume(&self, v: f32) -> Result<EditorState> {
        self.inner.lock().volume = v.clamp(0.0, 4.0);
        self.repush()
    }

    pub fn set_rate(&self, r: f32) -> Result<EditorState> {
        self.inner.lock().rate = r.clamp(0.05, 4.0);
        self.repush()
    }

    pub fn set_pitch(&self, semitones: f32) -> Result<EditorState> {
        self.inner.lock().pitch_semitones = semitones.clamp(-24.0, 24.0);
        self.repush()
    }

    pub fn set_high_cut(&self, hz: f32) -> Result<EditorState> {
        self.inner.lock().high_cut = hz.clamp(20.0, 22_050.0);
        self.repush()
    }

    pub fn set_low_cut(&self, hz: f32) -> Result<EditorState> {
        self.inner.lock().low_cut = hz.clamp(20.0, 22_050.0);
        self.repush()
    }

    pub fn set_loop(&self, on: bool, start: Option<f64>, end: Option<f64>) -> Result<EditorState> {
        {
            let mut inner = self.inner.lock();
            let duration = inner.duration();
            inner.loop_on = on;
            if let Some(s) = start {
                inner.loop_start = s.max(0.0);
            }
            if let Some(e) = end {
                inner.loop_end = e.min(duration);
            }
        }
        self.repush()
    }

    // ─── Destructive edits ─────────────────────────────────────────────────

    /// Reverse, or put it back. The original is kept, so this is a toggle
    /// rather than a second reversal.
    pub fn reverse(&self) -> Result<EditorState> {
        let (was_playing, at) = {
            let inner = self.inner.lock();
            (inner.playing, self.position_of(&inner))
        };
        {
            let mut inner = self.inner.lock();
            let duration = inner.duration();
            if inner.reversed {
                inner.work = None;
                inner.reversed = false;
            } else {
                let Some(source) = inner.current() else {
                    return Ok(self.state());
                };
                inner.work = Some(Arc::new(reversed(source)));
                inner.reversed = true;
            }
            // The playhead mirrors with the audio: a point two seconds from
            // the end is two seconds from the start once reversed.
            inner.position = (duration - at).clamp(0.0, duration);
        }
        self.restart_if(was_playing)
    }

    /// Scale the working buffer so its loudest sample sits at full scale.
    pub fn normalize(&self) -> Result<EditorState> {
        let (was_playing, at) = {
            let inner = self.inner.lock();
            (inner.playing, self.position_of(&inner))
        };
        {
            let mut inner = self.inner.lock();
            let Some(source) = inner.current() else {
                return Ok(self.state());
            };
            let peak = source.data.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            if peak < 0.0001 {
                return Ok(self.state());
            }
            let scale = 1.0 / peak;
            let scaled = Samples {
                data: source.data.iter().map(|s| s * scale).collect(),
                channels: source.channels,
                rate: source.rate,
            };
            inner.work = Some(Arc::new(scaled));
            inner.position = at;
        }
        self.restart_if(was_playing)
    }

    /// Cut a span out and splice the ends together.
    pub fn delete_region(&self, start_sec: f64, end_sec: f64) -> Result<EditorState> {
        let was_playing = self.inner.lock().playing;
        {
            let mut inner = self.inner.lock();
            let Some(source) = inner.current() else {
                return Ok(self.state());
            };
            let rate = f64::from(source.rate.max(1));
            let channels = source.channels.max(1);
            let total = source.frames();
            let from = ((start_sec * rate).round().max(0.0) as usize).min(total);
            let to = ((end_sec * rate).round().max(0.0) as usize).min(total);
            if to <= from {
                return Ok(self.state());
            }
            let mut data = Vec::with_capacity((total - (to - from)) * channels);
            data.extend_from_slice(&source.data[..from * channels]);
            data.extend_from_slice(&source.data[to * channels..]);
            if data.is_empty() {
                return Ok(self.state());
            }
            let spliced = Samples {
                data,
                channels,
                rate: source.rate,
            };
            let duration = spliced.duration_secs();
            inner.work = Some(Arc::new(spliced));
            // The playhead lands on the splice, and the loop is cleared
            // because the region it pointed at no longer exists.
            inner.position = start_sec.min(duration);
            inner.loop_on = false;
            inner.loop_start = 0.0;
            inner.loop_end = duration;
        }
        self.restart_if(was_playing)
    }

    fn restart_if(&self, was_playing: bool) -> Result<EditorState> {
        self.send(Cmd::Stop)?;
        if was_playing {
            let at = self.inner.lock().position;
            self.play(Some(at))
        } else {
            self.inner.lock().playing = false;
            Ok(self.state())
        }
    }

    // ─── Display and export ────────────────────────────────────────────────

    /// A mono downmix of the working buffer, for drawing.
    pub fn waveform(&self) -> Vec<f32> {
        let inner = self.inner.lock();
        let Some(source) = inner.current() else {
            return Vec::new();
        };
        let channels = source.channels.max(1);
        if channels == 1 {
            return source.data.clone();
        }
        source
            .data
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    }

    /// Render the edit as it would sound and write it as a 16-bit WAV.
    ///
    /// The rendering is the editor voice's arithmetic run offline: the same
    /// interpolation, the same biquads, the same gain, so the exported file
    /// is what was being auditioned rather than a second implementation that
    /// drifts from it.
    pub fn export(&self, target: &Path) -> Result<PathBuf> {
        let inner = self.inner.lock();
        let Some(source) = inner.current().cloned() else {
            return Err(StackError::Other("nothing loaded".into()));
        };
        let channels = source.channels.max(1);
        let rate = source.rate.max(1);
        let total = source.frames();
        let effective = f64::from(inner.effective_rate());
        let volume = inner.volume;

        let (from, span) = if inner.loop_on && inner.loop_end > inner.loop_start {
            let from = (inner.loop_start * f64::from(rate)) as usize;
            let to = ((inner.loop_end * f64::from(rate)) as usize).min(total);
            (from, to.saturating_sub(from))
        } else {
            (0, total)
        };
        let out_frames = ((span as f64) / effective).ceil() as usize;

        let mut filters: Vec<(Biquad, Biquad)> = (0..channels)
            .map(|_| {
                (
                    Biquad::highpass(inner.low_cut, 1.0, rate as f32),
                    Biquad::lowpass(inner.high_cut, 1.0, rate as f32),
                )
            })
            .collect();
        drop(inner);

        let mut writer = hound::WavWriter::create(
            target,
            hound::WavSpec {
                channels: channels as u16,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(|e| StackError::Other(format!("export: {e}")))?;

        let mut pos = from as f64;
        for _ in 0..out_frames {
            for (c, (high_pass, low_pass)) in filters.iter_mut().enumerate() {
                let raw = read_at(&source, c, pos);
                let value = low_pass.process(high_pass.process(raw)) * volume;
                let clamped = (value.clamp(-1.0, 1.0) * I16_SCALE) as i16;
                writer
                    .write_sample(clamped)
                    .map_err(|e| StackError::Other(format!("export: {e}")))?;
            }
            pos += effective;
        }
        writer
            .finalize()
            .map_err(|e| StackError::Other(format!("export: {e}")))?;
        Ok(target.to_path_buf())
    }
}

/// Catmull-Rom read, matching the editor voice exactly.
fn read_at(samples: &Samples, channel: usize, pos: f64) -> f32 {
    let frames = samples.frames();
    if frames == 0 {
        return 0.0;
    }
    let channels = samples.channels.max(1);
    let i = pos.floor() as isize;
    let frac = (pos - i as f64) as f32;
    let at = |k: isize| -> f32 {
        let k = k.clamp(0, frames as isize - 1) as usize;
        samples.data[k * channels + channel]
    };
    let (y0, y1, y2, y3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
    let a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    let b = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c = -0.5 * y0 + 0.5 * y2;
    ((a * frac + b) * frac + c) * frac + y1
}

fn reversed(source: &Samples) -> Samples {
    let channels = source.channels.max(1);
    let frames = source.frames();
    let mut data = Vec::with_capacity(source.data.len());
    for f in (0..frames).rev() {
        data.extend_from_slice(&source.data[f * channels..(f + 1) * channels]);
    }
    Samples {
        data,
        channels,
        rate: source.rate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo(frames: usize) -> Samples {
        let mut data = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            data.push(f as f32 / frames as f32);
            data.push(-(f as f32) / frames as f32);
        }
        Samples {
            data,
            channels: 2,
            rate: 48_000,
        }
    }

    #[test]
    fn reversing_twice_is_the_original() {
        let source = stereo(1000);
        let once = reversed(&source);
        let twice = reversed(&once);
        assert_eq!(twice.data, source.data);
        assert_eq!(twice.channels, 2);
    }

    #[test]
    fn reversing_keeps_the_channels_paired() {
        let source = stereo(4);
        let out = reversed(&source);
        // The last frame becomes the first, left and right still together.
        assert_eq!(out.data[0], source.data[6]);
        assert_eq!(out.data[1], source.data[7]);
    }

    #[test]
    fn reading_on_an_exact_frame_returns_that_sample() {
        let source = stereo(100);
        let got = read_at(&source, 0, 10.0);
        assert!((got - source.data[20]).abs() < 1e-6, "got {got}");
    }

    #[test]
    fn reading_past_the_end_clamps_rather_than_panicking() {
        let source = stereo(8);
        let got = read_at(&source, 1, 500.0);
        assert!(got.is_finite());
    }
}
