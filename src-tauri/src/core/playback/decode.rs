//! A file on disk turned into interleaved f32 at the output device's rate.
//!
//! Decoding lives here rather than in the webview because the webview was
//! decoding whole files on the main thread: a fifteen-second stereo loop is
//! roughly six megabytes of Float32, fetched over the asset protocol and
//! handed to `decodeAudioData`, and seven of those ran in parallel every time
//! the selection moved. Symphonia already reads every format this app indexes,
//! so the decoder the library was built on is the decoder playback uses.

use std::path::Path;
use std::sync::Arc;

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::error::{Result, StackError};

/// How many frames the resampler works on at a time.
const RESAMPLE_CHUNK: usize = 1024;

/// A decoded sample: interleaved f32, at a known rate and channel count.
#[derive(Debug)]
pub struct Samples {
    pub data: Vec<f32>,
    pub channels: usize,
    pub rate: u32,
}

impl Samples {
    pub fn frames(&self) -> usize {
        self.data.len().checked_div(self.channels).unwrap_or(0)
    }

    pub fn duration_secs(&self) -> f64 {
        if self.rate == 0 {
            0.0
        } else {
            self.frames() as f64 / f64::from(self.rate)
        }
    }

    /// What this weighs in memory, for the cache's byte ceiling.
    pub fn bytes(&self) -> usize {
        self.data.len() * std::mem::size_of::<f32>()
    }
}

/// Decode `path` and deliver it at `target_rate`, ready to copy into the
/// output buffer without further work on the audio thread.
pub fn decode(path: &Path, target_rate: u32) -> Result<Arc<Samples>> {
    let file = std::fs::File::open(path)?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    // The extension is a hint, not a decision: symphonia probes the bytes and
    // a mislabelled file still decodes.
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| StackError::Other(format!("probe: {e}")))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| StackError::Other("no decodable audio track".into()))?;
    let track_id = track.id;
    let source_rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| StackError::Other(format!("codec: {e}")))?;

    let mut interleaved: Vec<f32> = Vec::new();
    let mut scratch: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // The clean end of the stream, and the only one symphonia reports
            // as an error.
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(StackError::Other(format!("read: {e}"))),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio) => {
                if scratch.is_none() {
                    scratch = Some(SampleBuffer::<f32>::new(
                        audio.capacity() as u64,
                        *audio.spec(),
                    ));
                }
                if let Some(buf) = scratch.as_mut() {
                    buf.copy_interleaved_ref(audio);
                    interleaved.extend_from_slice(buf.samples());
                }
            }
            // A damaged packet is not a damaged file. Skip it and keep going,
            // the way every player that survives a real library does.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(StackError::Other(format!("decode: {e}"))),
        }
    }

    if interleaved.is_empty() {
        return Err(StackError::Other("decoded to nothing".into()));
    }

    let data = if source_rate == target_rate {
        interleaved
    } else {
        resample(&interleaved, channels, source_rate, target_rate)?
    };

    Ok(Arc::new(Samples {
        data,
        channels,
        rate: target_rate,
    }))
}

/// Rate-convert once, here, so the audio callback is a copy and nothing else.
///
/// Interpolating in the callback would be cheaper to write and worse to hear:
/// a 44.1k loop against a 48k device is the common case in this library, and
/// linear interpolation on the realtime thread is where the aliasing nobody
/// can quite describe comes from. A windowed sinc, run once at decode time
/// and cached, costs nothing per play.
fn resample(data: &[f32], channels: usize, from: u32, to: u32) -> Result<Vec<f32>> {
    let frames = data.len() / channels;
    if frames == 0 {
        return Ok(Vec::new());
    }

    // Rubato works channel-at-a-time; the decoder gave us frames.
    let mut planar: Vec<Vec<f32>> = vec![Vec::with_capacity(frames); channels];
    for f in 0..frames {
        for (c, chan) in planar.iter_mut().enumerate() {
            chan.push(data[f * channels + c]);
        }
    }

    let ratio = f64::from(to) / f64::from(from);
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, RESAMPLE_CHUNK, channels)
        .map_err(|e| StackError::Other(format!("resampler: {e}")))?;

    let mut out_planar: Vec<Vec<f32>> = vec![Vec::new(); channels];
    let mut pos = 0usize;
    while pos < frames {
        let take = RESAMPLE_CHUNK.min(frames - pos);
        // The last chunk is zero-padded to a full block, and only the frames
        // that correspond to real input are kept.
        let chunk: Vec<Vec<f32>> = planar
            .iter()
            .map(|chan| {
                let mut v = chan[pos..pos + take].to_vec();
                v.resize(RESAMPLE_CHUNK, 0.0);
                v
            })
            .collect();
        let produced = resampler
            .process(&chunk, None)
            .map_err(|e| StackError::Other(format!("resample: {e}")))?;
        let keep = if take == RESAMPLE_CHUNK {
            usize::MAX
        } else {
            (take as f64 * ratio).round() as usize
        };
        for (c, chan) in produced.into_iter().enumerate() {
            let end = keep.min(chan.len());
            out_planar[c].extend_from_slice(&chan[..end]);
        }
        pos += take;
    }

    let out_frames = out_planar.first().map_or(0, Vec::len);
    let mut out = Vec::with_capacity(out_frames * channels);
    for f in 0..out_frames {
        for chan in &out_planar {
            out.push(chan.get(f).copied().unwrap_or(0.0));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write a sine to a real WAV, so the test exercises the actual symphonia
    /// path rather than a hand-built buffer.
    fn sine_wav(dir: &Path, rate: u32, secs: f64, channels: u16) -> std::path::PathBuf {
        let path = dir.join(format!("sine_{rate}_{channels}.wav"));
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("create wav");
        let frames = (f64::from(rate) * secs) as usize;
        for f in 0..frames {
            let t = f as f64 / f64::from(rate);
            let v = (t * 440.0 * std::f64::consts::TAU).sin();
            let s = (v * 16_000.0) as i16;
            for _ in 0..channels {
                writer.write_sample(s).expect("write");
            }
        }
        writer.finalize().expect("finalize");
        path
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("stack-decode-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmpdir");
        dir
    }

    #[test]
    fn decodes_at_native_rate_without_touching_the_samples() {
        let dir = tmpdir("native");
        let path = sine_wav(&dir, 48_000, 0.5, 2);
        let out = decode(&path, 48_000).expect("decode");
        assert_eq!(out.rate, 48_000);
        assert_eq!(out.channels, 2);
        // No resampler in the path, so the frame count is exact.
        assert_eq!(out.frames(), 24_000);
        assert!((out.duration_secs() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn resamples_44k_to_the_device_rate() {
        let dir = tmpdir("resample");
        let path = sine_wav(&dir, 44_100, 1.0, 2);
        let out = decode(&path, 48_000).expect("decode");
        assert_eq!(out.rate, 48_000);
        assert_eq!(out.channels, 2);
        // A windowed sinc has latency, so the length lands near the ideal
        // rather than exactly on it. Within a few milliseconds is correct.
        let ideal = 48_000f64;
        let got = out.frames() as f64;
        assert!(
            (got - ideal).abs() < 1_000.0,
            "resampled to {got} frames, expected about {ideal}"
        );
        // And it must still be audio, not silence or a buffer of NaN.
        let peak = out.data.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.2, "resampled peak was {peak}");
        assert!(out.data.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn mono_stays_mono_and_reports_one_channel() {
        let dir = tmpdir("mono");
        let path = sine_wav(&dir, 48_000, 0.25, 1);
        let out = decode(&path, 48_000).expect("decode");
        assert_eq!(out.channels, 1);
        assert_eq!(out.frames(), 12_000);
    }

    #[test]
    fn a_file_that_is_not_audio_is_an_error_not_a_panic() {
        let dir = tmpdir("garbage");
        let path = dir.join("not-audio.wav");
        std::fs::write(&path, vec![0u8; 8192]).expect("write");
        assert!(decode(&path, 48_000).is_err());
    }
}
