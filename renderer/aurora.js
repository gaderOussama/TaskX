// Northern lights behind the dashboard, ported from "Northstar Background" in
// Claude Design (its React runtime is not needed for one canvas). It is drawn
// only while the wide panel is open; the tile and the small card never run it,
// so an always-on-top widget costs nothing while you are not using it.
// How see-through it is lives in style.css (#aurora opacity).
(() => {
  const INTENSITY = 1;
  const SPEED = 1;

  const c = document.getElementById('aurora');
  const ctx = c.getContext('2d');
  const ac = document.createElement('canvas');
  const a = ac.getContext('2d');
  const bc = document.createElement('canvas');
  const b = bc.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  let w = 0;
  let h = 0;
  let S = 4;
  let grad = null;
  let raf = 0;

  function resize() {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    w = c.clientWidth;
    h = c.clientHeight;
    c.width = Math.round(w * d);
    c.height = Math.round(h * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    S = w < 700 ? 3 : 4;
    ac.width = Math.max(1, Math.ceil(w / S));
    ac.height = Math.max(1, Math.ceil(h / S));
    bc.width = Math.max(1, Math.ceil(ac.width / 6));
    bc.height = Math.max(1, Math.ceil(ac.height / 6));
    grad = null;
    if (!raf) frame();
  }

  function frame() {
    const t = reduced ? 8 : ((performance.now() - t0) / 1000) * SPEED;
    const I = INTENSITY;
    const aw = ac.width;
    const ah = ac.height;
    const portrait = h > w;
    // Curtain length is limited so tall windows don't get stretched ribbons.
    const span = Math.min(ah, aw * 1.1);
    if (!grad) {
      grad = a.createLinearGradient(0, 0, 0, 1);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.06, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.22, 'rgba(225,230,240,0.55)');
      grad.addColorStop(0.55, 'rgba(160,166,178,0.18)');
      grad.addColorStop(1, 'rgba(90,94,104,0)');
    }
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalAlpha = 1;
    a.globalCompositeOperation = 'source-over';
    a.clearRect(0, 0, aw, ah);
    a.globalCompositeOperation = 'lighter';
    a.fillStyle = grad;
    const base = portrait ? 0.14 : 0.1;
    const bands = [
      { y: base + 0.06, amp: 0.07, f: 1.1, sp: 0.09, len: 0.55, al: 0.30, ph: 0.0 },
      { y: base + 0.15, amp: 0.05, f: 1.7, sp: -0.06, len: 0.42, al: 0.20, ph: 2.3 },
      { y: base, amp: 0.04, f: 0.7, sp: 0.04, len: 0.70, al: 0.14, ph: 4.1 },
    ];
    const step = 1.5;
    for (const bd of bands) {
      for (let x = 0; x < aw; x += step) {
        const u = x / aw; // relative: the overall shape fits any size
        const X = (x * S) / 1000; // absolute px: ray detail stays constant
        const top = ah * (bd.y + bd.amp * Math.sin(u * 6.283 * bd.f + t * bd.sp + bd.ph))
          + span * 0.025 * Math.sin(X * 9 + t * 0.35 + bd.ph);
        const fold = 0.5 + 0.5 * Math.sin(X * 14 + t * 0.5 + bd.ph * 3) * Math.sin(X * 5.3 - t * 0.22 + bd.ph);
        const rays = 0.75 + 0.25 * Math.sin(X * 90 + Math.sin(X * 7 + t * 0.6) * 4);
        const edge = Math.sin(Math.PI * Math.min(1, Math.max(0, (u + 0.08) / 1.16)));
        const breathe = 0.8 + 0.2 * Math.sin(t * 0.3 + bd.ph);
        a.globalAlpha = Math.min(1, bd.al * I * edge * breathe * (0.25 + fold) * rays);
        a.setTransform(1, 0, 0, span * bd.len * (0.65 + 0.45 * fold), x, top);
        a.fillRect(0, 0, step + 0.5, 1);
      }
    }
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalAlpha = 1;
    b.clearRect(0, 0, bc.width, bc.height);
    b.imageSmoothingQuality = 'high';
    b.drawImage(ac, 0, 0, bc.width, bc.height);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, 'rgba(14,15,18,1)');
    sky.addColorStop(0.45, 'rgba(4,4,5,1)');
    sky.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.7 * Math.min(1, I);
    ctx.drawImage(bc, 0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.drawImage(ac, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    const vg = ctx.createRadialGradient(w / 2, h * 0.35, Math.min(w, h) * 0.3, w / 2, h * 0.5, Math.hypot(w, h) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  function loop() {
    frame();
    raf = requestAnimationFrame(loop);
  }

  // Follow the mode the page mirrors from Rust: running in the dashboard only.
  function sync() {
    const wide = document.documentElement.dataset.mode === 'panel';
    if (wide && !raf) {
      if (reduced) frame();
      else raf = requestAnimationFrame(loop);
    }
    if (!wide && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  new ResizeObserver(resize).observe(c);
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  resize();
  sync();
})();
