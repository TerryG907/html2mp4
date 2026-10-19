// In-page runtime. Injected with page.evaluateOnNewDocument, so it runs before any page script:
// libraries that cache Date.now / requestAnimationFrame at load time (GSAP, Three.js) pick up the
// virtual versions. Time only moves when the renderer calls __h2m.step(ms) or __h2m.seek(ms).
//
// This function is serialized with Function.prototype.toString(); it must not use anything from
// the enclosing module.
export function runtime(cfg) {
  if (window.__h2m || window !== window.top) return;
  const W = window;
  const realRAF = W.requestAnimationFrame.bind(W);
  const realSetTimeout = W.setTimeout.bind(W);
  const RealDate = W.Date;
  const realNow = () => RealDate.now();

  let vnow = 0; // virtual ms since page start
  const call = (fn, args) => {
    try {
      if (typeof fn === 'function') fn.apply(W, args);
      else (0, eval)(String(fn));
    } catch (e) {
      realSetTimeout(() => { throw e; }); // surfaces as an uncaught page error, with its stack
    }
  };
  // A real macrotask: drains every microtask the page queued, like the browser does between tasks.
  const nextTask = () => new Promise((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
  const realFrame = () => new Promise((r) => realRAF(() => r()));
  const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

  // ---------- clocks
  const FakeDate = function Date(...a) {
    if (!new.target) return new RealDate(cfg.epoch + vnow).toString();
    return Reflect.construct(RealDate, a.length ? a : [cfg.epoch + vnow], new.target);
  };
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => Math.floor(cfg.epoch + vnow);
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.defineProperty(RealDate.prototype, 'constructor', { value: FakeDate, configurable: true, writable: true });
  W.Date = FakeDate;
  Object.defineProperty(performance, 'now', { value: function now() { return vnow; }, configurable: true, writable: true });

  if (cfg.seed != null) {
    let s = cfg.seed >>> 0; // mulberry32
    Math.random = function random() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- GSAP
  // With force3D GSAP moves elements with translate3d, which promotes them to compositor layers.
  // Chrome promotes, demotes and re-rasters such layers using real-time heuristics, so a few edge
  // pixels came out different from run to run. 2D transforms look the same and are painted in
  // place, so turn force3D off as soon as GSAP registers itself on window.
  if (cfg.gsap2d) {
    let g;
    Object.defineProperty(W, 'gsap', {
      configurable: true,
      enumerable: true,
      get() { return g; },
      set(v) {
        g = v;
        try { if (v && typeof v.config === 'function') v.config({ force3D: false }); } catch { /* not GSAP */ }
      },
    });
  }

  // ---------- timers and frames
  const timers = new Map();
  let timerSeq = 0;
  let nextTimerId = 1;
  const addTimer = (fn, delay, args, repeat) => {
    const d = Math.max(0, Number(delay) || 0);
    const id = nextTimerId++;
    timers.set(id, { due: vnow + d, every: repeat ? Math.max(1, d) : 0, fn, args, seq: timerSeq++ });
    return id;
  };
  W.setTimeout = function setTimeout(fn, delay, ...args) { return addTimer(fn, delay, args, false); };
  W.setInterval = function setInterval(fn, delay, ...args) { return addTimer(fn, delay, args, true); };
  W.clearTimeout = function clearTimeout(id) { timers.delete(id); };
  W.clearInterval = function clearInterval(id) { timers.delete(id); };

  let rafs = new Map();
  let nextRafId = 1;
  W.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = nextRafId++;
    rafs.set(id, cb);
    return id;
  };
  W.cancelAnimationFrame = function cancelAnimationFrame(id) { rafs.delete(id); };
  if (W.requestIdleCallback) {
    W.requestIdleCallback = function requestIdleCallback(cb) {
      return addTimer(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false);
    };
    W.cancelIdleCallback = function cancelIdleCallback(id) { timers.delete(id); };
  }
  const runFrameCallbacks = () => {
    const q = rafs;
    rafs = new Map();
    for (const cb of q.values()) call(cb, [vnow]);
  };

  // ---------- CSS animations, transitions, Web Animations
  // Every animation is held paused by us and its currentTime set from the virtual clock. We keep
  // our own record of what the page wants (running / paused / finished) so the page's own play(),
  // pause(), finish() and animation-play-state keep working, and finish() is called at the right
  // virtual time so `finished` promises and animationend events still fire.
  const recs = new WeakMap();
  let internal = false;
  const AP = Animation.prototype;
  const orig = {};
  for (const k of ['play', 'pause', 'reverse', 'finish', 'cancel']) orig[k] = AP[k];
  const ct = Object.getOwnPropertyDescriptor(AP, 'currentTime');
  const hasCSSAnimation = typeof CSSAnimation !== 'undefined';
  const rec = (a) => {
    let r = recs.get(a);
    if (!r) {
      r = { stamp: vnow, last: vnow, local: 0, css: hasCSSAnimation && a instanceof CSSAnimation, user: null, done: false };
      recs.set(a, r);
    }
    return r;
  };
  const hold = (a, r) => {
    internal = true;
    try {
      if (a.playState !== 'paused') orig.pause.call(a);
      ct.set.call(a, r.local);
    } finally {
      internal = false;
    }
  };
  const cssPaused = (a) => {
    const el = a.effect && a.effect.target;
    if (!el) return false;
    const cs = getComputedStyle(el, a.effect.pseudoElement || null);
    const names = cs.animationName.split(',');
    const states = cs.animationPlayState.split(',');
    const i = Math.max(0, names.findIndex((n) => n.trim() === a.animationName));
    return (states[i % states.length] || '').trim() === 'paused';
  };
  const running = (a, r) => (r.user ? r.user === 'running' : !(r.css && cssPaused(a)));
  // Bring one animation's local time up to the current virtual time (state as it was until now).
  const integrate = (a, r) => {
    if (r.done) return;
    if (vnow !== r.last && running(a, r)) r.local += (vnow - r.last) * a.playbackRate;
    r.last = vnow;
  };
  const integrateAll = () => { for (const a of document.getAnimations()) integrate(a, rec(a)); };
  for (const k of Object.keys(orig)) {
    const f = orig[k];
    AP[k] = function (...args) {
      if (internal) return f.apply(this, args);
      const r = rec(this);
      integrate(this, r);
      if (!r.done) hold(this, r); // so the page's call sees the right current time
      const out = f.apply(this, args);
      if (k === 'finish' || k === 'cancel') {
        r.done = true;
        return out;
      }
      r.done = false;
      r.user = k === 'pause' ? 'paused' : 'running';
      r.local = ct.get.call(this) ?? 0; // play() rewinds a finished animation, reverse() may jump to the end
      r.last = vnow;
      hold(this, r);
      return out;
    };
  }
  Object.defineProperty(AP, 'currentTime', {
    configurable: true,
    enumerable: ct.enumerable,
    get() {
      if (!internal) {
        const r = recs.get(this);
        if (r && !r.done) { integrate(this, r); hold(this, r); }
      }
      return ct.get.call(this);
    },
    set(v) {
      ct.set.call(this, v);
      if (internal) return;
      const r = rec(this);
      r.local = ct.get.call(this) ?? 0;
      r.last = vnow;
      r.done = false;
      hold(this, r);
    },
  });
  // absolute = seek mode (random access): local time is a pure function of the virtual time.
  const syncAnimations = (absolute) => {
    const list = document.getAnimations();
    for (const a of list) {
      const r = rec(a);
      if (r.done) continue;
      const rate = a.playbackRate;
      if (absolute) {
        r.local = Math.max(0, vnow - r.stamp) * rate;
        r.last = vnow;
      } else {
        integrate(a, r);
      }
      hold(a, r);
      if (absolute || !a.effect) continue;
      const end = a.effect.getComputedTiming().endTime;
      if (Number.isFinite(end) && ((rate > 0 && r.local >= end) || (rate < 0 && r.local <= 0))) {
        // CSS animations and transitions stay paused past their end: the fill state shows and
        // animationend / transitionend still fire. Calling finish() on them hands a compositor
        // animation back to the main thread, and that hand-off raced with the next screenshot
        // (an intermittent one-frame difference). Script animations do get finish(), because pages
        // wait on their `finished` promise.
        if (!r.css && !(typeof CSSTransition !== 'undefined' && a instanceof CSSTransition)) {
          internal = true;
          try { orig.finish.call(a); } finally { internal = false; }
        }
        r.done = true;
      }
    }
    return list.length;
  };

  // ---------- SVG SMIL (<animate>, <animateTransform>, ...)
  const svgStart = new WeakMap();
  const syncSvg = () => {
    for (const s of document.querySelectorAll('svg')) {
      if (s.ownerSVGElement || !s.pauseAnimations) continue;
      let st = svgStart.get(s);
      if (st == null) {
        if (!s.querySelector('animate,animateTransform,animateMotion,set')) continue;
        st = vnow;
        svgStart.set(s, st);
      }
      s.pauseAnimations();
      s.setCurrentTime(Math.max(0, vnow - st) / 1000);
    }
  };

  // ---------- assets
  const pendingImages = () => [...document.images].filter((i) => !i.complete && i.src && i.loading !== 'lazy');
  const needsSettle = () => (document.fonts && document.fonts.status === 'loading') || pendingImages().length > 0;
  async function settle(first, timeoutMs = 15000) {
    const work = (async () => {
      if (first && document.fonts) {
        // Load every declared face now, so canvas text never draws a fallback font on frame 0.
        const faces = [];
        document.fonts.forEach((f) => { if (f.status === 'unloaded' && faces.length < 300) faces.push(f.load().catch(() => {})); });
        await Promise.all(faces);
      }
      if (document.fonts) await document.fonts.ready;
      await Promise.all(pendingImages().map((i) => new Promise((r) => {
        i.addEventListener('load', r, { once: true });
        i.addEventListener('error', r, { once: true });
      })));
      if (first) await Promise.all([...document.images].map((i) => (i.complete && i.decode ? i.decode().catch(() => {}) : 0)));
    })();
    await Promise.race([work, sleep(timeoutMs)]);
  }

  // ---------- driving
  // Every virtual frame gets exactly one real rendering step (one commit, one draw), whether the
  // frame is captured or not. Captured frames get it from the screenshot itself; skipped frames
  // from a real requestAnimationFrame. That keeps the compositor's history identical on every
  // worker page (its raster heuristics depend on it), and lets animationend / transitionend events
  // for each frame fire. post() then picks up whatever their handlers started.
  async function afterFrame(absolute, capture) {
    await nextTask();
    syncAnimations(absolute);
    syncSvg();
    if (needsSettle()) await settle(false);
    if (capture) return;
    await realFrame();
    await post(absolute);
  }
  async function post(absolute) {
    await nextTask();
    if (syncAnimations(absolute)) syncSvg();
    if (needsSettle()) await settle(false);
  }

  let stepped = false;
  async function step(target, capture = false) {
    let n = 0;
    for (;;) {
      let id = 0;
      let t = null;
      for (const [k, v] of timers) {
        if (v.due <= target && (!t || v.due < t.due || (v.due === t.due && v.seq < t.seq))) { id = k; t = v; }
      }
      if (!t) break;
      if (t.due > vnow) {
        vnow = t.due;
        integrateAll(); // animations run with their old state up to the moment this callback fires
      }
      if (t.every) { t.due += t.every; t.seq = timerSeq++; } else timers.delete(id);
      call(t.fn, t.args);
      await nextTask();
      integrateAll(); // stamps animations the callback started with this exact virtual time
      if (++n > 100000) throw new Error('more than 100000 timer callbacks in one frame (setInterval with 0 delay?)');
    }
    if (target > vnow) vnow = target;
    runFrameCallbacks();
    if (!stepped) {
      stepped = true;
      // GSAP's ticker only dispatches once >4 ms have passed since it loaded, which in a real
      // browser always happens before the first paint. Tick it once so frame 0 shows the state
      // GSAP sets on its first render (e.g. from() tweens placed later in a timeline).
      try { if (W.gsap && W.gsap.ticker && W.gsap.ticker.frame === 0) W.gsap.ticker.tick(); } catch (e) { realSetTimeout(() => { throw e; }); }
    }
    await afterFrame(false, capture);
  }

  async function seek(target, capture = false) {
    vnow = target;
    const r = W.__render;
    const fn = typeof r === 'function' ? r : r.seek;
    await fn.call(r, target / 1000);
    runFrameCallbacks();
    await afterFrame(true, capture);
  }

  // Wait until the page is ready. If readiness is gated on the page's own timers (e.g. a
  // setTimeout after setup), virtual time is stepped on the frame grid until it is; the number of
  // steps is returned so every worker page can start from exactly the same virtual time.
  async function prepare({ waitFor, stepMs, steps, timeoutMs }) {
    await settle(true);
    let readyFlag = false;
    const r = W.__render;
    if (r && r.ready && typeof r.ready.then === 'function') r.ready.then(() => { readyFlag = true; }, () => { readyFlag = true; });
    else readyFlag = true;
    const ok = () => {
      if (!readyFlag) return false;
      if (!waitFor) return true;
      try { return !!(0, eval)(waitFor); } catch { return false; }
    };
    const deadline = realNow() + timeoutMs;
    let k = 0;
    if (steps != null) {
      while (k < steps) await step(++k * stepMs);
    }
    for (;;) {
      await nextTask();
      if (ok()) break;
      if (realNow() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${waitFor || 'window.__render.ready'}`);
      await sleep(10);
      if (ok()) break;
      if (steps == null && (timers.size || rafs.size)) await step(++k * stepMs);
    }
    if (needsSettle()) await settle(false);
    return { steps: k };
  }

  function num(v) {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : null;
  }
  function probe(metaName) {
    const r = W.__render;
    const decl = {};
    const meta = document.querySelector(`meta[name="${metaName}"]`);
    if (meta) {
      for (const part of String(meta.content).split(/[;,]/)) {
        const [k, v] = part.split('=').map((s) => s && s.trim());
        if (k && v) decl[k] = v;
      }
    }
    if (r && typeof r === 'object') Object.assign(decl, r);
    let size = decl.size ? String(decl.size).split('x').map(Number) : null;
    if (num(decl.width) && num(decl.height)) size = [num(decl.width), num(decl.height)];
    let cssEnd = 0;
    let cssInfinite = false;
    const anims = document.getAnimations();
    for (const a of anims) {
      const e = a.effect && a.effect.getComputedTiming().endTime;
      if (e === Infinity) cssInfinite = true;
      else if (e > cssEnd) cssEnd = e;
    }
    let gsapEnd = null;
    try {
      if (W.gsap && W.gsap.globalTimeline) gsapEnd = W.gsap.globalTimeline.duration();
    } catch { /* ignore */ }
    return {
      mode: typeof r === 'function' || (r && typeof r.seek === 'function') ? 'seek' : 'virtual',
      duration: num(decl.duration),
      fps: num(decl.fps),
      size: size && size.every((x) => x > 0) ? size : null,
      animations: anims.length,
      cssEnd: cssEnd / 1000,
      cssInfinite,
      gsapEnd,
      title: document.title,
      webgl: (() => {
        try {
          const c = document.createElement('canvas').getContext('webgl');
          const ext = c && c.getExtension('WEBGL_debug_renderer_info');
          return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
        } catch { return null; }
      })(),
    };
  }

  // Read a page expression after a frame (used by tests and --probe).
  function evaluate(expr) {
    try { return JSON.parse(JSON.stringify((0, eval)(expr))); } catch (e) { return { error: String(e) }; }
  }

  Object.defineProperty(W, '__h2m', {
    value: Object.freeze({ step, seek, post, prepare, probe, evaluate, get now() { return vnow; } }),
    enumerable: false,
  });
}
