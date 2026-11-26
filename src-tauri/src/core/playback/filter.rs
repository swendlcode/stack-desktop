//! Biquads, shared by the MIDI voice and the editor.
//!
//! Coefficients are the RBJ cookbook forms, which is what `BiquadFilterNode`
//! implements — so a high cut set to 4kHz here and in the browser build are
//! the same filter, not two things that sound similar.

/// A direct-form-1 biquad.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    /// Bypass: passes the signal through untouched.
    pub fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn shape(freq: f32, q: f32, rate: f32) -> (f32, f32, f32) {
        // Clamped below Nyquist: a cutoff at or above it has no meaningful
        // coefficients and produces NaN that then propagates for ever
        // through the filter's own history.
        let w0 = std::f32::consts::TAU * (freq / rate).clamp(1e-5, 0.49);
        let (sin, cos) = w0.sin_cos();
        (sin, cos, sin / (2.0 * q.max(1e-4)))
    }

    pub fn lowpass(freq: f32, q: f32, rate: f32) -> Self {
        let (_, cos, alpha) = Self::shape(freq, q, rate);
        let a0 = 1.0 + alpha;
        Self {
            b0: ((1.0 - cos) / 2.0) / a0,
            b1: (1.0 - cos) / a0,
            b2: ((1.0 - cos) / 2.0) / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha) / a0,
            ..Self::identity()
        }
    }

    pub fn highpass(freq: f32, q: f32, rate: f32) -> Self {
        let (_, cos, alpha) = Self::shape(freq, q, rate);
        let a0 = 1.0 + alpha;
        Self {
            b0: ((1.0 + cos) / 2.0) / a0,
            b1: (-(1.0 + cos)) / a0,
            b2: ((1.0 + cos) / 2.0) / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha) / a0,
            ..Self::identity()
        }
    }

    pub fn bandpass(freq: f32, q: f32, rate: f32) -> Self {
        let (_, cos, alpha) = Self::shape(freq, q, rate);
        let a0 = 1.0 + alpha;
        Self {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha) / a0,
            ..Self::identity()
        }
    }

    /// Replace the response, keeping the history.
    ///
    /// Dragging a cutoff slider rebuilds coefficients many times a second.
    /// Resetting the delay line with them would click on every step, which
    /// is exactly what an automated filter sweep must not do.
    pub fn retune(&mut self, next: Self) {
        self.b0 = next.b0;
        self.b1 = next.b1;
        self.b2 = next.b2;
        self.a1 = next.a1;
        self.a2 = next.a2;
    }

    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        // A denormal or a NaN sneaking into the history poisons every later
        // sample, and the only cure once it is in there is a reset.
        if !y.is_finite() {
            *self = Self {
                x1: 0.0,
                x2: 0.0,
                y1: 0.0,
                y2: 0.0,
                ..*self
            };
            return 0.0;
        }
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(mut f: Biquad, input: &[f32]) -> Vec<f32> {
        input.iter().map(|x| f.process(*x)).collect()
    }

    fn rms(v: &[f32]) -> f32 {
        (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt()
    }

    fn tone(freq: f32, rate: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (std::f32::consts::TAU * freq * i as f32 / rate).sin())
            .collect()
    }

    #[test]
    fn lowpass_keeps_lows_and_removes_highs() {
        let rate = 48_000.0;
        let low = run(Biquad::lowpass(1_000.0, 0.707, rate), &tone(100.0, rate, 4800));
        let high = run(Biquad::lowpass(1_000.0, 0.707, rate), &tone(12_000.0, rate, 4800));
        assert!(rms(&low) > 0.6, "low rms {}", rms(&low));
        assert!(rms(&high) < 0.05, "high rms {}", rms(&high));
    }

    #[test]
    fn highpass_does_the_opposite() {
        let rate = 48_000.0;
        let low = run(Biquad::highpass(1_000.0, 0.707, rate), &tone(60.0, rate, 4800));
        let high = run(Biquad::highpass(1_000.0, 0.707, rate), &tone(8_000.0, rate, 4800));
        assert!(rms(&low) < 0.05, "low rms {}", rms(&low));
        assert!(rms(&high) > 0.6, "high rms {}", rms(&high));
    }

    #[test]
    fn a_cutoff_above_nyquist_does_not_produce_nan() {
        let rate = 48_000.0;
        let out = run(Biquad::lowpass(96_000.0, 0.707, rate), &tone(440.0, rate, 512));
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn identity_passes_the_signal_through() {
        let input = tone(440.0, 48_000.0, 256);
        let out = run(Biquad::identity(), &input);
        assert!(out.iter().zip(&input).all(|(a, b)| (a - b).abs() < 1e-6));
    }
}
