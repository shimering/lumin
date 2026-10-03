/* A shared, platform-independent appointment status picker. */
(function () {
  'use strict';

  window.createLuminAppointmentStatusPicker = function ({ statuses, getLabel, getAccessibleLabel, canModify, onChange }) {
    const pending = new Set();
    let anchor = null, menu = null, observer = null, positionFrame = null;
    let search = '', searchTime = 0, menuSequence = 0;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const findTrigger = id => Array.from(document.querySelectorAll('[data-appointment-status-trigger]')).find(button => button.dataset.appointmentId === id);

    function markup(entry) {
      return `<button type="button" class="lumin-status-trigger" data-appointment-status-trigger data-appointment-id="${escape(entry.id)}" data-status="${escape(entry.status)}" aria-label="${escape(getAccessibleLabel(entry))}" aria-haspopup="listbox" aria-expanded="false" ${!canModify() || pending.has(String(entry.id)) ? 'disabled' : ''} ${pending.has(String(entry.id)) ? 'aria-busy="true"' : ''}>
        <span data-status-label aria-live="polite" aria-atomic="true">${escape(getLabel(entry.status))}</span>
        <i data-lucide="chevron-down" class="lumin-status-chevron" aria-hidden="true"></i>
      </button>`;
    }

    function paint(button, status, animate = false) {
      if (!button) return;
      const label = button.querySelector('[data-status-label]');
      const previousText = label.textContent;
      const previousWidth = button.offsetWidth;
      button.dataset.status = status;
      label.textContent = getLabel(status);
      if (!animate || previousText === label.textContent || reducedMotion() || !label.animate) return;
      button.animate([{ width: `${previousWidth}px` }, { width: `${button.offsetWidth}px` }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
      const oldLabel = document.createElement('span');
      oldLabel.className = 'lumin-status-old-label';
      oldLabel.textContent = previousText;
      oldLabel.setAttribute('aria-hidden', 'true');
      button.appendChild(oldLabel);
      oldLabel.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 160, easing: 'ease-out', fill: 'forwards' }).finished.then(() => oldLabel.remove()).catch(() => oldLabel.remove());
      label.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }

    // Retain the actual control through a card refresh so its animation and focus survive a fast save.
    function retainTrigger(previousCard, nextCard) {
      const previous = previousCard.querySelector('[data-appointment-status-trigger]');
      const next = nextCard.querySelector('[data-appointment-status-trigger]');
      if (previous && next) {
        previous.setAttribute('aria-label', next.getAttribute('aria-label'));
        previous.disabled = next.disabled;
        if (!pending.has(previous.dataset.appointmentId)) paint(previous, next.dataset.status, true);
        next.replaceWith(previous);
      }
      return nextCard;
    }

    function close(restoreFocus = false, animate = true) {
      const previousAnchor = anchor, previousMenu = menu;
      anchor = menu = null;
      observer?.disconnect();
      observer = null;
      if (positionFrame !== null) cancelAnimationFrame(positionFrame);
      positionFrame = null;
      previousAnchor?.setAttribute('aria-expanded', 'false');
      previousAnchor?.removeAttribute('aria-controls');
      if (restoreFocus && previousAnchor?.isConnected) previousAnchor.focus({ preventScroll: true });
      if (!previousMenu) return;
      previousMenu.style.pointerEvents = 'none';
      previousMenu.setAttribute('aria-hidden', 'true');
      previousMenu.inert = true;
      const panel = previousMenu.firstElementChild;
      if (animate && !reducedMotion() && panel.animate) {
        panel.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: `translateY(${previousMenu.dataset.side === 'above' ? 5 : -5}px) scale(.98)` }], { duration: 130, easing: 'ease-in', fill: 'forwards' }).finished.then(() => previousMenu.remove()).catch(() => previousMenu.remove());
      } else previousMenu.remove();
    }

    function position() {
      if (!anchor?.isConnected || !menu) return close();
      const bounds = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewLeft = viewport?.offsetLeft || 0, viewTop = viewport?.offsetTop || 0;
      const viewWidth = viewport?.width || window.innerWidth, viewHeight = viewport?.height || window.innerHeight;
      if (anchor.disabled || !anchor.getClientRects().length || bounds.bottom < viewTop || bounds.top > viewTop + viewHeight) return close();
      // Fixed portals inherit the application's CSS zoom. Convert physical viewport pixels back to CSS pixels.
      const scale = menu.getBoundingClientRect().width / menu.offsetWidth || 1;
      const margin = 12, gap = 8;
      const menuStyle = getComputedStyle(menu);
      const safeTop = parseFloat(menuStyle.getPropertyValue('--lumin-status-safe-top')) || 0;
      const safeBottom = parseFloat(menuStyle.getPropertyValue('--lumin-status-safe-bottom')) || 0;
      const width = Math.min(Math.max(216 * scale, bounds.width), viewWidth - margin * 2);
      menu.style.width = `${width / scale}px`;
      const below = viewTop + viewHeight - bounds.bottom - margin - gap - safeBottom;
      const above = bounds.top - viewTop - margin - gap - safeTop;
      const desiredHeight = menu.firstElementChild.scrollHeight * scale;
      const openAbove = below < desiredHeight && above > below;
      const available = Math.max(44, openAbove ? above : below);
      menu.firstElementChild.style.maxHeight = `${available / scale}px`;
      const height = menu.offsetHeight * scale;
      const rtl = document.documentElement.dir === 'rtl';
      const left = Math.max(viewLeft + margin, Math.min(viewLeft + viewWidth - width - margin, rtl ? bounds.left : bounds.right - width));
      const top = Math.max(viewTop + margin + safeTop, Math.min(viewTop + viewHeight - height - margin - safeBottom, openAbove ? bounds.top - height - gap : bounds.bottom + gap));
      menu.style.left = `${left / scale}px`;
      menu.style.top = `${top / scale}px`;
      menu.dataset.side = openAbove ? 'above' : 'below';
      menu.dir = rtl ? 'rtl' : 'ltr';
    }

    function schedulePosition() {
      if (!menu || positionFrame !== null) return;
      positionFrame = requestAnimationFrame(() => { positionFrame = null; position(); });
    }

    function refresh() {
      if (!anchor || !menu) return;
      const next = findTrigger(anchor.dataset.appointmentId);
      if (!next || next.disabled || next.closest('.hidden, [hidden]')) return close();
      if (next !== anchor) {
        anchor.setAttribute('aria-expanded', 'false');
        anchor.removeAttribute('aria-controls');
        anchor = next;
        anchor.setAttribute('aria-expanded', 'true');
        anchor.setAttribute('aria-controls', menu.id);
      }
      menu.querySelectorAll('[role="option"]').forEach(option => option.setAttribute('aria-selected', String(option.dataset.status === anchor.dataset.status)));
      schedulePosition();
    }

    function open(button, first = false, last = false) {
      if (button.disabled || !canModify()) return;
      if (anchor === button) return close(true);
      close(false, false);
      anchor = button;
      menu = document.createElement('div');
      menu.className = 'lumin-status-menu';
      menu.id = `lumin-appointment-status-menu-${++menuSequence}`;
      menu.innerHTML = `<div class="lumin-status-menu-panel" role="listbox" aria-label="${escape(button.getAttribute('aria-label'))}">${statuses.map(status => `<button type="button" class="lumin-status-option" role="option" tabindex="-1" data-status="${escape(status)}" aria-selected="${status === button.dataset.status}"><span class="lumin-status-dot" aria-hidden="true"></span><span>${escape(getLabel(status))}</span><i data-lucide="check" class="lumin-status-check" aria-hidden="true"></i></button>`).join('')}</div>`;
      document.body.appendChild(menu);
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-controls', menu.id);
      if (window.lucide) lucide.createIcons();
      position();
      if (!menu) return;
      const options = Array.from(menu.querySelectorAll('[role="option"]'));
      const selected = options.find(option => option.dataset.status === button.dataset.status);
      const activeOption = first ? options[0] : last ? options.at(-1) : selected || options[0];
      activeOption.focus({ preventScroll: true });
      activeOption.scrollIntoView({ block: 'nearest' });
      search = '';
      if (!reducedMotion() && menu.firstElementChild.animate) {
        menu.firstElementChild.animate([{ opacity: 0, transform: `translateY(${menu.dataset.side === 'above' ? 7 : -7}px) scale(.96)` }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      observer = new MutationObserver(refresh);
      observer.observe(button.closest('#dashboard-appointments-list') || button.parentElement, { childList: true, subtree: true });
    }

    async function choose(status) {
      if (!anchor || !statuses.includes(status)) return;
      const button = anchor, id = button.dataset.appointmentId, previousStatus = button.dataset.status;
      close(true);
      if (status === previousStatus || pending.has(id) || !canModify()) return;
      pending.add(id);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      paint(button, status, true);
      let saved = false;
      try { saved = await onChange(id, status); }
      finally {
        pending.delete(id);
        const current = findTrigger(id);
        if (current) {
          paint(current, saved ? current.dataset.status : previousStatus, true);
          current.disabled = !canModify();
          current.removeAttribute('aria-busy');
          if (document.activeElement === document.body || document.activeElement === button) current.focus({ preventScroll: true });
        }
      }
    }

    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-appointment-status-trigger]');
      if (trigger) { open(trigger); return; }
      const option = event.target.closest('.lumin-status-menu [role="option"]');
      if (option && menu?.contains(option)) void choose(option.dataset.status);
    });
    document.addEventListener('pointerdown', event => {
      if (menu && !menu.contains(event.target) && !anchor.contains(event.target)) close();
    });
    document.addEventListener('focusin', event => {
      if (menu && !menu.contains(event.target) && event.target !== anchor) close();
    });
    document.addEventListener('keydown', event => {
      const trigger = event.target.closest('[data-appointment-status-trigger]');
      if (!menu) {
        if (trigger && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          open(trigger, event.key === 'Home', event.key === 'End');
        }
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); return; }
      if (event.key === 'Tab') { close(true, false); return; }
      const options = Array.from(menu.querySelectorAll('[role="option"]'));
      let index = options.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
        options[index].focus({ preventScroll: true });
        options[index].scrollIntoView({ block: 'nearest' });
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
        search = Date.now() - searchTime > 700 ? event.key : search + event.key;
        searchTime = Date.now();
        const match = options.find(option => option.textContent.trim().toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
        if (match) { event.preventDefault(); match.focus({ preventScroll: true }); match.scrollIntoView({ block: 'nearest' }); }
      }
    }, true);
    document.addEventListener('scroll', event => { if (menu && !menu.contains(event.target)) schedulePosition(); }, true);
    window.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    window.addEventListener('hashchange', () => close(false, false));
    return { markup, retainTrigger, close };
  };
})();
