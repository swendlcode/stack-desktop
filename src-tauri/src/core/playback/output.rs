//! The output device, and the one thread allowed to touch it.
//!
//! Everything here exists to keep the audio callback honest: it never locks,
//! never allocates after the first buffer, and never frees. Commands reach it
//! through a lock-free queue and finished buffers leave the same way, because
//! dropping an `Arc<Samples>` on the realtime thread means a deallocation in
//! the middle of a render quantum.
//!
//! The device is owned by a dedicated thread for a plainer reason: a
//! `cpal::Stream` is not `Send`, so it cannot live in Tauri's managed state.
//! The thread parks on a channel, holds the stream alive in its own scope,
//! and rebuilds it when the default output moves or the stream faults.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use parking_lot::Mutex;

use super::decode::Samples;
use super::filter::Biquad;

/// How long a start ramps up and a stop ramps down, in milliseconds.
///
/// Auditioning is a stream of interruptions — press, press, press — and a
/// buffer cut mid-cycle is a click at every one of them. Five milliseconds is
/// inaudible as a fade and completely removes the edge.
const FADE_MS: u32 = 5;
/// Commands handled per callback. A bound, so a flood cannot stretch one.
const CMD_PER_CALLBACK: usize = 32;
/// How often the default output device is re-examined.
const DEVICE_POLL: Duration = Duration::from_millis(1000);

/// Everything the editor can change while a sample is sounding.
///
/// Separate from `Cmd::EditorPlay` because a slider sends these dozens of
/// times a second and must not restart the voice to do it.
#[derive(Clone, Copy)]
pub struct EditorParams {
    /// Buffer-seconds per real second. Pitch is resampling here, exactly as
    /// it was in Web Audio, so it moves the speed with it.
    pub rate: f32,
    pub volume: f32,
    pub low_cut: f32,
    pub high_cut: f32,
    pub loop_on: bool,
    pub loop_start: usize,
    pub loop_end: usize,
}

impl Default for EditorParams {
    fn default() -> Self {
        Self {
            rate: 1.0,
            volume: 1.0,
            low_cut: 20.0,
            high_cut: 22_050.0,
            loop_on: false,
            loop_start: 0,
            loop_end: 0,
        }
    }
}

/// What the control side asks the audio thread to do.
pub enum Cmd {
    Play {
        samples: Arc<Samples>,
        start_frame: usize,
        generation: u64,
    },
    /// The editor's voice: same buffer plumbing, but read at a variable rate
    /// through its own filters and loop points.
    EditorPlay {
        samples: Arc<Samples>,
        start_frame: usize,
        params: EditorParams,
        generation: u64,
    },
    EditorParams(EditorParams),
    Pause,
    Resume,
    Stop,
    Seek(usize),
    Volume(f32),
}

/// What the audio thread tells everyone else, without anybody having to ask.
pub struct Shared {
    pub playing: AtomicBool,
    /// Frame index of the active voice. The playhead, exactly.
    pub frame: AtomicU64,
    /// The generation of the voice that most recently ran to its end.
    pub ended: AtomicU64,
    pub device_rate: AtomicU32,
    pub device_channels: AtomicU32,
    /// Bumped whenever the stream is rebuilt onto a device.
    pub device_generation: AtomicU64,
    pub device_name: Mutex<String>,
    /// Set when no output device could be opened at all.
    pub device_failed: AtomicBool,
    /// Peak since the last read, per channel, as `f32::to_bits`. The editor's
    /// level meter; cleared by whoever reads it.
    pub peak_left: AtomicU32,
    pub peak_right: AtomicU32,
    /// True while the editor's voice is the one sounding.
    ///
    /// The editor and the browser share one output and one playhead, so
    /// without this the editor's position events would drive the main
    /// player's transport and move a playhead nobody was listening to.
    pub editor_owns: AtomicBool,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            playing: AtomicBool::new(false),
            frame: AtomicU64::new(0),
            ended: AtomicU64::new(0),
            device_rate: AtomicU32::new(0),
            device_channels: AtomicU32::new(0),
            device_generation: AtomicU64::new(0),
            device_name: Mutex::new(String::new()),
            device_failed: AtomicBool::new(false),
            peak_left: AtomicU32::new(0),
            peak_right: AtomicU32::new(0),
            editor_owns: AtomicBool::new(false),
        }
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

/// Messages to the thread that owns the stream.
pub enum DeviceCmd {
    Rebuild,
}

struct Voice {
    samples: Arc<Samples>,
    frame: usize,
    generation: u64,
    /// Frames played, for the start ramp.
    age: usize,
    /// Frames left of the stop ramp, once it has begun.
    closing: Option<usize>,
}

/// The editor's voice.
///
/// Different from a sample voice in three ways that all have to be live,
/// because they are sliders: it reads at a variable rate (which is how both
/// the speed and the pitch controls work), it runs through a high cut and a
/// low cut, and it can loop between two points.
struct EditorVoice {
    samples: Arc<Samples>,
    /// Fractional read position, in frames. Fractional because the rate is.
    pos: f64,
    generation: u64,
    age: usize,
    closing: Option<usize>,
    /// Low cut then high cut, per source channel.
    filters: Vec<(Biquad, Biquad)>,
    /// The cutoffs the coefficients above were built for.
    tuned: (f32, f32),
}

struct Mixer {
    active: Option<Voice>,
    editor: Option<EditorVoice>,
    editor_params: EditorParams,
    /// The voice being replaced, finishing its ramp under the new one.
    closing: Option<Voice>,
    volume: f32,
    paused: bool,
    out_channels: usize,
    rate: u32,
    fade_frames: usize,
    shared: Arc<Shared>,
    cmd: Receiver<Cmd>,
    garbage: Sender<Arc<Samples>>,
    /// Mixing scratch for formats that are not f32. Sized once, then reused.
    scratch: Vec<f32>,
}

impl Mixer {
    fn new(
        shared: Arc<Shared>,
        cmd: Receiver<Cmd>,
        garbage: Sender<Arc<Samples>>,
        out_channels: usize,
        rate: u32,
    ) -> Self {
        Self {
            active: None,
            editor: None,
            editor_params: EditorParams::default(),
            closing: None,
            volume: 1.0,
            paused: false,
            out_channels,
            rate,
            fade_frames: ((rate * FADE_MS) / 1000).max(1) as usize,
            shared,
            cmd,
            garbage,
            scratch: Vec::new(),
        }
    }

    /// Hand a finished buffer back to the control side to be dropped.
    ///
    /// If the queue is full the `Arc` dies here, on the audio thread, which is
    /// the one allocation event this design cannot absolutely prevent. The
    /// queue is sized so it does not happen in practice, and a rare late
    /// deallocation is better than leaking every sample ever played.
    fn recycle(&self, samples: Arc<Samples>) {
        let _ = self.garbage.try_send(samples);
    }

    fn apply(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Play {
                samples,
                start_frame,
                generation,
            } => {
                if let Some(mut old) = self.active.take() {
                    old.closing = Some(self.fade_frames);
                    if let Some(stale) = self.closing.replace(old) {
                        self.recycle(stale.samples);
                    }
                }
                let frames = samples.frames();
                self.active = Some(Voice {
                    samples,
                    frame: start_frame.min(frames.saturating_sub(1)),
                    generation,
                    age: 0,
                    closing: None,
                });
                self.paused = false;
                self.shared.editor_owns.store(false, Ordering::Release);
                self.shared.playing.store(true, Ordering::Release);
            }
            Cmd::Stop => {
                if let Some(old) = self.editor.take() {
                    self.recycle(old.samples);
                }
                if let Some(mut old) = self.active.take() {
                    old.closing = Some(self.fade_frames);
                    if let Some(stale) = self.closing.replace(old) {
                        self.recycle(stale.samples);
                    }
                }
                self.shared.playing.store(false, Ordering::Release);
                self.shared.editor_owns.store(false, Ordering::Release);
                self.shared.frame.store(0, Ordering::Release);
            }
            Cmd::Pause => {
                self.paused = true;
                self.shared.playing.store(false, Ordering::Release);
            }
            Cmd::Resume => {
                self.paused = false;
                if let Some(voice) = self.active.as_mut() {
                    // Ramp back in, so resuming mid-waveform does not click
                    // any more than starting there does.
                    voice.age = 0;
                    self.shared.playing.store(true, Ordering::Release);
                }
            }
            Cmd::Seek(frame) => {
                if let Some(voice) = self.editor.as_mut() {
                    let frames = voice.samples.frames();
                    voice.pos = frame.min(frames.saturating_sub(1)) as f64;
                    voice.age = 0;
                    self.shared.frame.store(frame as u64, Ordering::Release);
                }
                if let Some(voice) = self.active.as_mut() {
                    let frames = voice.samples.frames();
                    voice.frame = frame.min(frames.saturating_sub(1));
                    voice.age = 0;
                    self.shared.frame.store(voice.frame as u64, Ordering::Release);
                }
            }
            Cmd::Volume(v) => self.volume = v.clamp(0.0, 4.0),
            Cmd::EditorPlay {
                samples,
                start_frame,
                params,
                generation,
            } => {
                // The editor takes the output; a sample preview underneath it
                // would be two things playing at once.
                if let Some(mut old) = self.active.take() {
                    old.closing = Some(self.fade_frames);
                    if let Some(stale) = self.closing.replace(old) {
                        self.recycle(stale.samples);
                    }
                }
                if let Some(old) = self.editor.take() {
                    self.recycle(old.samples);
                }
                let channels = samples.channels.max(1);
                self.editor_params = params;
                self.editor = Some(EditorVoice {
                    samples,
                    pos: start_frame as f64,
                    generation,
                    age: 0,
                    closing: None,
                    filters: vec![(Biquad::identity(), Biquad::identity()); channels],
                    // Nothing can match this, so the first block retunes.
                    tuned: (f32::NAN, f32::NAN),
                });
                self.paused = false;
                self.shared.editor_owns.store(true, Ordering::Release);
                self.shared.playing.store(true, Ordering::Release);
            }
            Cmd::EditorParams(params) => self.editor_params = params,
        }
    }

    fn drain(&mut self) {
        for _ in 0..CMD_PER_CALLBACK {
            match self.cmd.try_recv() {
                Ok(cmd) => self.apply(cmd),
                Err(_) => return,
            }
        }
    }

    /// Fill `out` with whatever is playing. The whole realtime path.
    fn fill(&mut self, out: &mut [f32]) {
        self.drain();
        for slot in out.iter_mut() {
            *slot = 0.0;
        }
        let channels = self.out_channels;
        if channels == 0 {
            return;
        }
        let frames = out.len() / channels;

        if !self.paused {
            if let Some(mut voice) = self.active.take() {
                let done = mix(&mut voice, out, frames, channels, self.volume, self.fade_frames);
                if done {
                    self.shared
                        .ended
                        .store(voice.generation, Ordering::Release);
                    self.shared.playing.store(false, Ordering::Release);
                    self.recycle(voice.samples);
                } else {
                    self.shared.frame.store(voice.frame as u64, Ordering::Release);
                    self.active = Some(voice);
                }
            }
        }

        if !self.paused {
            if let Some(mut voice) = self.editor.take() {
                let params = self.editor_params;
                let done = mix_editor(
                    &mut voice,
                    &params,
                    out,
                    frames,
                    channels,
                    self.fade_frames,
                    self.rate,
                    &self.shared,
                );
                if done {
                    self.shared.ended.store(voice.generation, Ordering::Release);
                    self.shared.playing.store(false, Ordering::Release);
                    self.recycle(voice.samples);
                } else {
                    self.shared.frame.store(voice.pos as u64, Ordering::Release);
                    self.editor = Some(voice);
                }
            }
        }

        if let Some(mut voice) = self.closing.take() {
            let done = mix(&mut voice, out, frames, channels, self.volume, self.fade_frames);
            if done {
                self.recycle(voice.samples);
            } else {
                self.closing = Some(voice);
            }
        }
    }

    /// For devices that do not take f32 natively.
    fn fill_converted<T>(&mut self, out: &mut [T])
    where
        T: cpal::Sample + cpal::FromSample<f32>,
    {
        let len = out.len();
        // Lifted out of `self` so the mixer can borrow itself for the fill,
        // and put back below. Taking a `Vec` costs nothing and allocates
        // nothing; the resize happens on the first callback of a stream and
        // never again.
        let mut scratch = std::mem::take(&mut self.scratch);
        if scratch.len() < len {
            scratch.resize(len, 0.0);
        }
        self.fill(&mut scratch[..len]);
        for (dst, src) in out.iter_mut().zip(scratch[..len].iter()) {
            *dst = T::from_sample(*src);
        }
        self.scratch = scratch;
    }
}

/// Mix one voice into `out`. Returns true when the voice is finished.
fn mix(
    voice: &mut Voice,
    out: &mut [f32],
    frames: usize,
    channels: usize,
    volume: f32,
    fade_frames: usize,
) -> bool {
    let total = voice.samples.frames();
    let src_channels = voice.samples.channels;
    if src_channels == 0 {
        return true;
    }
    let fade = fade_frames.max(1) as f32;

    for f in 0..frames {
        if voice.frame >= total {
            return true;
        }
        // A stop ramp overrides the start ramp: the voice is on its way out.
        let gain = match voice.closing.as_mut() {
            Some(left) => {
                if *left == 0 {
                    return true;
                }
                *left -= 1;
                volume * (*left as f32 / fade)
            }
            None => {
                let ramp = (voice.age.min(fade_frames) as f32) / fade;
                voice.age += 1;
                volume * ramp
            }
        };

        let base = voice.frame * src_channels;
        for c in 0..channels {
            // Mono fills every output channel; anything wider is taken
            // channel-for-channel and clamped, so a 5.1 file previews through
            // a stereo device instead of failing to play at all.
            let sample = voice.samples.data[base + c.min(src_channels - 1)];
            out[f * channels + c] += sample * gain;
        }
        voice.frame += 1;
    }
    false
}

/// Read a source channel at a fractional position, Catmull-Rom.
///
/// The rate control and the pitch control are the same thing here — both move
/// the read head at something other than one frame per frame — so this runs
/// for every sample the editor plays. Linear interpolation would be cheaper
/// and would put audible grit on anything transposed; four-point costs a
/// handful of multiplies and does not.
fn sample_at(data: &[f32], channels: usize, channel: usize, pos: f64, frames: usize) -> f32 {
    if frames == 0 {
        return 0.0;
    }
    let i = pos.floor() as isize;
    let frac = (pos - i as f64) as f32;
    let at = |k: isize| -> f32 {
        let k = k.clamp(0, frames as isize - 1) as usize;
        data[k * channels + channel]
    };
    let (y0, y1, y2, y3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
    let a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    let b = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c = -0.5 * y0 + 0.5 * y2;
    ((a * frac + b) * frac + c) * frac + y1
}

/// Mix the editor's voice. Returns true when it has finished.
#[allow(clippy::too_many_arguments)]
fn mix_editor(
    voice: &mut EditorVoice,
    params: &EditorParams,
    out: &mut [f32],
    frames: usize,
    channels: usize,
    fade_frames: usize,
    rate: u32,
    shared: &Shared,
) -> bool {
    let total = voice.samples.frames();
    let src_channels = voice.samples.channels.max(1);
    if total == 0 {
        return true;
    }

    // Cutoffs are sliders, so the coefficients are rebuilt whenever they
    // move — but the delay line is kept, or every step of a sweep clicks.
    if voice.tuned != (params.low_cut, params.high_cut) {
        let rate_f = rate as f32;
        for (high_pass, low_pass) in voice.filters.iter_mut() {
            high_pass.retune(Biquad::highpass(params.low_cut, 1.0, rate_f));
            low_pass.retune(Biquad::lowpass(params.high_cut, 1.0, rate_f));
        }
        voice.tuned = (params.low_cut, params.high_cut);
    }

    let fade = fade_frames.max(1) as f32;
    let looping = params.loop_on && params.loop_end > params.loop_start;
    let mut scratch = [0.0f32; 8];
    let active = src_channels.min(scratch.len());
    let (mut peak_l, mut peak_r) = (0.0f32, 0.0f32);

    for f in 0..frames {
        if looping {
            let end = params.loop_end as f64;
            if voice.pos >= end {
                let len = (params.loop_end - params.loop_start) as f64;
                voice.pos = params.loop_start as f64 + (voice.pos - end) % len;
            }
        } else if voice.pos >= total as f64 {
            store_peaks(shared, peak_l, peak_r);
            return true;
        }

        let gain = match voice.closing.as_mut() {
            Some(left) => {
                if *left == 0 {
                    store_peaks(shared, peak_l, peak_r);
                    return true;
                }
                *left -= 1;
                *left as f32 / fade
            }
            None => {
                let ramp = (voice.age.min(fade_frames) as f32) / fade;
                voice.age += 1;
                ramp
            }
        } * params.volume;

        // Filtered once per source channel, then distributed. Running the
        // filter per *output* channel would process a mono source twice per
        // frame and halve its cutoff.
        for (c, slot) in scratch.iter_mut().enumerate().take(active) {
            let raw = sample_at(&voice.samples.data, src_channels, c, voice.pos, total);
            let (high_pass, low_pass) = &mut voice.filters[c];
            *slot = low_pass.process(high_pass.process(raw));
        }

        for c in 0..channels {
            let value = scratch[c.min(active - 1)] * gain;
            out[f * channels + c] += value;
            match c {
                0 => peak_l = peak_l.max(value.abs()),
                1 => peak_r = peak_r.max(value.abs()),
                _ => {}
            }
        }

        voice.pos += f64::from(params.rate.max(0.01));
    }

    store_peaks(shared, peak_l, peak_r);
    false
}

/// Publish the loudest sample since the meter was last read.
///
/// `fetch_max` on the bit pattern is valid because both sides are
/// non-negative, and IEEE-754 orders non-negative floats the same way their
/// bits order as integers. The reader clears it, so a peak between two reads
/// cannot be lost to a slow animation frame.
fn store_peaks(shared: &Shared, left: f32, right: f32) {
    shared.peak_left.fetch_max(left.to_bits(), Ordering::AcqRel);
    shared.peak_right.fetch_max(right.to_bits(), Ordering::AcqRel);
}

/// Spawn the thread that owns the output stream.
pub fn spawn(
    shared: Arc<Shared>,
    cmd: Receiver<Cmd>,
    garbage: Sender<Arc<Samples>>,
) -> Sender<DeviceCmd> {
    let (device_tx, device_rx) = crossbeam_channel::unbounded::<DeviceCmd>();
    let faults = device_tx.clone();

    std::thread::Builder::new()
        .name("stack-audio".into())
        .spawn(move || {
            let mut stream: Option<cpal::Stream> = None;
            let mut last_device = String::new();

            loop {
                if stream.is_none() {
                    match build(&shared, &cmd, &garbage, &faults) {
                        Ok((built, name)) => {
                            if let Err(e) = built.play() {
                                tracing::warn!("audio: stream would not start: {e}");
                            } else {
                                shared.device_failed.store(false, Ordering::Release);
                                last_device = name;
                                stream = Some(built);
                            }
                        }
                        Err(e) => {
                            tracing::warn!("audio: no output device: {e}");
                            shared.device_failed.store(true, Ordering::Release);
                        }
                    }
                }

                match device_rx.recv_timeout(DEVICE_POLL) {
                    Ok(DeviceCmd::Rebuild) => {
                        // Dropping the stream closes it; the next pass builds
                        // a replacement against whatever the default is now.
                        stream = None;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // The honest version of the device check the webview
                        // could never do: ask the host what the default
                        // output actually is, rather than inferring it from a
                        // latency figure that may be invented.
                        if stream.is_some() && default_output_name() != last_device {
                            tracing::info!("audio: default output changed, rebuilding");
                            stream = None;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .expect("spawn audio thread");

    device_tx
}

fn default_output_name() -> String {
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default()
}

fn build(
    shared: &Arc<Shared>,
    cmd: &Receiver<Cmd>,
    garbage: &Sender<Arc<Samples>>,
    faults: &Sender<DeviceCmd>,
) -> Result<(cpal::Stream, String), String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;
    let name = device.name().unwrap_or_else(|_| "unknown".into());
    let supported = device
        .default_output_config()
        .map_err(|e| format!("default config: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let rate = config.sample_rate.0;
    let channels = config.channels as usize;

    shared.device_rate.store(rate, Ordering::Release);
    shared.device_channels.store(channels as u32, Ordering::Release);
    *shared.device_name.lock() = name.clone();
    shared.device_generation.fetch_add(1, Ordering::Release);

    // A clone per stream. The queue is shared, so commands sent while a
    // rebuild is in flight are picked up by the replacement rather than lost.
    let mut mixer = Mixer::new(
        shared.clone(),
        cmd.clone(),
        garbage.clone(),
        channels,
        rate,
    );

    let on_error = {
        let faults = faults.clone();
        move |err| {
            tracing::warn!("audio: stream error: {err}");
            let _ = faults.send(DeviceCmd::Rebuild);
        }
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config,
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| mixer.fill(out),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config,
            move |out: &mut [i16], _: &cpal::OutputCallbackInfo| mixer.fill_converted(out),
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_output_stream(
            &config,
            move |out: &mut [u16], _: &cpal::OutputCallbackInfo| mixer.fill_converted(out),
            on_error,
            None,
        ),
        other => return Err(format!("unsupported sample format {other:?}")),
    }
    .map_err(|e| format!("build stream: {e}"))?;

    tracing::info!("audio: output {name} at {rate}Hz, {channels}ch, {sample_format:?}");
    Ok((stream, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::bounded;

    fn tone(frames: usize, rate: u32) -> Arc<Samples> {
        let mut data = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            let v = (std::f32::consts::TAU * 440.0 * f as f32 / rate as f32).sin() * 0.8;
            data.push(v);
            data.push(v);
        }
        Arc::new(Samples {
            data,
            channels: 2,
            rate,
        })
    }

    /// Run the mixer for roughly `blocks` callbacks and report the loudest
    /// sample it produced.
    fn drive(mixer: &mut Mixer, blocks: usize) -> f32 {
        let mut out = vec![0.0f32; 512 * 2];
        let mut peak = 0.0f32;
        for _ in 0..blocks {
            mixer.fill(&mut out);
            for sample in &out {
                peak = peak.max(sample.abs());
            }
        }
        peak
    }

    fn rig(rate: u32) -> (Sender<Cmd>, Mixer, Arc<Shared>, Receiver<Arc<Samples>>) {
        let shared = Arc::new(Shared::new());
        let (cmd_tx, cmd_rx) = bounded::<Cmd>(16);
        let (gc_tx, gc_rx) = bounded::<Arc<Samples>>(16);
        let mixer = Mixer::new(shared.clone(), cmd_rx, gc_tx, 2, rate);
        (cmd_tx, mixer, shared, gc_rx)
    }

    #[test]
    fn the_sample_voice_produces_audio() {
        let rate = 48_000;
        let (cmd, mut mixer, shared, _gc) = rig(rate);
        cmd.send(Cmd::Play {
            samples: tone(rate as usize, rate),
            start_frame: 0,
            generation: 1,
        })
        .unwrap();
        let peak = drive(&mut mixer, 20);
        assert!(peak > 0.1, "sample voice was silent, peak {peak}");
        assert!(shared.playing.load(Ordering::Acquire));
    }

    #[test]
    fn the_editor_voice_produces_audio() {
        let rate = 48_000;
        let (cmd, mut mixer, shared, _gc) = rig(rate);
        cmd.send(Cmd::EditorPlay {
            samples: tone(rate as usize, rate),
            start_frame: 0,
            params: EditorParams::default(),
            generation: 1,
        })
        .unwrap();
        let peak = drive(&mut mixer, 20);
        assert!(peak > 0.1, "editor voice was silent, peak {peak}");
        assert!(shared.editor_owns.load(Ordering::Acquire));
        assert!(shared.playing.load(Ordering::Acquire));
    }

    #[test]
    fn the_editor_voice_feeds_the_meter() {
        let rate = 48_000;
        let (cmd, mut mixer, shared, _gc) = rig(rate);
        cmd.send(Cmd::EditorPlay {
            samples: tone(rate as usize, rate),
            start_frame: 0,
            params: EditorParams::default(),
            generation: 1,
        })
        .unwrap();
        drive(&mut mixer, 20);
        let left = f32::from_bits(shared.peak_left.load(Ordering::Acquire));
        assert!(left > 0.1, "meter read {left}");
    }

    /// A stop must silence the editor, not just the sample voice.
    #[test]
    fn stopping_clears_the_editor_voice() {
        let rate = 48_000;
        let (cmd, mut mixer, shared, _gc) = rig(rate);
        cmd.send(Cmd::EditorPlay {
            samples: tone(rate as usize, rate),
            start_frame: 0,
            params: EditorParams::default(),
            generation: 1,
        })
        .unwrap();
        drive(&mut mixer, 10);
        cmd.send(Cmd::Stop).unwrap();
        let peak = drive(&mut mixer, 10);
        assert!(peak < 1e-6, "still sounding after stop, peak {peak}");
        assert!(!shared.editor_owns.load(Ordering::Acquire));
    }
}
