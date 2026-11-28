//! Where the backend's own log goes.
//!
//! `tracing_subscriber::fmt()` writes to stdout, and an installed app's
//! stdout is `/dev/null`. So every warning the audio thread has ever raised —
//! no output device, the stream would not start, the stream faulted — was
//! produced and discarded in the same instant, on every machine that has ever
//! run this app. That is the entire evidence base for "I hear nothing", and
//! there has never been any.
//!
//! It goes to the same file the webview dumps its event ring into, because a
//! fault is one story told from two sides and nobody collecting a log should
//! have to know there are two of them.

use std::io::Write;
use std::path::PathBuf;

/// Past this, the file is emptied rather than grown. Only the most recent
/// episode is ever of interest and an unbounded log in someone's application
/// data is litter. The frontend's `append_audio_log` uses the same figure.
const MAX_BYTES: u64 = 2_000_000;

/// A writer that opens the file for each record.
///
/// One `open` per event costs nothing at the handful of lines a session
/// produces, and it buys the property that matters: the frontend truncates
/// this same file when it outgrows the cap, and a long-lived handle would go
/// on writing at its old offset into a file that is no longer there, leaving
/// a megabyte of NUL in front of the evidence.
pub struct Writer(PathBuf);

impl Write for Writer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if std::fs::metadata(&self.0).map(|m| m.len()).unwrap_or(0) >= MAX_BYTES {
            let _ = std::fs::write(&self.0, b"");
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.0)?;
        file.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct Maker(PathBuf);

impl Maker {
    /// `dir` is the app data directory; the file sits beside the webview's.
    pub fn new(dir: &std::path::Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        Self(dir.join("audio-log.txt"))
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Maker {
    type Writer = Writer;

    fn make_writer(&'a self) -> Self::Writer {
        Writer(self.0.clone())
    }
}
