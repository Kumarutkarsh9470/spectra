/* SPECTRA — core DSP toolkit (no dependencies)
 * Everything here is written from scratch: FFT, 2-D FFT, STFT/ISTFT, Griffin-Lim,
 * LPC (autocorrelation + Levinson-Durbin), polynomial roots, pitch, quantisers, resampling.
 */
(function () {
  const SL = (window.SL = window.SL || {});
  const D = (SL.dsp = {});

  /* ---------------- FFT (iterative radix-2, in place) ---------------- */
  const twCache = new Map();
  function tw(n) {
    let t = twCache.get(n);
    if (t) return t;
    const half = n >> 1;
    const cos = new Float64Array(half), sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const bits = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    t = { cos, sin, rev };
    twCache.set(n, t);
    return t;
  }

  D.isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
  D.nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  /** In-place complex FFT. re/im: typed arrays of equal power-of-2 length.
   *  forward: X[k] = Σ x[n] e^{-j2πkn/N};  inverse divides by N. */
  D.fft = function (re, im, inverse = false) {
    const n = re.length;
    if (n <= 1) return;
    const { cos, sin, rev } = tw(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const s = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = s * sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };

  /** In-place 2-D FFT on row-major arrays (w, h powers of two). Separable: rows then columns. */
  D.fft2 = function (re, im, w, h, inverse = false) {
    const rr = new Float64Array(w), ri = new Float64Array(w);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) { rr[x] = re[o + x]; ri[x] = im[o + x]; }
      D.fft(rr, ri, inverse);
      for (let x = 0; x < w; x++) { re[o + x] = rr[x]; im[o + x] = ri[x]; }
    }
    const cr = new Float64Array(h), ci = new Float64Array(h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) { cr[y] = re[y * w + x]; ci[y] = im[y * w + x]; }
      D.fft(cr, ci, inverse);
      for (let y = 0; y < h; y++) { re[y * w + x] = cr[y]; im[y * w + x] = ci[y]; }
    }
  };

  /** Swap quadrants so DC sits at the centre (its own inverse for even sizes). Returns a new array. */
  D.shift2 = function (src, w, h) {
    const out = new src.constructor(src.length);
    const hw = w >> 1, hh = h >> 1;
    for (let y = 0; y < h; y++) {
      const ys = (y + hh) % h;
      for (let x = 0; x < w; x++) out[ys * w + ((x + hw) % w)] = src[y * w + x];
    }
    return out;
  };

  /** Magnitude spectrum (|X|) of a real signal, first n/2+1 bins. */
  D.rfftMag = function (x, n = D.nextPow2(x.length), win) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < Math.min(n, x.length); i++) re[i] = x[i] * (win ? win[i] : 1);
    D.fft(re, im);
    const B = (n >> 1) + 1, m = new Float32Array(B);
    for (let k = 0; k < B; k++) m[k] = Math.hypot(re[k], im[k]);
    return m;
  };

  /* ---------------- Windows ---------------- */
  const winCache = new Map();
  D.win = function (type = 'hann', n = 512, periodic = true) {
    const key = type + n + periodic;
    if (winCache.has(key)) return winCache.get(key);
    const w = new Float32Array(n), M = periodic ? n : n - 1;
    for (let i = 0; i < n; i++) {
      const c = Math.cos((2 * Math.PI * i) / M), c2 = Math.cos((4 * Math.PI * i) / M);
      w[i] = type === 'rect' ? 1
        : type === 'hamming' ? 0.54 - 0.46 * c
        : type === 'blackman' ? 0.42 - 0.5 * c + 0.08 * c2
        : 0.5 - 0.5 * c; // hann
    }
    winCache.set(key, w);
    return w;
  };

  /* ---------------- STFT / ISTFT / Griffin-Lim ---------------- */
  /** Centered STFT. Returns {re, im, T, B, n, hop, type, length}; frame t, bin k at [t*B + k]. */
  D.stft = function (x, n = 512, hop = 128, type = 'hann') {
    const w = D.win(type, n);
    const pad = n >> 1, L = x.length;
    const T = Math.floor(L / hop) + 1, B = (n >> 1) + 1;
    const re = new Float32Array(T * B), im = new Float32Array(T * B);
    const fr = new Float64Array(n), fi = new Float64Array(n);
    for (let t = 0; t < T; t++) {
      const start = t * hop - pad;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        fr[i] = idx >= 0 && idx < L ? x[idx] * w[i] : 0;
        fi[i] = 0;
      }
      D.fft(fr, fi);
      const o = t * B;
      for (let k = 0; k < B; k++) { re[o + k] = fr[k]; im[o + k] = fi[k]; }
    }
    return { re, im, T, B, n, hop, type, length: L };
  };

  /** Weighted overlap-add inverse of D.stft. */
  D.istft = function (S, length) {
    const { re, im, T, B, n, hop, type } = S;
    const w = D.win(type, n), pad = n >> 1;
    const L = length ?? S.length ?? (T - 1) * hop;
    const total = (T - 1) * hop + n;
    const y = new Float64Array(total), ws = new Float64Array(total);
    const fr = new Float64Array(n), fi = new Float64Array(n);
    for (let t = 0; t < T; t++) {
      const o = t * B;
      for (let k = 0; k < B; k++) { fr[k] = re[o + k]; fi[k] = im[o + k]; }
      for (let k = 1; k < n - B + 1; k++) { fr[n - k] = re[o + k]; fi[n - k] = -im[o + k]; }
      D.fft(fr, fi, true);
      const s = t * hop;
      for (let i = 0; i < n; i++) { y[s + i] += fr[i] * w[i]; ws[s + i] += w[i] * w[i]; }
    }
    const out = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const j = i + pad;
      out[i] = j < total && ws[j] > 1e-6 ? y[j] / ws[j] : 0;
    }
    return out;
  };

  D.stftMag = function (S) {
    const m = new Float32Array(S.re.length);
    for (let i = 0; i < m.length; i++) m[i] = Math.hypot(S.re[i], S.im[i]);
    return m;
  };

  /** Fast Griffin-Lim (Perraudin et al. 2013). mag: Float32Array T*B. Returns Float32Array signal. */
  D.griffinLim = function (mag, T, B, n, hop, opt = {}) {
    const { iters = 32, momentum = 0.99, type = 'hann', length = (T - 1) * hop, init = 'random', phase = null, onIter } = opt;
    const N = T * B;
    let re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const ph = phase ? phase[i] : init === 'zero' ? 0 : Math.random() * 2 * Math.PI;
      re[i] = mag[i] * Math.cos(ph); im[i] = mag[i] * Math.sin(ph);
    }
    let pRe = null, pIm = null, x;
    for (let it = 0; it < iters; it++) {
      x = D.istft({ re, im, T, B, n, hop, type }, length);
      const P = D.stft(x, n, hop, type);
      let num = 0, den = 0;
      for (let i = 0; i < N; i++) {
        let ar = P.re[i], ai = P.im[i];
        if (pRe && momentum > 0) {
          const tr = ar + momentum * (ar - pRe[i]), ti = ai + momentum * (ai - pIm[i]);
          pRe[i] = ar; pIm[i] = ai; ar = tr; ai = ti;
        }
        const a = Math.hypot(ar, ai) || 1e-12;
        re[i] = (mag[i] * ar) / a; im[i] = (mag[i] * ai) / a;
        const pm = Math.hypot(P.re[i], P.im[i]);
        num += (pm - mag[i]) ** 2; den += mag[i] ** 2;
      }
      if (!pRe) { pRe = P.re.slice(); pIm = P.im.slice(); }
      if (onIter) onIter(it, Math.sqrt(num / (den || 1)));
    }
    return D.istft({ re, im, T, B, n, hop, type }, length);
  };

  /* ---------------- Linear prediction ---------------- */
  D.autocorr = function (x, maxLag, start = 0, len = x.length - start) {
    const r = new Float64Array(maxLag + 1);
    for (let k = 0; k <= maxLag; k++) {
      let s = 0;
      for (let i = 0; i + k < len; i++) s += x[start + i] * x[start + i + k];
      r[k] = s;
    }
    return r;
  };

  /** Levinson-Durbin. Predictor convention: x̂[n] = Σ_{k=1..p} a[k] x[n-k], A(z) = 1 − Σ a[k] z^{-k}.
   *  Returns {a (length p+1, a[0] unused = 1), k (reflection coeffs), err (final prediction-error power)}. */
  D.levinson = function (r, p) {
    const a = new Float64Array(p + 1), k = new Float64Array(p + 1);
    a[0] = 1;
    let e = r[0];
    if (!(e > 0)) return { a, k, err: 0 };
    const tmp = new Float64Array(p + 1);
    for (let i = 1; i <= p; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc -= a[j] * r[i - j];
      const ki = acc / e;
      k[i] = ki;
      tmp.set(a);
      a[i] = ki;
      for (let j = 1; j < i; j++) a[j] = tmp[j] - ki * tmp[i - j];
      e *= 1 - ki * ki;
      if (e <= 0) { e = 1e-12; break; }
    }
    return { a, k, err: e };
  };

  /** LPC on one frame: pre-emphasis → window → autocorrelation → Levinson. Returns {a, k, g, err, r}. */
  D.lpc = function (frame, p = 12, opt = {}) {
    const { preemph = 0.97, win = 'hamming' } = opt;
    const n = frame.length, x = new Float64Array(n), w = D.win(win, n, false);
    for (let i = 0; i < n; i++) x[i] = ((frame[i] - (i ? preemph * frame[i - 1] : 0)) || 0) * w[i];
    const r = D.autocorr(x, p);
    r[0] *= 1 + 1e-6; r[0] += 1e-12; // white-noise correction keeps it stable
    const L = D.levinson(r, p);
    return { a: L.a, k: L.k, err: L.err, g: Math.sqrt(Math.max(L.err, 0)), r };
  };

  /** All-pole envelope |G / A(e^{jω})| in dB at nBins points ω ∈ [0, π]. */
  D.lpcEnvelope = function (a, g, nBins = 256) {
    const p = a.length - 1, out = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) {
      const w = (Math.PI * i) / (nBins - 1);
      let re = 1, im = 0;
      for (let k = 1; k <= p; k++) { re -= a[k] * Math.cos(w * k); im += a[k] * Math.sin(w * k); }
      out[i] = 20 * Math.log10((g + 1e-12) / (Math.hypot(re, im) + 1e-12));
    }
    return out;
  };

  /** Run the prediction-error filter A(z) (analysis) over x; returns residual e[n]. */
  D.lpcResidual = function (x, a) {
    const p = a.length - 1, e = new Float32Array(x.length);
    for (let n = 0; n < x.length; n++) {
      let s = x[n];
      for (let k = 1; k <= p && n - k >= 0; k++) s -= a[k] * x[n - k];
      e[n] = s;
    }
    return e;
  };

  /** Roots of polynomial c[0] z^p + c[1] z^{p-1} + ... + c[p] (Durand-Kerner). Returns [{re, im}]. */
  D.polyRoots = function (c) {
    const p = c.length - 1;
    if (p < 1) return [];
    const c0 = c[0];
    const cc = Array.from(c, (v) => v / c0);
    let zr = new Float64Array(p), zi = new Float64Array(p);
    for (let i = 0; i < p; i++) {
      const ang = (2 * Math.PI * i) / p + 0.4;
      zr[i] = 0.9 * Math.cos(ang); zi[i] = 0.9 * Math.sin(ang);
    }
    for (let it = 0; it < 500; it++) {
      let delta = 0;
      for (let i = 0; i < p; i++) {
        // evaluate polynomial at z_i (Horner)
        let pr = 1, pi = 0;
        for (let k = 1; k <= p; k++) {
          const nr = pr * zr[i] - pi * zi[i] + cc[k];
          const ni = pr * zi[i] + pi * zr[i];
          pr = nr; pi = ni;
        }
        let dr = 1, di = 0;
        for (let j = 0; j < p; j++) {
          if (j === i) continue;
          const ar = zr[i] - zr[j], ai = zi[i] - zi[j];
          const nr = dr * ar - di * ai, ni = dr * ai + di * ar;
          dr = nr; di = ni;
        }
        const den = dr * dr + di * di || 1e-30;
        const qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
        zr[i] -= qr; zi[i] -= qi;
        delta = Math.max(delta, Math.abs(qr) + Math.abs(qi));
      }
      if (delta < 1e-12) break;
    }
    const out = [];
    for (let i = 0; i < p; i++) out.push({ re: zr[i], im: Math.abs(zi[i]) < 1e-9 ? 0 : zi[i] });
    return out;
  };

  /** Poles of 1/A(z) from predictor coefficients a (a[0]=1 ignored). */
  D.lpcPoles = function (a) {
    const p = a.length - 1, c = new Float64Array(p + 1);
    c[0] = 1;
    for (let k = 1; k <= p; k++) c[k] = -a[k];
    return D.polyRoots(c);
  };

  /** Predictor coefficients from a list of poles (conjugates must be included). */
  D.polesToLpc = function (poles) {
    let cr = [1], ci = [0];
    for (const z of poles) {
      const nr = new Array(cr.length + 1).fill(0), ni = new Array(cr.length + 1).fill(0);
      for (let i = 0; i < cr.length; i++) {
        nr[i] += cr[i]; ni[i] += ci[i];
        nr[i + 1] -= cr[i] * z.re - ci[i] * z.im;
        ni[i + 1] -= cr[i] * z.im + ci[i] * z.re;
      }
      cr = nr; ci = ni;
    }
    const a = new Float64Array(cr.length);
    a[0] = 1;
    for (let k = 1; k < cr.length; k++) a[k] = -cr[k];
    return a;
  };

  /** Formants from LPC poles: [{f, bw, r, theta}] sorted by f, filtered to plausible ones. */
  D.formants = function (a, sr, { minF = 90, maxBw = 600 } = {}) {
    return D.lpcPoles(a)
      .filter((z) => z.im > 0)
      .map((z) => {
        const r = Math.hypot(z.re, z.im), th = Math.atan2(z.im, z.re);
        return { f: (th * sr) / (2 * Math.PI), bw: (-Math.log(r) * sr) / Math.PI, r, theta: th, z };
      })
      .filter((p) => p.f > minF && p.bw < maxBw && p.f < sr / 2 - 50)
      .sort((x, y) => x.f - y.f);
  };

  /* ---------------- Pitch (normalised autocorrelation) ---------------- */
  D.pitch = function (frame, sr, fmin = 60, fmax = 450) {
    const n = frame.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += frame[i];
    mean /= n;
    const x = new Float64Array(n);
    let e = 0;
    for (let i = 0; i < n; i++) { x[i] = frame[i] - mean; e += x[i] * x[i]; }
    if (e < 1e-8) return { f0: 0, conf: 0, energy: 0 };
    const lagMin = Math.max(2, Math.floor(sr / fmax)), lagMax = Math.min(n - 2, Math.ceil(sr / fmin));
    let best = -1, bestLag = 0;
    const nacf = new Float64Array(lagMax + 2);
    for (let L = lagMin; L <= lagMax + 1; L++) {
      let s = 0, e1 = 0, e2 = 0;
      for (let i = 0; i + L < n; i++) { s += x[i] * x[i + L]; e1 += x[i] * x[i]; e2 += x[i + L] * x[i + L]; }
      nacf[L] = s / (Math.sqrt(e1 * e2) + 1e-12);
    }
    for (let L = lagMin; L <= lagMax; L++) {
      if (nacf[L] > best && nacf[L] >= nacf[L - 1] && nacf[L] >= nacf[L + 1]) { best = nacf[L]; bestLag = L; }
    }
    if (!bestLag) return { f0: 0, conf: 0, energy: e / n };
    // prefer the shortest lag whose peak is almost as good (avoid octave errors)
    for (let L = lagMin; L < bestLag; L++) {
      if (nacf[L] > 0.9 * best && nacf[L] >= nacf[L - 1] && nacf[L] >= nacf[L + 1]) { bestLag = L; best = nacf[L]; break; }
    }
    const y0 = nacf[bestLag - 1], y1 = nacf[bestLag], y2 = nacf[bestLag + 1];
    const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1e-12);
    const lag = bestLag + (Math.abs(d) < 1 ? d : 0);
    return { f0: sr / lag, conf: best, energy: e / n };
  };

  /* ---------------- Filters ---------------- */
  /** Two-pole resonator: y[n] = b0 x[n] + a1 y[n-1] + a2 y[n-2], unity DC gain. */
  D.resonator = function (f, bw, sr) {
    const r = Math.exp((-Math.PI * bw) / sr), th = (2 * Math.PI * f) / sr;
    const a1 = 2 * r * Math.cos(th), a2 = -r * r;
    return { b0: 1 - a1 - a2, a1, a2, r, th };
  };

  /** Windowed-sinc low-pass FIR (cutoff as fraction of sample rate, 0..0.5). */
  D.firLowpass = function (cut, taps = 63) {
    const h = new Float32Array(taps), M = taps - 1, w = D.win('blackman', taps, false);
    let s = 0;
    for (let i = 0; i < taps; i++) {
      const m = i - M / 2;
      h[i] = (m === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * m) / (Math.PI * m)) * w[i];
      s += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= s;
    return h;
  };

  D.convolve = function (x, h, same = true) {
    const n = x.length, m = h.length, off = same ? (m - 1) >> 1 : 0;
    const L = same ? n : n + m - 1, y = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      let s = 0;
      const c = i + off;
      for (let j = 0; j < m; j++) {
        const k = c - j;
        if (k >= 0 && k < n) s += x[k] * h[j];
      }
      y[i] = s;
    }
    return y;
  };

  /** Band-limited resampling (low-pass then linear interpolation). */
  D.resample = function (x, srIn, srOut) {
    if (srIn === srOut) return Float32Array.from(x);
    let src = x;
    if (srOut < srIn) src = D.convolve(x, D.firLowpass((0.5 * srOut) / srIn * 0.92, 95));
    const L = Math.floor((x.length * srOut) / srIn), y = new Float32Array(L), r = srIn / srOut;
    for (let i = 0; i < L; i++) {
      const p = i * r, i0 = Math.floor(p), f = p - i0;
      const a = src[i0] || 0, b = src[i0 + 1] ?? a;
      y[i] = a + (b - a) * f;
    }
    return y;
  };

  /* ---------------- Quantisation & coding helpers ---------------- */
  /** Uniform mid-rise quantiser on [-1, 1) with b bits. */
  D.quantize = function (v, bits) {
    const L = 2 ** bits, d = 2 / L;
    const q = Math.floor(v / d) + 0.5;
    return Math.max(-1 + d / 2, Math.min(1 - d / 2, q * d));
  };
  D.muLaw = (x, mu = 255) => Math.sign(x) * Math.log1p(mu * Math.abs(x)) / Math.log1p(mu);
  D.muLawInv = (y, mu = 255) => Math.sign(y) * (Math.pow(1 + mu, Math.abs(y)) - 1) / mu;

  D.snr = function (ref, test) {
    let s = 0, e = 0;
    for (let i = 0; i < ref.length; i++) { s += ref[i] * ref[i]; e += (ref[i] - (test[i] || 0)) ** 2; }
    return 10 * Math.log10((s + 1e-12) / (e + 1e-12));
  };

  /** Segmental SNR (dB), frames clipped to [-10, 35] as is customary, silent frames skipped. */
  D.segSNR = function (ref, test, frame = 160) {
    let tot = 0, cnt = 0;
    for (let s = 0; s + frame <= ref.length; s += frame) {
      let a = 0, b = 0;
      for (let i = s; i < s + frame; i++) { a += ref[i] * ref[i]; b += (ref[i] - (test[i] || 0)) ** 2; }
      if (a / frame < 1e-6) continue;
      tot += Math.max(-10, Math.min(35, 10 * Math.log10((a + 1e-12) / (b + 1e-12))));
      cnt++;
    }
    return cnt ? tot / cnt : 0;
  };

  D.rms = function (x, s = 0, e = x.length) {
    let a = 0;
    for (let i = s; i < e; i++) a += x[i] * x[i];
    return Math.sqrt(a / Math.max(1, e - s));
  };

  D.normalize = function (x, peak = 0.9) {
    let m = 0;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
    const y = new Float32Array(x.length), g = m > 0 ? peak / m : 1;
    for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
    return y;
  };

  /* ---------------- Small math utils ---------------- */
  D.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  D.lerp = (a, b, t) => a + (b - a) * t;
  D.db = (v, floor = 1e-10) => 10 * Math.log10(Math.max(v, floor));
  D.hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
  D.melToHz = (m) => 700 * (10 ** (m / 2595) - 1);
  /** Seeded PRNG (mulberry32). */
  D.rng = function (seed = 1) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  /** Gaussian sample (Box-Muller). */
  D.gauss = function (rand = Math.random) {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  /** Poisson sample: Knuth for small λ, Gaussian approximation for large λ. */
  D.poisson = function (lambda, rand = Math.random) {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const L = Math.exp(-lambda);
      let k = 0, p = 1;
      do { k++; p *= rand(); } while (p > L);
      return k - 1;
    }
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * D.gauss(rand)));
  };
})();
