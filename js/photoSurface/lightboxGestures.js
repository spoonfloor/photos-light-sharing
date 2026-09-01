/**
 * Lightbox narrow-width gestures — pinch-zoom, pan-while-zoomed, edge
 * overscroll. See docs/lightbox-pinch-zoom-plan.md. Same module shape as
 * lightboxShell.js: IIFE, wire(ctx) adapter, no framework.
 *
 * PHASE A (skeleton): the dedicated transform layer (.lightbox-gesture-layer),
 * the shared rubber-band / snap-back helpers, reset() / isZoomed() /
 * isGestureActive() so the shell recognizer can stand down.
 *
 * PHASES B–E (this file today): the live recognizer on #lightboxContent
 * (capture phase, touchmove non-passive), bound by activate() on lightbox
 * open and dropped by deactivate() on close. One handler, branched on state:
 *  - EDGE OVERSCROLL (B) — at 1×, a 1-finger horizontal drag toward a
 *    boundary where canNavigate(dir) is false rubber-bands
 *    .lightbox-gesture-layer and snaps back on release. Never pages, never
 *    persists. The one scoped exception to the shell's "hard cut" rule.
 *  - PINCH (C) — 2 fingers scale the layer about the finger midpoint, from 1×
 *    (fit) to a computed 1:1 source-pixel ceiling, rubber-banding past both
 *    ends and snapping back on release. No-op on video.
 *  - PAN (C) — 1-finger drag while isZoomed(), composed with the settled zoom
 *    transform, clamped to the image edges (rubber-band past).
 *  - DOUBLE-TAP (D) — two quick taps toggle zoom: 1× → dbltapScale centred on
 *    the tap (clamped ≤ ceiling), any zoom → 1×. The shell holds its
 *    single-tap chrome toggle for dbltapWindowMs to disambiguate.
 * Tuning knobs (E) live in CSS and are read on activate(); the whole module
 * is inert unless isNarrowCoarse(); pagehide / tab-hide reset zoom.
 * A drag that isn't one of those (vertical, mid-strip, toward a valid
 * neighbour) is NOT captured — the shell's release-time classifier handles it
 * exactly as before.
 */
const LightboxGestures = (() => {
  /** @type {object | null} */
  let ctx = null;
  let wired = false;

  // --- Tuning knobs ------------------------------------------------------
  // The dial-able values live in CSS (@media (max-width: 480px) :root in
  // styles.css, as unitless numbers) and are read into these once per lightbox
  // open by readKnobs() / activate(). The fallbacks are the ship defaults —
  // used before the first activate(), and on a viewport where the ≤480 block
  // isn't active (the module is inert there anyway).
  let rubberC = 0.55; // --lightbox-gesture-rubber-c
  let overscrollMax = 68; // --lightbox-overscroll-max-px
  let dbltapScale = 2.5; // --lightbox-zoom-dbltap-scale
  let dbltapWindowMs = 300; // --lightbox-zoom-dbltap-window-ms

  // NOT a knob: the pinch ceiling is computed per photo (natural px vs
  // rendered px); this is only OpenSeadragon's maxZoomPixelRatio slack.
  const MAX_ZOOM_PIXEL_RATIO = 1.1;
  // The snap-back tween reuses --lightbox-anim-entry-* (plan A2 §4), and the
  // overscroll capture threshold reuses the shell's TAP_MAX_MOVEMENT (via
  // ctx.tapMaxMovement) — neither is redefined here.

  function readKnobs() {
    if (typeof getComputedStyle !== 'function') {
      return;
    }
    const cs = getComputedStyle(document.documentElement);
    const num = (name, fallback) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : fallback;
    };
    rubberC = num('--lightbox-gesture-rubber-c', 0.55);
    overscrollMax = num('--lightbox-overscroll-max-px', 68);
    dbltapScale = num('--lightbox-zoom-dbltap-scale', 2.5);
    dbltapWindowMs = num('--lightbox-zoom-dbltap-window-ms', 300);
  }

  const NARROW_QUERY = '(max-width: 480px)';
  const COARSE_QUERY = '(pointer: coarse)';

  // Settled layer transform — carries zoom + pan across releases. `phase` is
  // non-IDLE only while a gesture (or its snap-back) owns the touch — that,
  // together with `isZoomed()`, is when the shell recognizer stands down.
  let settledScale = 1;
  let settledTx = 0;
  let settledTy = 0;
  let phase = 'IDLE'; // IDLE | PINCHING | PANNING | OVERSCROLLING

  // Last transform actually written to the layer this gesture — settle reads
  // these back rather than parsing computed style.
  let liveScale = 1;
  let liveTx = 0;
  let liveTy = 0;

  // Live-recognizer scratch state.
  let startX = 0;
  let startY = 0;
  let armed = false; // a 1-finger touch is down and still a capture candidate
  /** @type {HTMLElement | null} */
  let activeLayer = null; // the gesture layer this touch transforms
  // Bumped whenever a settle starts or a new touch interrupts one, so a stale
  // snap-back's onDone can't drive the phase of a gesture that superseded it.
  let settleGen = 0;

  // Double-tap chain: timestamp of the first tap awaiting its partner, and of
  // the most recent completed double-tap (the shell reads the latter to know
  // its pending single-tap chrome toggle was consumed).
  let tapChainAt = 0;
  let doubleTapAt = 0;

  // Pinch scratch (2-finger).
  let pinchDist0 = 1;
  let pinchBaseScale = 1;
  let pinchLocalX = 0; // initial midpoint in layer-local coords
  let pinchLocalY = 0;
  let pinchCeiling = 1;
  /** @type {DOMRect | null} */
  let pinchFrame = null; // frame box at pinch start (frame is not gesture-transformed)

  /**
   * iOS rubber-band resistance: f(x, d, c) = x·d·c / (d + c·|x|), sign-kept.
   * Near-linear for small overshoot, asymptotically flattening as it grows.
   * Shared by the pinch clamp (Phase C) and edge overscroll (Phase B).
   * `x` raw overshoot px, `d` viewport dimension along the axis.
   */
  function rubberBand(x, d, c = rubberC) {
    if (!x || d <= 0) {
      return 0;
    }
    const abs = Math.abs(x);
    return Math.sign(x) * ((abs * d * c) / (d + c * abs));
  }

  // `transform <duration> <easing>` for the snap-back, built from the frame
  // entry slide's CSS tokens so the two motions match exactly (plan A2 §4).
  function snapBackTransition() {
    const cs = getComputedStyle(document.documentElement);
    const duration =
      cs.getPropertyValue('--lightbox-anim-entry-duration').trim() || '200ms';
    const easing =
      cs.getPropertyValue('--lightbox-anim-entry-ease').trim() ||
      'cubic-bezier(0.4, 0.4, 0, 1)';
    return `transform ${duration} ${easing}`;
  }

  /**
   * Tween `layer`'s transform to `toTransform` (default: identity), then
   * strip the inline transition. Instant under prefers-reduced-motion.
   * Delegates the reflow-prime / filtered-transitionend / timeout-backstop
   * choreography to the shared LightboxMedia.animateTransform primitive
   * (plan A2 §2). Shared by pinch snap-back and overscroll snap-back
   * (Phases B/C).
   */
  function tweenTransform(layer, toTransform = '', onDone) {
    const done = typeof onDone === 'function' ? onDone : () => {};
    if (!layer) {
      done();
      return;
    }
    if (LightboxMedia.prefersReducedMotion()) {
      layer.style.transition = '';
      layer.style.transform = toTransform;
      done();
      return;
    }
    LightboxMedia.animateTransform(layer, {
      arm: () => {
        layer.style.transition = snapBackTransition();
        layer.style.transform = toTransform;
      },
      settle: () => {
        layer.style.transition = '';
        done();
      },
    });
  }

  function gestureLayers() {
    const content = document.getElementById('lightboxContent');
    return content
      ? Array.from(content.querySelectorAll('.lightbox-gesture-layer'))
      : [];
  }

  /**
   * Return every gesture layer to identity, immediately. Idempotent + cheap:
   * lightboxMedia calls this at the tail of applyMediaStyles (so it fires on
   * every nav / rotate / resize relayout); later phases also call it when the
   * app is backgrounded.
   */
  function reset() {
    settledScale = 1;
    settledTx = 0;
    settledTy = 0;
    liveScale = 1;
    liveTx = 0;
    liveTy = 0;
    phase = 'IDLE';
    armed = false;
    activeLayer = null;
    tapChainAt = 0;
    settleGen++;
    for (const layer of gestureLayers()) {
      layer.style.transition = '';
      layer.style.transform = '';
      if (layer.parentElement) {
        layer.parentElement.classList.remove('gesture-zoomed');
      }
    }
  }

  function isZoomed() {
    return settledScale > 1;
  }

  function isGestureActive() {
    return phase !== 'IDLE';
  }

  /**
   * The module only arms on touch devices at the narrow breakpoint — the same
   * "≤480 + coarse" gate the rest of the lightbox batch uses. Phases B–D
   * consult this before binding the recognizer; wide / desktop stays inert.
   */
  function isNarrowCoarse() {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia(NARROW_QUERY).matches &&
      window.matchMedia(COARSE_QUERY).matches
    );
  }

  // --- Live recognizer (Phase B overscroll + Phase C pinch/pan) --------

  function contentEl() {
    return document.getElementById('lightboxContent');
  }

  function viewportWidth() {
    const c = contentEl();
    return (c && c.clientWidth) || window.innerWidth || 1;
  }

  function captureThreshold() {
    const t = ctx && Number(ctx.tapMaxMovement);
    return t > 0 ? t : LightboxShell.TAP_MAX_MOVEMENT;
  }

  function canPage(dir) {
    return typeof ctx?.canNavigate === 'function' ? ctx.canNavigate(dir) : true;
  }

  // The frame box (frame is never gesture-transformed — tier 1 is entry/exit
  // only, identity at rest). Origin + size the layer's transform is measured
  // against, since the layer is `inset: 0` within it. Falls back to the
  // mounted layer when no gesture is currently holding `activeLayer` (e.g. a
  // pan settling, or double-tap fired from outside a touch).
  function frameBox() {
    const l = activeLayer || gestureLayers()[0];
    return l && l.parentElement ? l.parentElement.getBoundingClientRect() : null;
  }

  // Is a zoom (settled, or a live pinch/pan) on screen? Drives .gesture-zoomed,
  // which lifts the frame's clip so the scaled layer can fill the viewport.
  function zoomActive() {
    return phase === 'PINCHING' || phase === 'PANNING' || settledScale > 1;
  }
  function applyZoomClip() {
    const on = zoomActive();
    for (const l of gestureLayers()) {
      if (l.parentElement) {
        l.parentElement.classList.toggle('gesture-zoomed', on);
      }
    }
  }

  // Write `translate(tx,ty) scale(s)` to the layer (identity → empty string)
  // and record it so settle() can read the live transform back without
  // parsing computed style.
  function writeLayer(s, tx, ty) {
    liveScale = s;
    liveTx = tx;
    liveTy = ty;
    if (!activeLayer) {
      return;
    }
    activeLayer.style.transition = '';
    activeLayer.style.transform =
      s === 1 && !tx && !ty ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    applyZoomClip();
  }

  // Translation range that keeps a scale-`s` layer covering the VIEWPORT
  // (.lightbox-content), not just the fit-sized frame — so a zoomed
  // letterboxed photo can pan into what used to be its black bars. `lo > hi`
  // on an axis ⇒ the photo can't cover the viewport there even zoomed, so it
  // locks to the midpoint. Past the range, pan rubber-bands.
  function panBounds(s) {
    const frame = frameBox();
    const cEl = contentEl();
    const content = cEl && cEl.getBoundingClientRect();
    if (!frame || !frame.width || !content) {
      return null;
    }
    return {
      hiX: content.left - frame.left,
      loX: content.right - frame.left - s * frame.width,
      hiY: content.top - frame.top,
      loY: content.bottom - frame.top - s * frame.height,
      w: frame.width,
      h: frame.height,
    };
  }

  function clampPanAxis(v, lo, hi, rubber, dim) {
    if (lo > hi) {
      return (lo + hi) / 2; // photo smaller than the viewport on this axis
    }
    if (v > hi) {
      return rubber ? hi + Math.min(overscrollMax, rubberBand(v - hi, dim)) : hi;
    }
    if (v < lo) {
      return rubber ? lo - Math.min(overscrollMax, rubberBand(lo - v, dim)) : lo;
    }
    return v;
  }

  function clampPan(tx, ty, s, rubber) {
    const b = panBounds(s);
    if (!b) {
      return { tx, ty };
    }
    return {
      tx: clampPanAxis(tx, b.loX, b.hiX, rubber, b.w),
      ty: clampPanAxis(ty, b.loY, b.hiY, rubber, b.h),
    };
  }

  // --- Phase B: edge overscroll (1-finger, at 1×) ----------------------

  // Pull the layer `dx` px against the rubber-band, capped at overscrollMax.
  function applyOverscroll(dx) {
    const damped = rubberBand(dx, viewportWidth());
    const tx = Math.max(-overscrollMax, Math.min(overscrollMax, damped));
    writeLayer(1, tx, 0);
  }

  // --- Phase C: pinch-zoom + zoom-aware pan ----------------------------

  function isVideoLayer() {
    return !!(activeLayer && activeLayer.querySelector('video'));
  }

  function touchDist(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
  }
  function touchMid(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  // 1:1 ceiling — the layer scale at which one source pixel ≈ one CSS pixel,
  // plus MAX_ZOOM_PIXEL_RATIO slack. Computed per photo, never a token. Falls
  // back to 1 (no zoom) for video / placeholder / missing natural size.
  function computeCeiling() {
    const media = activeLayer && activeLayer.querySelector('img.lightbox-media-element');
    const box = frameBox();
    if (!media || !media.naturalWidth || !box || !box.width) {
      return 1;
    }
    const natural = Math.max(media.naturalWidth, media.naturalHeight);
    const rendered = Math.max(box.width, box.height);
    return Math.max(1, (MAX_ZOOM_PIXEL_RATIO * natural) / rendered);
  }

  // Scale rubber-band: shared f() with d = 1 (unit overshoot). Device-tuned F.
  function clampScale(raw) {
    if (raw < 1) {
      return 1 - rubberBand(1 - raw, 1);
    }
    if (raw > pinchCeiling) {
      return pinchCeiling + rubberBand(raw - pinchCeiling, 1);
    }
    return raw;
  }

  // PAN while zoomed: 1-finger drag composes with the settled zoom transform,
  // clamped to the image edges (rubber-band past). Inert until a zoom exists.
  function applyPan(dx, dy) {
    if (!frameBox()) {
      return;
    }
    const c = clampPan(settledTx + dx, settledTy + dy, settledScale, true);
    writeLayer(settledScale, c.tx, c.ty);
  }

  function beginPinch(e) {
    activeLayer = gestureLayers()[0] || null;
    armed = false;
    if (!activeLayer || isVideoLayer()) {
      return; // pinch is a no-op on video / empty (locked decision)
    }
    const a = e.touches[0];
    const b = e.touches[1];
    pinchFrame = frameBox();
    if (!pinchFrame) {
      activeLayer = null;
      return;
    }
    pinchDist0 = touchDist(a, b);
    pinchBaseScale = settledScale;
    const mid = touchMid(a, b);
    pinchLocalX = (mid.x - pinchFrame.left - settledTx) / settledScale;
    pinchLocalY = (mid.y - pinchFrame.top - settledTy) / settledScale;
    pinchCeiling = computeCeiling();
    phase = 'PINCHING';
    applyZoomClip(); // lift the frame clip for the duration of the pinch
    settleGen++; // supersede any pending overscroll/pan snap-back
  }

  function movePinch(e) {
    e.preventDefault();
    const a = e.touches[0];
    const b = e.touches[1];
    const s = clampScale(pinchBaseScale * (touchDist(a, b) / pinchDist0));
    const mid = touchMid(a, b);
    // Keep the layer-local point under the initial midpoint under the current
    // midpoint (scale about the fingers + track their drift).
    writeLayer(
      s,
      mid.x - pinchFrame.left - pinchLocalX * s,
      mid.y - pinchFrame.top - pinchLocalY * s,
    );
  }

  // Settle a pinch: snap scale out of the rubber-band zone, clamp pan to the
  // edges, tween to rest. scale ≤ 1 → back to identity (isZoomed() false).
  function settlePinch() {
    const layer = activeLayer;
    const box = pinchFrame || frameBox();
    activeLayer = null;
    const gen = ++settleGen;
    const s = Math.min(pinchCeiling, Math.max(1, liveScale));
    if (s <= 1 + 1e-3 || !box) {
      settledScale = liveScale = 1;
      settledTx = liveTx = 0;
      settledTy = liveTy = 0;
      phase = 'IDLE';
      // Keep the frame clip lifted until the shrink-to-1× finishes.
      tweenTransform(layer, '', applyZoomClip);
      return;
    }
    const c = clampPan(liveTx, liveTy, s, false);
    settledScale = s;
    settledTx = c.tx;
    settledTy = c.ty;
    liveScale = s;
    liveTx = c.tx;
    liveTy = c.ty;
    phase = 'IDLE'; // zoomed at rest: isZoomed() true, isGestureActive() false
    applyZoomClip();
    tweenTransform(layer, `translate(${c.tx}px, ${c.ty}px) scale(${s})`, () => {
      void gen;
    });
  }

  // --- Phase D: double-tap toggle ------------------------------------

  // From 1× → animate to dbltapScale (clamped ≤ ceiling) centred on the tap;
  // from any zoom → animate to 1×. Instant-ish (tween), phase never leaves
  // IDLE — isZoomed() flips synchronously so the shell seam tracks it. Public
  // (also usable by a zoom control) so it carries its own coarse-pointer gate.
  function toggleZoom(clientX, clientY) {
    if (!isNarrowCoarse()) {
      return;
    }
    const layer = gestureLayers()[0];
    if (!layer) {
      return;
    }
    activeLayer = layer;
    const gen = ++settleGen;
    if (isZoomed()) {
      settledScale = liveScale = 1;
      settledTx = liveTx = 0;
      settledTy = liveTy = 0;
      tweenTransform(layer, '', applyZoomClip); // clear clip after the shrink
      activeLayer = null;
      return;
    }
    const box = frameBox();
    if (!box || !box.width || isVideoLayer()) {
      activeLayer = null;
      return;
    }
    const s = Math.min(dbltapScale, computeCeiling());
    if (s <= 1 + 1e-3) {
      activeLayer = null;
      return; // image too small to zoom into
    }
    // Keep the tapped point fixed on screen (local point p → p, so tx = p(1−s)).
    const c = clampPan(
      (clientX - box.left) * (1 - s),
      (clientY - box.top) * (1 - s),
      s,
      false,
    );
    settledScale = liveScale = s;
    settledTx = liveTx = c.tx;
    settledTy = liveTy = c.ty;
    applyZoomClip();
    tweenTransform(layer, `translate(${c.tx}px, ${c.ty}px) scale(${s})`, () => {
      void gen;
    });
    activeLayer = null;
  }

  // Called from onTouchEnd for a stationary 1-finger release. Second tap
  // within the window → double-tap.
  function handleTap(x, y) {
    const now = Date.now();
    if (now - tapChainAt < dbltapWindowMs) {
      tapChainAt = 0;
      doubleTapAt = now;
      toggleZoom(x, y);
    } else {
      tapChainAt = now;
    }
  }

  function lastDoubleTapAt() {
    return doubleTapAt;
  }

  // --- shared touch entry points --------------------------------------

  function onTouchStart(e) {
    if (!isNarrowCoarse()) {
      return;
    }
    if (e.touches.length === 2) {
      beginPinch(e);
      return;
    }
    if (e.touches.length !== 1) {
      armed = false;
      return;
    }
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    activeLayer = gestureLayers()[0] || null;
    armed = true;
    if (phase === 'OVERSCROLLING') {
      // New touch during a snap-back — invalidate its pending onDone, freeze
      // the layer where it is, keep dragging from here.
      settleGen++;
      if (activeLayer) {
        activeLayer.style.transition = '';
      }
    }
    // Stay IDLE for now even when zoomed: the first move past threshold
    // promotes to PANNING (onTouchMove), a stationary release resolves as a
    // tap (double-tap detection needs to see it). A touchstart that instantly
    // claimed PANNING could never be a tap.
  }

  function onTouchMove(e) {
    if (phase === 'PINCHING') {
      if (e.touches.length >= 2 && activeLayer) {
        movePinch(e);
      }
      return;
    }
    if (!armed || e.touches.length !== 1) {
      return;
    }
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (phase === 'PANNING') {
      e.preventDefault();
      applyPan(dx, dy);
      return;
    }

    // phase === IDLE: the first move past the threshold decides. Bias
    // horizontal — a lazy diagonal at a boundary rubber-bands, it doesn't exit.
    const threshold = captureThreshold();
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) {
      return;
    }
    if (isZoomed()) {
      phase = 'PANNING';
      e.preventDefault();
      applyPan(dx, dy);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      // dx < 0 → dragging toward "next"; dx > 0 → toward "previous".
      const dir = dx < 0 ? 1 : -1;
      if (!canPage(dir) && activeLayer) {
        phase = 'OVERSCROLLING';
        e.preventDefault();
        applyOverscroll(dx);
        return;
      }
    }
    // Not ours: a vertical gesture, or a horizontal swipe toward a valid
    // neighbour. Hand the whole touch back — the shell's release-time
    // classifier runs untouched (we never preventDefault'd).
    armed = false;
  }

  function settleTouch() {
    armed = false;
    const layer = activeLayer;
    activeLayer = null;
    if (phase === 'OVERSCROLLING') {
      const gen = ++settleGen;
      liveScale = 1;
      liveTx = 0;
      liveTy = 0;
      tweenTransform(layer, '', () => {
        if (gen === settleGen && phase === 'OVERSCROLLING') {
          phase = 'IDLE';
        }
      });
    } else if (phase === 'PANNING') {
      const gen = ++settleGen;
      if (frameBox() && settledScale > 1) {
        const c = clampPan(liveTx, liveTy, settledScale, false);
        settledTx = liveTx = c.tx;
        settledTy = liveTy = c.ty;
        tweenTransform(
          layer,
          `translate(${c.tx}px, ${c.ty}px) scale(${settledScale})`,
          () => {
            if (gen === settleGen && phase === 'PANNING') {
              phase = 'IDLE';
              applyZoomClip();
            }
          },
        );
      } else {
        phase = 'IDLE';
        applyZoomClip();
      }
    }
  }

  function onTouchEnd(e) {
    const remaining = e.touches ? e.touches.length : 0;
    if (phase === 'PINCHING') {
      if (remaining >= 2) {
        return; // still pinching
      }
      settlePinch();
      if (remaining === 1 && isZoomed()) {
        // Hand the surviving finger straight to pan.
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        activeLayer = gestureLayers()[0] || null;
        armed = true;
        phase = 'PANNING';
      }
      return;
    }
    if (remaining > 0) {
      return; // fingers still down
    }
    // A stationary 1-finger release is a tap — feed the double-tap detector.
    // Also valid mid-PANNING-snap-back (phase can still read 'PANNING' while a
    // pan's settle tween runs): the settle already committed settledTx/Ty, so
    // just abandon that bookkeeping and take the tap (lets a double-tap zoom
    // out land even if the second tap arrives during the pan snap-back).
    const ct = e.changedTouches && e.changedTouches[0];
    const stationary =
      armed &&
      ct &&
      Math.hypot(ct.clientX - startX, ct.clientY - startY) <= captureThreshold();
    if (stationary && (phase === 'IDLE' || phase === 'PANNING')) {
      armed = false;
      activeLayer = null;
      phase = 'IDLE';
      handleTap(ct.clientX, ct.clientY);
      return;
    }
    settleTouch();
  }

  const TOUCH_OPTS = { capture: true, passive: true };
  const MOVE_OPTS = { capture: true, passive: false };

  // Bind / unbind the live recognizer on #lightboxContent (a stable element —
  // its children are swapped per nav). activate() on lightbox open, deactivate()
  // on close, so the module holds no listener while nothing is on screen.
  function activate() {
    const c = contentEl();
    if (!c) {
      return;
    }
    readKnobs();
    if (c.dataset.gesturesBound === '1') {
      return;
    }
    c.dataset.gesturesBound = '1';
    c.addEventListener('touchstart', onTouchStart, TOUCH_OPTS);
    c.addEventListener('touchmove', onTouchMove, MOVE_OPTS);
    c.addEventListener('touchend', onTouchEnd, TOUCH_OPTS);
    c.addEventListener('touchcancel', onTouchEnd, TOUCH_OPTS);
  }

  function deactivate() {
    const c = contentEl();
    if (c && c.dataset.gesturesBound === '1') {
      delete c.dataset.gesturesBound;
      c.removeEventListener('touchstart', onTouchStart, TOUCH_OPTS);
      c.removeEventListener('touchmove', onTouchMove, MOVE_OPTS);
      c.removeEventListener('touchend', onTouchEnd, TOUCH_OPTS);
      c.removeEventListener('touchcancel', onTouchEnd, TOUCH_OPTS);
    }
    reset();
    doubleTapAt = 0;
  }

  // iOS Photos drops zoom when you leave the app; match that. `pagehide` is
  // the iOS-Safari "leaving for real" signal (nav away, app backgrounded into
  // the page cache, tab closed). Deliberately NOT `visibilitychange` — that
  // also fires for a glance at the notification shade or a quick app-switch
  // peek, and losing your zoom on those would be surprising.
  let bgResetBound = false;
  function bindBackgroundReset() {
    if (bgResetBound || typeof window.addEventListener !== 'function') {
      return;
    }
    bgResetBound = true;
    window.addEventListener('pagehide', reset);
  }

  function wire(adapter) {
    if (wired) {
      return;
    }
    ctx = adapter || null;
    wired = true;
    bindBackgroundReset();
    activate(); // safe before the first open; LightboxShell re-runs it on show()
  }

  return {
    wire,
    activate, // LightboxShell.show()
    deactivate, // LightboxShell.hide()
    reset,
    isZoomed,
    isGestureActive,
    toggleZoom, // double-tap zoom; also usable by a future zoom control
    // Read by LightboxShell to disambiguate its single-tap chrome toggle.
    dblTapWindowMs: () => dbltapWindowMs,
    lastDoubleTapAt,
    // exposed for the phases that build on this skeleton + their tests
    rubberBand,
    tweenTransform,
    isNarrowCoarse,
  };
})();
