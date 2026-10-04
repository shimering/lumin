(function () {
  'use strict';

  let payment = null;
  const MINIMIZE_DURATION = 650;
  const PROGRESS_DURATION = 900;
  const TICK_DURATION = 420;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

  function visibleRect(element) {
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth ? rect : null;
  }

  function transformTo(element, rect, target) {
    // DOM rectangles include Lumin's UI zoom; transform distances use local CSS pixels.
    const zoom = rect.width / element.offsetWidth || 1;
    return `translate(${(target.left + target.width / 2 - rect.left - rect.width / 2) / zoom}px, ${(target.top + target.height / 2 - rect.top - rect.height / 2) / zoom}px) scale(${target.width / rect.width}, ${target.height / rect.height})`;
  }

  async function animate(element, frames, duration, { easing = 'cubic-bezier(0.22, 1, 0.36, 1)', keepFinalFrame = false } = {}) {
    if (!element || reducedMotion() || !element.animate) return;
    const animation = element.animate(frames, { duration, easing, fill: 'both' });
    payment?.animations.add(animation);
    try { await animation.finished; } catch (_) { /* Dismissal cancels opening motion. */ }
    if (!keepFinalFrame) {
      animation.cancel();
      payment?.animations.delete(animation);
    }
  }

  function reset(modal, restoreFocus = false) {
    const previous = payment;
    payment = null;
    previous?.animations.forEach(animation => animation.cancel());
    modal.classList.remove('has-dashboard-motion', 'is-payment-closing');
    modal.querySelector('[role="dialog"]').inert = false;
    if (restoreFocus && visibleRect(previous?.trigger)) previous.trigger.focus({ preventScroll: true });
  }

  function open(modal, trigger, invoiceId) {
    reset(modal);
    const card = trigger?.closest('#dashboard-invoices-list > article');
    const origin = visibleRect(trigger);
    if (!card || !origin) return;
    const indicator = card.querySelector('[data-invoice-payment-indicator]');
    payment = { trigger, card, invoiceId: Number(invoiceId), indicator, saving: false, animations: new Set(), opening: null };
    modal.classList.add('has-dashboard-motion');
    const dialog = modal.querySelector('[role="dialog"]');
    const rect = dialog.getBoundingClientRect();
    payment.opening = animate(dialog, [
      { transform: transformTo(dialog, rect, origin), opacity: 0.4 },
      { opacity: 1, offset: 0.4 },
      { transform: 'translate(0, 0) scale(1, 1)', opacity: 1 }
    ], 300);
  }

  async function waitForOpen() {
    await payment?.opening;
  }

  function holdInvoices() {
    if (!payment) return;
    payment.saving = true;
    // A quiet refresh while the form was open may have replaced the original card.
    payment.card = document.querySelector(`#dashboard-invoices-list > [data-refresh-key="${payment.invoiceId}"]`);
    payment.indicator = payment.card?.querySelector('[data-invoice-payment-indicator]');
  }

  function releaseInvoices() {
    if (payment) payment.saving = false;
  }

  function isHoldingInvoices() {
    return Boolean(payment?.saving);
  }

  async function animateIndicator(indicator, percent, complete) {
    const from = Number(indicator.dataset.paymentPercent) || 0;
    const center = indicator.firstElementChild;
    const label = center.querySelector('span');
    const paint = value => {
      const color = complete && value >= percent ? '#16a34a' : value > 0 ? '#2563eb' : '#cbd5e1';
      indicator.style.background = `conic-gradient(${color} ${value}%, #e2e8f0 ${value}%)`;
      if (label) label.textContent = `${Math.round(value)}%`;
    };
    if (!reducedMotion()) {
      const startedAt = performance.now();
      await new Promise(resolve => {
        function frame(now) {
          const progress = Math.min(1, (now - startedAt) / PROGRESS_DURATION);
          const eased = progress < 0.5 ? 4 * Math.pow(progress, 3) : 1 - Math.pow(-2 * progress + 2, 3) / 2;
          paint(from + (percent - from) * eased);
          if (progress < 1 && indicator.isConnected) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });
    }
    paint(percent);
    indicator.dataset.paymentPercent = String(percent);
    const arabic = document.documentElement.dir === 'rtl';
    indicator.setAttribute('aria-label', arabic ? `${percent}٪ مدفوع` : `${percent}% paid`);
    if (complete) {
      center.innerHTML = '<i data-lucide="check" class="h-3.5 w-3.5 text-emerald-600"></i>';
      if (window.lucide) lucide.createIcons();
      await Promise.all([
        animate(center, [
          { transform: 'rotate(-120deg) scale(0.35)', opacity: 0 },
          { transform: 'rotate(12deg) scale(1.12)', opacity: 1, offset: 0.7 },
          { transform: 'rotate(0deg) scale(1)', opacity: 1 }
        ], TICK_DURATION),
        animate(indicator, [{ transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.45 }, { transform: 'scale(1)' }], TICK_DURATION)
      ]);
      if (!reducedMotion()) await new Promise(resolve => setTimeout(resolve, 160));
    } else {
      await animate(indicator, [{ transform: 'scale(1)' }, { transform: 'scale(1.1)', offset: 0.4 }, { transform: 'scale(1)' }], 180);
    }
  }

  async function removeSettledCard(card) {
    if (!card?.isConnected) return;
    const list = card.parentElement;
    await animate(card, [
      { transform: 'translateX(0)', opacity: 1 },
      { transform: 'translateX(100%)', opacity: 0 }
    ], 280);
    const positions = new Map(Array.from(list.children)
      .filter(row => row !== card).map(row => [row, row.getBoundingClientRect().top]));
    card.remove();
    // FLIP the remaining rows from their previous positions into the newly freed space.
    await Promise.all(Array.from(positions, ([row, top]) => {
      const rect = row.getBoundingClientRect();
      const zoom = rect.width / row.offsetWidth || 1;
      const distance = (top - rect.top) / zoom;
      return distance ? animate(row, [
        { transform: `translateY(${distance}px)` },
        { transform: 'translateY(0)' }
      ], 240) : Promise.resolve();
    }));
  }

  async function complete(modal, invoiceId, percent, fullyPaid, settled = fullyPaid) {
    const current = payment;
    if (!current || current.invoiceId !== Number(invoiceId)) return;
    current.saving = true;
    await current.opening;
    const dialog = modal.querySelector('[role="dialog"]');
    document.activeElement?.blur();
    dialog.inert = true;
    await nextFrame();
    const target = visibleRect(current.indicator);
    const rect = dialog.getBoundingClientRect();
    modal.classList.add('is-payment-closing');
    try {
      await animate(dialog, [
        { transform: 'translate(0, 0) scale(1, 1)', opacity: 1 },
        { transform: target ? transformTo(dialog, rect, target) : 'scale(0.92)', opacity: target ? 1 : 0, borderRadius: '50%' }
      ], target ? MINIMIZE_DURATION : 160, { easing: 'cubic-bezier(0.4, 0, 0.2, 1)', keepFinalFrame: true });
      // Keep the window opaque and at its destination until the minimizing motion finishes.
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (target && payment === current) await animateIndicator(current.indicator, percent, fullyPaid);
      if (settled && payment === current) await removeSettledCard(current.card);
    } finally {
      reset(modal, !fullyPaid);
    }
  }

  window.LuminDashboardMotion = { open, waitForOpen, holdInvoices, releaseInvoices, isHoldingInvoices, complete, reset };
})();
