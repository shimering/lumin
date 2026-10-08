/* A phone-only dock, independent of page containers and the tablet/desktop rail. */
(function () {
  'use strict';
  const destinations = [
    ['dashboard', 'layout-dashboard', 'Home', 'الرئيسية', 'Dashboard'],
    ['patients', 'users', 'Patients', 'المرضى', 'Patients'],
    ['appointments', 'calendar-days', 'Bookings', 'المواعيد', 'Appointments'],
    ['whatsapp', 'message-circle', 'Chats', 'المحادثات', 'WhatsApp'],
    ['clinic-management', 'building-2', 'Clinic Management', 'إدارة العيادة'],
    ['prices', 'badge-dollar-sign', 'Prices', 'الأسعار'],
    ['admin', 'shield-check', 'Admin', 'الإدارة'],
    ['settings', 'settings', 'My Settings', 'إعداداتي']
  ];

  function isPhone() {
    const ua = navigator.userAgent || '';
    const ipad = /iPad/i.test(ua) || (/Macintosh|MacIntel/i.test(ua + ' ' + navigator.platform) && navigator.maxTouchPoints > 1);
    if (ipad || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return false;
    return window.matchMedia('(max-width: 767px)').matches
      || (window.matchMedia('(max-width: 1023px)').matches && /iPhone|iPod|Android.*Mobile/i.test(ua));
  }

  function create(options) {
    const root = document.documentElement;
    const dock = document.createElement('nav');
    dock.id = 'lumin-mobile-nav';
    dock.hidden = true;
    dock.innerHTML = '<div class="lumin-mobile-nav-bar"></div><div id="lumin-mobile-nav-more" class="lumin-mobile-nav-menu" hidden></div>';
    document.body.appendChild(dock);
    const bar = dock.firstElementChild;
    const menu = dock.lastElementChild;
    const highlight = window.LuminNavHighlight?.create(bar);
    menu.setAttribute('role', 'group');
    let frame = 0, snapshot = '', geometry = '', menuOpen = false, activeView = '';
    let keyboardBaselineWidth = innerWidth, keyboardBaselineHeight = innerHeight;

    function closeMenu(returnFocus = false) {
      menuOpen = false;
      menu.hidden = true;
      const trigger = bar.querySelector('[data-more]');
      trigger?.setAttribute('aria-expanded', 'false');
      if (returnFocus) trigger?.focus({ preventScroll: true });
    }

    function button(item, ar, active, inMenu = false) {
      const el = document.createElement('button');
      el.type = 'button';
      el.dataset.view = item[0];
      el.id = 'mobile-nav-' + item[0];
      el.className = inMenu ? 'lumin-mobile-nav-menu-item' : 'lumin-mobile-nav-button';
      el.setAttribute('aria-label', ar ? item[3] : (item[4] || item[2]));
      if (active) el.setAttribute('aria-current', 'page');
      el.innerHTML = '<i data-lucide="' + item[1] + '" aria-hidden="true"></i><span></span>';
      el.lastElementChild.textContent = ar ? item[3] : item[2];
      return el;
    }

    function render() {
      const ar = options.getLanguage() === 'ar' || root.dir === 'rtl';
      const permitted = destinations.filter(item => {
        const source = options.source.querySelector('#nav-btn-' + item[0]);
        return source && !source.classList.contains('hidden');
      });
      const active = options.source.querySelector('[aria-current="page"]')?.id.replace('nav-btn-', '') || '';
      if (activeView !== active) { closeMenu(); activeView = active; }
      const sourceBadge = options.source.querySelector('#nav-whatsapp-unread-badge');
      const unread = sourceBadge && !sourceBadge.classList.contains('hidden') ? sourceBadge.textContent.trim() : '';
      const quickSource = options.source.querySelector('#nav-btn-quick-create');
      const quick = !!quickSource && !quickSource.classList.contains('hidden');
      const expanded = quickSource?.getAttribute('aria-expanded') === 'true';
      const next = JSON.stringify([ar, permitted.map(item => item[0]), active, unread, quick, expanded]);
      if (snapshot === next) return;
      snapshot = next;
      const focused = dock.contains(document.activeElement) ? document.activeElement.id : '';
      bar.replaceChildren(...(highlight ? [highlight.element] : []));
      menu.replaceChildren();
      dock.dir = ar ? 'rtl' : 'ltr';
      dock.setAttribute('aria-label', ar ? 'التنقل الرئيسي' : 'Main navigation');
      menu.setAttribute('aria-label', ar ? 'المزيد من الصفحات' : 'More pages');
      for (const item of permitted) {
        const inMenu = destinations.indexOf(item) >= 4;
        const el = button(item, ar, active === item[0], inMenu);
        if (item[0] === 'whatsapp' && unread) {
          const badge = document.createElement('span');
          badge.className = 'lumin-mobile-nav-badge';
          badge.textContent = unread;
          el.appendChild(badge);
          el.setAttribute('aria-label', (ar ? 'واتساب، غير مقروءة: ' : 'WhatsApp, unread: ') + unread);
        }
        (inMenu ? menu : bar).appendChild(el);
      }
      if (menu.childElementCount) {
        const more = button(['more', 'ellipsis', 'More', 'المزيد'], ar, permitted.some(item => destinations.indexOf(item) >= 4 && item[0] === active));
        delete more.dataset.view;
        more.dataset.more = '';
        more.setAttribute('aria-controls', menu.id);
        more.setAttribute('aria-expanded', String(menuOpen));
        bar.appendChild(more);
      } else closeMenu();
      if (quick) {
        const add = button(['new', 'plus', 'New', 'جديد', 'Quick actions'], ar, false);
        delete add.dataset.view;
        add.dataset.quick = '';
        add.classList.add('lumin-mobile-nav-create');
        add.setAttribute('aria-haspopup', 'menu');
        add.setAttribute('aria-expanded', String(expanded));
        bar.appendChild(add);
      }
      if (window.lucide) window.lucide.createIcons();
      if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
    }

    function measure() {
      const phone = isPhone();
      root.classList.toggle('lumin-phone-nav', phone);
      const zoom = Number.parseFloat(getComputedStyle(root).zoom) || 1;
      const viewport = window.visualViewport;
      const width = viewport?.width > 0 ? viewport.width : innerWidth;
      const height = viewport?.height > 0 ? viewport.height : innerHeight;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const focused = document.activeElement;
      const typing = focused?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]');
      if (Math.abs(innerWidth - keyboardBaselineWidth) > 80) {
        keyboardBaselineWidth = innerWidth;
        keyboardBaselineHeight = innerHeight;
      }
      if (!typing) keyboardBaselineHeight = Math.max(innerHeight, height);
      // Some Android browsers shrink innerHeight along with visualViewport on keyboard entry.
      const keyboard = phone && (document.body.classList.contains('whatsapp-keyboard-open') || (typing && Math.max(innerHeight, keyboardBaselineHeight) - height > 140));
      document.body.classList.toggle('lumin-mobile-keyboard-open', !!keyboard);
      dock.hidden = !phone || options.shell.classList.contains('hidden') || !!keyboard;
      if (dock.hidden) {
        closeMenu();
        if (geometry !== 'hidden') { geometry = 'hidden'; options.onLayout(); }
        return;
      }
      dock.style.setProperty('--lumin-mobile-nav-scale', String(zoom));
      render();
      const style = getComputedStyle(dock);
      const bottomGap = Math.max(12, Number.parseFloat(style.getPropertyValue('--nav-safe-bottom')) || 0);
      const sideGap = Math.max(12, Number.parseFloat(style.getPropertyValue('--nav-safe-left')) || 0, Number.parseFloat(style.getPropertyValue('--nav-safe-right')) || 0);
      const dockWidth = Math.min(480, width - sideGap * 2);
      dock.style.width = dockWidth / zoom + 'px';
      highlight?.refresh();
      const dockHeight = bar.getBoundingClientRect().height;
      // Explicit visible-viewport coordinates avoid standalone browser bottom/height races.
      const dockTop = Math.max(top, top + height - bottomGap - dockHeight);
      dock.style.left = (left + width / 2) / zoom + 'px';
      dock.style.top = dockTop / zoom + 'px';
      dock.style.setProperty('--nav-menu-height', Math.max(44, dockTop - top - 20) / zoom + 'px');
      const next = [dockTop, dockHeight, dockWidth, zoom].join(':');
      if (geometry !== next) { geometry = next; options.onLayout(); }
    }

    function refresh() {
      // Route entry gets an immediate measurement and a settling pass after paint.
      measure();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        measure();
        frame = requestAnimationFrame(() => { frame = 0; measure(); });
      });
    }

    dock.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.hasAttribute('data-more')) {
        options.closeQuickCreate();
        menuOpen = !menuOpen;
        menu.hidden = !menuOpen;
        target.setAttribute('aria-expanded', String(menuOpen));
        if (menuOpen) menu.querySelector('button')?.focus({ preventScroll: true });
      } else if (target.hasAttribute('data-quick')) {
        closeMenu();
        options.onQuickCreate(target);
        refresh();
      } else if (target.dataset.view) {
        closeMenu(menu.contains(target));
        // Preserve the application's permission checks and special appointment routing.
        options.source.querySelector('#nav-btn-' + target.dataset.view)?.click();
        refresh();
      }
    });
    document.addEventListener('pointerdown', event => { if (!dock.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && menuOpen) { event.preventDefault(); closeMenu(true); } });
    const observer = new MutationObserver(refresh);
    observer.observe(options.source, { attributes: true, attributeFilter: ['class', 'aria-current', 'aria-expanded'], childList: true, characterData: true, subtree: true });
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'dir', 'lang'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    observer.observe(options.shell, { attributes: true, attributeFilter: ['class'] });
    for (const event of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(event, refresh, { passive: true });
    window.visualViewport?.addEventListener('resize', refresh, { passive: true });
    window.visualViewport?.addEventListener('scroll', refresh, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    document.addEventListener('focusin', refresh);
    document.addEventListener('focusout', refresh);
    refresh();
    return { refresh, closeMenu };
  }
  window.LuminMobileNav = { create, isPhone };
})();
