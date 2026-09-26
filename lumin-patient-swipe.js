(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LuminPatientSwipe = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function isSupportedDevice({ userAgent = '', platform = '', maxTouchPoints = 0, mobile = false, width = 0 } = {}) {
    if (!maxTouchPoints) return false;
    const identity = `${userAgent} ${platform}`;
    if (/iPhone|iPad|iPod|Android/i.test(identity)) return true;
    // iPadOS identifies itself as a Mac even in wide landscape mode.
    if (/Macintosh|MacIntel/i.test(identity) && maxTouchPoints > 1) return true;
    if (/Windows|Macintosh|MacIntel|CrOS|X11|x86_64/i.test(identity)) return false;
    return mobile || /Mobile|Tablet/i.test(identity) || (width > 0 && width <= 1024);
  }

  function create({ surface, enabled, getDestination, onBack, isBlocked = () => false,
    win = window, doc = document }) {
    let gesture = null;
    let timer = null;
    let navigatingBack = false;
    let suppressClickUntil = 0;
    const touch = (event, id) => Array.from(event.touches || []).find(point => point.identifier === id);
    const now = () => win.performance.now();
    const duration = () => win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;

    function excluded(target) {
      if (!target || target.closest('button, a, input, textarea, select, audio, canvas, [role="button"], [role="slider"], [role="tablist"], [contenteditable]:not([contenteditable="false"]), [data-swipe-back-ignore], .clinical-odontogram-stage, #lightbox-viewport')) return true;
      for (let node = target; node && node !== surface; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
        if (style.touchAction === 'none') return true;
      }
      return false;
    }

    function cleanup(committed = false) {
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      const state = gesture;
      gesture = null;
      if (!state?.preview) return;
      surface.style.cssText = state.sourceStyle;
      surface.classList.remove('patient-swipe-source');
      const destination = state.preview;
      destination.style.cssText = state.destinationStyle;
      destination.classList.remove('patient-swipe-destination');
      destination.inert = state.destinationInert;
      if (state.destinationAria === null) destination.removeAttribute('aria-hidden');
      else destination.setAttribute('aria-hidden', state.destinationAria);
      state.placeholder.remove();
      doc.documentElement.style.overflow = state.rootOverflow;
      doc.body.style.overflow = state.bodyOverflow;
      doc.body.classList.remove('patient-swipe-active');
      if (!committed) win.scrollTo(state.scrollX, state.scrollY);
    }

    function cancel() {
      // switchView is also called by onBack; retain the preview until that route is ready.
      if (!navigatingBack) cleanup();
    }

    function reveal() {
      const destination = getDestination();
      if (!destination || destination === surface || !destination.classList.contains('hidden')) return false;
      const state = gesture;
      const rect = surface.getBoundingClientRect();
      const main = surface.parentElement;
      const mainRect = main.getBoundingClientRect();
      const scale = Number.parseFloat(win.getComputedStyle(doc.documentElement).zoom) || 1;
      const top = Math.max(0, mainRect.top) + (Number.parseFloat(win.getComputedStyle(main).paddingTop) || 0) * scale;
      const placeholder = doc.createElement('div');
      placeholder.style.height = `${surface.offsetHeight}px`;
      placeholder.setAttribute('aria-hidden', 'true');
      surface.before(placeholder);
      Object.assign(state, {
        preview: destination, placeholder, scale, width: rect.width,
        sourceStyle: surface.style.cssText, destinationStyle: destination.style.cssText,
        destinationInert: destination.inert, destinationAria: destination.getAttribute('aria-hidden'),
        rootOverflow: doc.documentElement.style.overflow, bodyOverflow: doc.body.style.overflow,
        scrollX: win.scrollX, scrollY: win.scrollY
      });
      surface.classList.add('patient-swipe-source');
      Object.assign(surface.style, {
        left: `${rect.left / scale}px`, top: `${rect.top / scale}px`, width: `${rect.width / scale}px`,
        minHeight: `${(win.innerHeight - Math.min(0, rect.top)) / scale}px`, transition: 'none'
      });
      destination.classList.add('patient-swipe-destination');
      destination.inert = true;
      destination.setAttribute('aria-hidden', 'true');
      Object.assign(destination.style, {
        left: `${rect.left / scale}px`, top: `${top / scale}px`, width: `${rect.width / scale}px`,
        height: `${(win.innerHeight - top) / scale}px`, transition: 'none'
      });
      doc.documentElement.style.overflow = 'hidden';
      doc.body.style.overflow = 'hidden';
      doc.body.classList.add('patient-swipe-active');
      return true;
    }

    function paint(distance) {
      const state = gesture;
      const progress = Math.min(1, distance / state.width);
      surface.style.transform = `translate3d(${distance / state.scale}px, 0, 0)`;
      state.preview.style.transform = `translate3d(${-24 * (1 - progress)}px, 0, 0)`;
      state.preview.style.filter = `brightness(${0.9 + progress * 0.1})`;
    }

    function settle(commit) {
      const state = gesture;
      state.phase = commit ? 'committing' : 'settling';
      suppressClickUntil = now() + 500;
      const milliseconds = duration();
      surface.style.transition = `transform ${milliseconds}ms ease-out`;
      state.preview.style.transition = `transform ${milliseconds}ms ease-out, filter ${milliseconds}ms ease-out`;
      paint(commit ? Math.max(state.width, win.innerWidth) + 32 : 0);
      timer = win.setTimeout(async () => {
        timer = null;
        if (gesture !== state) return;
        if (!commit) { cleanup(); return; }
        navigatingBack = true;
        try { await onBack(); }
        catch (error) { win.console.error('Patient swipe back navigation failed', error); }
        finally { navigatingBack = false; cleanup(true); }
      }, milliseconds);
    }

    surface.addEventListener('touchstart', event => {
      if (gesture || !enabled() || surface.classList.contains('hidden') || isBlocked() || event.touches.length !== 1 || excluded(event.target)) return;
      const point = event.touches[0];
      gesture = { phase: 'pending', id: point.identifier, x: point.clientX, y: point.clientY,
        distance: 0, lastX: point.clientX, lastTime: now(), velocity: 0 };
    }, { passive: true });

    surface.addEventListener('touchmove', event => {
      const state = gesture;
      if (!state || !['pending', 'dragging'].includes(state.phase)) return;
      if (!enabled() || isBlocked() || event.touches.length !== 1) { cleanup(); return; }
      const point = touch(event, state.id);
      if (!point) { cleanup(); return; }
      const dx = point.clientX - state.x;
      const dy = Math.abs(point.clientY - state.y);
      if (state.phase === 'pending') {
        if (dx < -8 || (dy > 8 && dy > Math.abs(dx))) { cleanup(); return; }
        if (dx < 12 || dx < dy * 1.35) return;
        // Browsers cancel the stream once native scrolling wins the gesture.
        if (!event.cancelable || !reveal()) { cleanup(); return; }
        state.phase = 'dragging';
      }
      event.preventDefault();
      const time = now();
      state.velocity = (point.clientX - state.lastX) / Math.max(1, time - state.lastTime);
      state.lastX = point.clientX;
      state.lastTime = time;
      state.distance = Math.max(0, Math.min(dx, state.width));
      paint(state.distance);
    }, { passive: false });

    surface.addEventListener('touchend', event => {
      const state = gesture;
      if (!state || !['pending', 'dragging'].includes(state.phase)) return;
      if (event.touches.length || !enabled()) { cleanup(); return; }
      if (state.phase === 'pending') { cleanup(); return; }
      if (event.cancelable) event.preventDefault();
      const flick = now() - state.lastTime < 100 && state.velocity > 0.45 && state.distance >= 64;
      settle(state.distance >= Math.min(200, state.width * 0.32) || flick);
    }, { passive: false });
    surface.addEventListener('touchcancel', cancel, { passive: true });
    surface.addEventListener('click', event => {
      if (event.detail && now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    win.addEventListener('resize', cancel);
    win.addEventListener('pagehide', cancel);
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) cancel(); });
    return { cancel };
  }

  return { isSupportedDevice, create };
});
