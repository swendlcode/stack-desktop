//! Sample playback, owned by the backend.
//!
//! This replaces a Web Audio engine that could not be trusted and could not
//! be measured. On WKWebView an `AudioContext` will sit in `running`, keep
//! its clock to three decimal places, report an unchanged output device and
//! show signal on a tap in its own graph, while rendering to nothing — and
//! the analyser that would have caught it sits before the destination by
//! construction, so no instrument available inside the webview can tell that
//! state apart from health. Four releases of detection and rebuild logic were
//! written against that, and each one was routed around.
//!
//! Here the output device is held directly. There is no state to infer: the
//! host says which device is default, cpal says whether the stream opened,
//! and the frame counter in the callback is the playhead rather than a proxy
//! for it.
//!
//! The webview keeps its own Web Audio path for browser mode, where the
//! library is served over the network and this process's speakers are the
//! wrong ones.

mod cache;
mod decode;
pub mod editor;
mod filter;
mod output;
mod synth;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use serde::Serialize;

use crate::error::{Result, StackError};
use cache::Cache;
use decode::Samples;
use editor::Editor;
use output::{Cmd, DeviceCmd, Shared};
pub use synth::MidiNote;

/// Commands queued toward the audio thread before one is dropped.
const CMD_QUEUE: usize = 64;
/// Finished buffers waiting to be freed off the realtime thread.
const GARBAGE_QUEUE: usize = 64;
/// How long `play` will wait for the device to come up from cold.
const DEVICE_WAIT: Duration = Duration::from_millis(1500);

/// Everything the frontend needs to draw the transport.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub playing: bool,
    pub path: Option<String>,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub generation: u64,
    pub ended_generation: u64,
    pub device_name: String,
    pub device_rate: u32,
    pub device_failed: bool,
    pub cached: usize,
    pub cached_bytes: usize,
    /// True while the sample editor is the one sounding, so the browser's
    /// transport knows these position reports are not about it.
    pub editor_owns: bool,
}

pub struct Player {
    cmd: Sender<Cmd>,
    device: Sender<DeviceCmd>,
    shared: Arc<Shared>,
    cache: Mutex<Cache>,
    generation: AtomicU64,
    current: Mutex<Option<(PathBuf, f64)>>,
    /// The sample editor shares this output, and only one of them sounds at
    /// a time — opening the editor pauses the browser's playback anyway.
    editor: Editor,
}

impl Player {
    pub fn new() -> Arc<Self> {
        let shared = Arc::new(Shared::new());
        let (cmd_tx, cmd_rx) = bounded::<Cmd>(CMD_QUEUE);
        let (garbage_tx, garbage_rx) = bounded::<Arc<Samples>>(GARBAGE_QUEUE);
        let device = output::spawn(shared.clone(), cmd_rx, garbage_tx);

        // Buffers finished with on the audio thread are freed here, where a
        // deallocation costs nobody a glitch.
        std::thread::Builder::new()
            .name("stack-audio-gc".into())
            .spawn(move || drain_garbage(&garbage_rx))
            .expect("spawn audio gc");

        Arc::new(Self {
            editor: Editor::new(cmd_tx.clone(), shared.clone()),
            cmd: cmd_tx,
            device,
            shared,
            cache: Mutex::new(Cache::new()),
            generation: AtomicU64::new(0),
            current: Mutex::new(None),
        })
    }

    pub fn editor(&self) -> &Editor {
        &self.editor
    }

    /// The device's rate, waiting briefly for the stream to come up cold.
    pub fn output_rate(&self) -> Result<u32> {
        self.device_rate()
    }

    /// The device's rate, waiting briefly for the stream to come up cold.
    fn device_rate(&self) -> Result<u32> {
        let deadline = Instant::now() + DEVICE_WAIT;
        loop {
            let rate = self.shared.device_rate.load(Ordering::Acquire);
            if rate > 0 {
                return Ok(rate);
            }
            if Instant::now() >= deadline {
                return Err(StackError::Other("no audio output device".into()));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Decode if needed and return the samples, at the device's current rate.
    fn samples_for(&self, path: &PathBuf) -> Result<Arc<Samples>> {
        let rate = self.device_rate()?;
        {
            let mut cache = self.cache.lock();
            // A device change that moves the rate invalidates every decoded
            // buffer, because the callback copies frames rather than
            // converting them.
            cache.retune(rate);
            if let Some(hit) = cache.get(path) {
                return Ok(hit);
            }
        }
        let samples = decode::decode(path, rate)?;
        self.cache.lock().insert(path.clone(), samples.clone());
        Ok(samples)
    }

    /// Start `path` at `offset_sec`. Blocking: call it off the UI thread.
    pub fn play(&self, path: PathBuf, offset_sec: f64) -> Result<PlaybackState> {
        let samples = self.samples_for(&path)?;
        let rate = samples.rate.max(1);
        let start = (offset_sec.max(0.0) * f64::from(rate)) as usize;
        // An offset at or past the end means play it again, not play silence.
        let start = if start >= samples.frames() { 0 } else { start };
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let duration = samples.duration_secs();

        self.send(Cmd::Play {
            samples,
            start_frame: start,
            generation,
        })?;
        *self.current.lock() = Some((path, duration));
        Ok(self.state())
    }

    /// Render a MIDI performance and play it.
    ///
    /// It goes through the same mixer as a sample, so it inherits the start
    /// and stop ramps, the exact playhead, seek, pause and the end event. The
    /// render is why this is blocking: call it off the UI thread.
    pub fn play_midi(
        &self,
        notes: &[MidiNote],
        duration_sec: f64,
        offset_sec: f64,
    ) -> Result<PlaybackState> {
        let rate = self.device_rate()?;
        // Rendered from the top, then started partway in. Rendering from the
        // offset instead would make every reported position relative to it,
        // so the playhead would read zero after a seek and the UI would have
        // to carry the difference around. It also sounds better: a note
        // struck before the seek point is heard mid-decay rather than
        // clipped out of existence.
        let samples = Arc::new(synth::render(notes, duration_sec, 0.0, rate));
        let start_frame = (offset_sec.max(0.0) * f64::from(rate)) as usize;
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.send(Cmd::Play {
            samples,
            start_frame,
            generation,
        })?;
        // The piece's length, not the buffer's. The render runs past the
        // end so the final notes decay instead of being cut off, and a
        // progress bar that counted that tail would never reach its end.
        *self.current.lock() = Some((PathBuf::from("<midi>"), duration_sec));
        Ok(self.state())
    }

    /// A short sine, straight into the mixer.
    ///
    /// It decodes nothing and reads no file, so it answers exactly one
    /// question: is the output device producing sound at all? That was never
    /// separable from "can this sample be decoded and started" while the
    /// webview owned playback.
    pub fn test_tone(&self) -> Result<PlaybackState> {
        let rate = self.device_rate()?;
        let frames = (rate as usize * 3) / 10;
        let mut data = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            let t = f as f64 / f64::from(rate);
            // Decaying, so the tone cannot itself be mistaken for a click.
            let env = 1.0 - (f as f64 / frames as f64);
            let v = ((t * 440.0 * std::f64::consts::TAU).sin() * 0.25 * env) as f32;
            data.push(v);
            data.push(v);
        }
        let samples = Arc::new(Samples {
            data,
            channels: 2,
            rate,
        });
        let duration = samples.duration_secs();
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.send(Cmd::Play {
            samples,
            start_frame: 0,
            generation,
        })?;
        *self.current.lock() = Some((PathBuf::from("<test tone>"), duration));
        Ok(self.state())
    }

    /// Decode ahead of a press, without disturbing what is playing.
    pub fn prefetch(&self, path: PathBuf) -> Result<()> {
        self.samples_for(&path).map(|_| ())
    }

    pub fn stop(&self) -> Result<()> {
        *self.current.lock() = None;
        self.send(Cmd::Stop)
    }

    pub fn pause(&self) -> Result<()> {
        self.send(Cmd::Pause)
    }

    pub fn resume(&self) -> Result<()> {
        self.send(Cmd::Resume)
    }

    pub fn seek(&self, position_sec: f64) -> Result<()> {
        let rate = self.shared.device_rate.load(Ordering::Acquire).max(1);
        let frame = (position_sec.max(0.0) * f64::from(rate)) as usize;
        self.send(Cmd::Seek(frame))
    }

    pub fn set_volume(&self, volume: f32) -> Result<()> {
        self.send(Cmd::Volume(volume))
    }

    /// Drop decoded buffers for files that have left the disk or changed.
    pub fn forget(&self, paths: &[PathBuf]) {
        self.cache.lock().forget(paths);
    }

    /// Rebuild the output stream. The device thread does this by itself when
    /// the default moves; this is for a user asking explicitly.
    pub fn reopen_device(&self) -> Result<()> {
        self.device
            .send(DeviceCmd::Rebuild)
            .map_err(|_| StackError::Other("audio thread is gone".into()))
    }

    pub fn state(&self) -> PlaybackState {
        let rate = self.shared.device_rate.load(Ordering::Acquire);
        let frame = self.shared.frame.load(Ordering::Acquire);
        let current = self.current.lock().clone();
        let (cached, cached_bytes) = self.cache.lock().stats();
        PlaybackState {
            playing: self.shared.playing.load(Ordering::Acquire),
            path: current.as_ref().map(|(p, _)| p.to_string_lossy().into_owned()),
            position_sec: if rate > 0 {
                frame as f64 / f64::from(rate)
            } else {
                0.0
            },
            duration_sec: current.map_or(0.0, |(_, d)| d),
            generation: self.generation.load(Ordering::Acquire),
            ended_generation: self.shared.ended.load(Ordering::Acquire),
            device_name: self.shared.device_name.lock().clone(),
            device_rate: rate,
            device_failed: self.shared.device_failed.load(Ordering::Acquire),
            cached,
            cached_bytes,
            editor_owns: self.shared.editor_owns.load(Ordering::Acquire),
        }
    }

    fn send(&self, cmd: Cmd) -> Result<()> {
        self.cmd
            .try_send(cmd)
            .map_err(|e| StackError::Other(format!("audio command queue: {e}")))
    }
}

fn drain_garbage(rx: &Receiver<Arc<Samples>>) {
    while rx.recv().is_ok() {
        // Dropped here, on purpose, off the realtime thread.
    }
}
