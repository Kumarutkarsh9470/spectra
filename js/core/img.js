/* SPECTRA — image toolkit: colormaps, float-image <-> canvas, blur, procedural scenes, sources. */
(function () {
  const SL = (window.SL = window.SL || {});
  const I = (SL.img = {});
  const D = SL.dsp;

  /* ---------------- Colormaps (256-entry LUTs) ---------------- */
  const STOPS = {
    gray: [[0, 0, 0], [255, 255, 255]],
    magma: [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]],
    inferno: [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]],
    viridis: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
    // SPECTRA house maps
    ice: [[4, 6, 12], [10, 30, 60], [12, 80, 120], [30, 150, 190], [90, 215, 240], [200, 245, 255], [255, 255, 255]],
    ember: [[6, 4, 10], [50, 10, 60], [130, 20, 90], [215, 50, 90], [255, 110, 80], [255, 190, 110], [255, 250, 220]],
    aurora: [[5, 5, 14], [30, 20, 80], [70, 40, 160], [60, 120, 220], [40, 200, 200], [140, 240, 140], [250, 255, 200]],
    // diverging (signed data): blue - black - orange
    signed: [[90, 200, 255], [30, 90, 160], [10, 14, 22], [170, 80, 30], [255, 180, 90]],
    // cyclic, for phase
    phase: [[230, 70, 120], [240, 170, 60], [140, 220, 90], [50, 200, 220], [110, 110, 240], [230, 70, 120]],
  };
  const lutCache = {};
  I.lut = function (name = 'gray') {
    if (lutCache[name]) return lutCache[name];
    const s = STOPS[name] || STOPS.gray, lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (s.length - 1), k = Math.min(s.length - 2, Math.floor(t)), f = t - k;
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = s[k][c] + (s[k + 1][c] - s[k][c]) * f;
    }
    return (lutCache[name] = lut);
  };
  I.cmapNames = Object.keys(STOPS);
  /** CSS color string from a colormap at t∈[0,1]. */
  I.cmapCss = function (name, t, a = 1) {
    const l = I.lut(name), i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
    return `rgba(${l[i]},${l[i + 1]},${l[i + 2]},${a})`;
  };

  /* ---------------- Drawing float images ---------------- */
  function fitCanvas(cv, w, h) {
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return cv.getContext('2d');
  }
  /** Draw a single-channel float image. opt: {cmap, min, max, auto:'minmax'|'pct', log, signed} */
  I.draw = function (cv, data, w, h, opt = {}) {
    const ctx = fitCanvas(cv, w, h);
    let { min, max } = opt;
    const N = w * h;
    if (opt.log) {
      const t = new Float32Array(N);
      for (let i = 0; i < N; i++) t[i] = Math.log10(1e-9 + Math.abs(data[i]));
      data = t;
    }
    if (min === undefined || max === undefined) {
      if (opt.auto === 'pct') {
        const s = Float32Array.from(data).sort();
        min ??= s[Math.floor(N * 0.01)]; max ??= s[Math.floor(N * 0.995)];
      } else {
        let a = Infinity, b = -Infinity;
        for (let i = 0; i < N; i++) { const v = data[i]; if (v < a) a = v; if (v > b) b = v; }
        if (opt.signed) { const m = Math.max(Math.abs(a), Math.abs(b)); a = -m; b = m; }
        min ??= a; max ??= b;
      }
    }
    const lut = I.lut(opt.cmap || 'gray'), img = ctx.createImageData(w, h), d = img.data;
    const sc = 255 / (max - min || 1);
    for (let i = 0; i < N; i++) {
      let v = ((data[i] - min) * sc) | 0;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i * 4] = lut[v * 3]; d[i * 4 + 1] = lut[v * 3 + 1]; d[i * 4 + 2] = lut[v * 3 + 2]; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { min, max };
  };

  /** Draw RGB float planes in [0,1]. */
  I.drawRGB = function (cv, r, g, b, w, h, gain = 1) {
    const ctx = fitCanvas(cv, w, h), img = ctx.createImageData(w, h), d = img.data;
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = r[i] * 255 * gain; d[i * 4 + 1] = g[i] * 255 * gain; d[i * 4 + 2] = b[i] * 255 * gain; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };

  /* ---------------- Reading pixels ---------------- */
  const scratch = document.createElement('canvas');
  /** Draw any image source (img, video, canvas) cover-fitted into w×h; returns ImageData. */
  I.grab = function (src, w, h) {
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); return ctx.getImageData(0, 0, w, h); }
    const s = Math.max(w / sw, h / sh), dw = sw * s, dh = sh * s;
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return ctx.getImageData(0, 0, w, h);
  };
  /** ImageData → {r,g,b} Float32 planes in [0,1] (sRGB values). */
  I.planes = function (id) {
    const N = id.width * id.height, r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N), d = id.data;
    for (let i = 0; i < N; i++) { r[i] = d[i * 4] / 255; g[i] = d[i * 4 + 1] / 255; b[i] = d[i * 4 + 2] / 255; }
    return { r, g, b, w: id.width, h: id.height };
  };
  /** ImageData → luminance Float32Array in [0,1] (Rec.709 weights). */
  I.gray = function (id) {
    const N = id.width * id.height, o = new Float32Array(N), d = id.data;
    for (let i = 0; i < N; i++) o[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    return o;
  };
  I.toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  I.toSRGB = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

  /* ---------------- Filtering ---------------- */
  I.gaussKernel = function (sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  };
  /** Separable Gaussian blur with clamped edges. */
  I.blur = function (src, w, h, sigma) {
    if (sigma < 0.3) return Float32Array.from(src);
    const k = I.gaussKernel(sigma), r = (k.length - 1) >> 1, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) { const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j; s += src[o + xx] * k[j + r]; }
        tmp[o + x] = s;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let s = 0;
        for (let j = -r; j <= r; j++) { const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j; s += tmp[yy * w + x] * k[j + r]; }
        out[y * w + x] = s;
      }
    }
    return out;
  };
  /** Bilinear resize of a float image. */
  I.resize = function (src, w, h, W, H) {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const fy = ((y + 0.5) * h) / H - 0.5, y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), ty = Math.max(0, fy - y0);
      for (let x = 0; x < W; x++) {
        const fx = ((x + 0.5) * w) / W - 0.5, x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), tx = Math.max(0, fx - x0);
        const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
        out[y * W + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      }
    }
    return out;
  };

  /* ---------------- Procedural scenes ---------------- */
  const SCENES = {};
  I.sceneList = [
    { id: 'city', label: 'City' },
    { id: 'market', label: 'Market' },
    { id: 'text', label: 'Text' },
    { id: 'zone', label: 'Zone plate' },
  ];
  const sceneCache = new Map();
  /** Returns a canvas w×h with the named procedural scene (cached). */
  I.scene = function (name, w = 512, h = 512) {
    const key = name + w + 'x' + h;
    if (sceneCache.has(key)) return sceneCache.get(key);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    (SCENES[name] || SCENES.city)(cv.getContext('2d'), w, h);
    sceneCache.set(key, cv);
    return cv;
  };

  SCENES.city = function (c, w, h) {
    const R = D.rng(7), u = Math.min(w, h) / 512;
    // sky
    let g = c.createLinearGradient(0, 0, 0, h * 0.62);
    g.addColorStop(0, '#0b1640'); g.addColorStop(0.55, '#4a3a7a'); g.addColorStop(0.85, '#e07a5f'); g.addColorStop(1, '#f6c177');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    // stars
    for (let i = 0; i < 70; i++) { c.fillStyle = `rgba(255,255,255,${0.3 + R() * 0.7})`; c.fillRect(R() * w, R() * h * 0.35, 1.2 * u, 1.2 * u); }
    // sun with glow
    const sx = w * 0.72, sy = h * 0.5;
    g = c.createRadialGradient(sx, sy, 2, sx, sy, 120 * u);
    g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(0.25, 'rgba(255,200,120,.8)'); g.addColorStop(1, 'rgba(255,140,80,0)');
    c.fillStyle = g; c.beginPath(); c.arc(sx, sy, 120 * u, 0, 7); c.fill();
    c.fillStyle = '#fff3d6'; c.beginPath(); c.arc(sx, sy, 26 * u, 0, 7); c.fill();
    // mountains
    c.fillStyle = '#2b2552'; c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) c.lineTo(x, h * 0.5 + Math.sin(x / (60 * u)) * 18 * u + Math.sin(x / (23 * u) + 1) * 9 * u);
    c.lineTo(w, h); c.fill();
    // buildings
    const ground = h * 0.8;
    let x = -10 * u;
    while (x < w) {
      const bw = (38 + R() * 60) * u, bh = (90 + R() * 210) * u;
      const shade = 18 + R() * 30;
      c.fillStyle = `rgb(${shade},${shade + 6},${shade + 22})`;
      c.fillRect(x, ground - bh, bw, bh);
      // window grid (periodic texture)
      const ww = 5 * u, wh = 7 * u, gx = 10 * u, gy = 13 * u;
      for (let yy = ground - bh + 10 * u; yy < ground - 12 * u; yy += gy)
        for (let xx = x + 6 * u; xx < x + bw - 8 * u; xx += gx) {
          const lit = R() < 0.45;
          c.fillStyle = lit ? `rgba(255,${200 + R() * 40},${110 + R() * 60},${0.75 + R() * 0.25})` : 'rgba(20,30,60,.9)';
          c.fillRect(xx, yy, ww, wh);
        }
      x += bw + (2 + R() * 8) * u;
    }
    // striped awning (fine stripes → aliasing / moiré)
    c.save(); c.translate(w * 0.08, ground - 70 * u);
    c.fillStyle = '#ddd'; c.fillRect(0, 0, 150 * u, 40 * u);
    for (let i = 0; i < 150 * u; i += 3 * u) { c.fillStyle = '#c0283c'; c.fillRect(i, 0, 1.5 * u, 40 * u); }
    c.restore();
    // neon sign with text
    c.save(); c.translate(w * 0.42, ground - 150 * u);
    c.fillStyle = '#10121e'; c.fillRect(0, 0, 130 * u, 46 * u);
    c.shadowColor = '#4de1ff'; c.shadowBlur = 14 * u; c.fillStyle = '#9ff3ff';
    c.font = `bold ${26 * u}px "Space Grotesk", Arial, sans-serif`; c.textBaseline = 'middle'; c.fillText('SPECTRA', 10 * u, 24 * u);
    c.restore();
    // road + fence
    c.fillStyle = '#15151f'; c.fillRect(0, ground, w, h - ground);
    c.fillStyle = '#e9e3c9';
    for (let i = 0; i < w; i += 44 * u) c.fillRect(i, ground + (h - ground) * 0.55, 24 * u, 4 * u);
    c.fillStyle = '#7d7f95';
    c.fillRect(0, ground - 2 * u, w, 3 * u);
    for (let i = 0; i < w; i += 6 * u) c.fillRect(i, ground - 22 * u, 2 * u, 22 * u);
    // the red balloon (pop-out target for saliency)
    const bx = w * 0.24, by = h * 0.25;
    c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1 * u; c.beginPath(); c.moveTo(bx, by + 18 * u); c.quadraticCurveTo(bx + 6 * u, by + 45 * u, bx - 2 * u, by + 70 * u); c.stroke();
    g = c.createRadialGradient(bx - 5 * u, by - 6 * u, 2, bx, by, 20 * u);
    g.addColorStop(0, '#ff8a8a'); g.addColorStop(1, '#d1112b');
    c.fillStyle = g; c.beginPath(); c.ellipse(bx, by, 15 * u, 19 * u, 0, 0, 7); c.fill();
  };

  SCENES.market = function (c, w, h) {
    const R = D.rng(11), u = Math.min(w, h) / 512;
    c.fillStyle = '#2a1d17'; c.fillRect(0, 0, w, h);
    // checkered cloth
    const s = 24 * u;
    for (let y = h * 0.35; y < h; y += s) for (let x = 0; x < w; x += s) {
      c.fillStyle = ((x / s + (y - h * 0.35) / s) | 0) % 2 ? '#e9e4da' : '#2f5d9a';
      c.fillRect(x, y, s + 1, s + 1);
    }
    // wall with wood grain
    for (let y = 0; y < h * 0.35; y += 3 * u) { c.fillStyle = `rgb(${70 + R() * 20},${45 + R() * 12},${30 + R() * 8})`; c.fillRect(0, y, w, 3 * u); }
    // fruits: blobs of saturated colour
    const fruits = [['#e63946', 30], ['#f4a261', 34], ['#2a9d8f', 26], ['#e9c46a', 30], ['#8338ec', 22], ['#ff006e', 18], ['#90be6d', 28]];
    for (let i = 0; i < 34; i++) {
      const [col, r] = fruits[(R() * fruits.length) | 0], rr = r * u * (0.8 + R() * 0.4);
      const x = R() * w, y = h * 0.42 + R() * h * 0.5;
      const g = c.createRadialGradient(x - rr * 0.35, y - rr * 0.35, 1, x, y, rr);
      g.addColorStop(0, '#ffffffaa'); g.addColorStop(0.25, col); g.addColorStop(1, '#00000088');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, rr, 0, 7); c.fill();
    }
    // a face (people look at faces first)
    const fx = w * 0.78, fy = h * 0.17, fr = 38 * u;
    c.fillStyle = '#e0ac8b'; c.beginPath(); c.arc(fx, fy, fr, 0, 7); c.fill();
    c.fillStyle = '#3b2418'; c.beginPath(); c.arc(fx, fy - fr * 0.45, fr * 0.95, Math.PI, 0); c.fill();
    c.fillStyle = '#111'; c.beginPath(); c.arc(fx - fr * 0.35, fy, 4 * u, 0, 7); c.arc(fx + fr * 0.35, fy, 4 * u, 0, 7); c.fill();
    c.strokeStyle = '#7a2e2e'; c.lineWidth = 3 * u; c.beginPath(); c.arc(fx, fy + fr * 0.25, fr * 0.35, 0.2, Math.PI - 0.2); c.stroke();
    // price tag text
    c.fillStyle = '#fbf3e4'; c.fillRect(w * 0.1, h * 0.12, 120 * u, 50 * u);
    c.fillStyle = '#222'; c.font = `bold ${22 * u}px Arial, sans-serif`; c.fillText('₹ 40/kg', w * 0.1 + 12 * u, h * 0.12 + 33 * u);
  };

  SCENES.text = function (c, w, h) {
    const u = Math.min(w, h) / 512;
    c.fillStyle = '#f4efe6'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1c1c22';
    const lines = [
      'The eye samples light; the ear samples air.',
      'Both pass the world through a filter,',
      'both throw away what they cannot use,',
      'and both are fooled by the same tricks.',
      'A grating is a tone you can see.',
      'A formant is a colour you can hear.',
      'Prediction is compression is perception.',
      'Every image is a sum of waves,',
      'every voice is a buzz through a tube.',
      'Same mathematics, two senses.',
    ];
    c.font = `${21 * u}px Georgia, "Times New Roman", serif`;
    lines.forEach((l, i) => c.fillText(l, 26 * u, 52 * u + i * 44 * u));
  };

  SCENES.zone = function (c, w, h) {
    const img = c.createImageData(w, h), d = img.data, k = Math.PI / (Math.max(w, h) * 0.9);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x - w / 2, dy = y - h / 2, v = 127.5 + 127.5 * Math.cos(k * (dx * dx + dy * dy));
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  };

  /* ---------------- Files & camera ---------------- */
  I.loadFile = function (file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
  };
  let camVideo = null, camStream = null;
  I.camera = async function () {
    if (camVideo && camStream && camStream.active) return camVideo;
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    camVideo = document.createElement('video');
    camVideo.playsInline = true; camVideo.muted = true; camVideo.srcObject = camStream;
    await camVideo.play();
    return camVideo;
  };
  I.stopCamera = function () {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null; camVideo = null;
  };
})();
