/* One persistent surface travels behind the navigation icons. */
(function () {
  'use strict';
  const instances = new WeakMap();

  function create(container) {
    if (!container) return null;
    if (instances.has(container)) return instances.get(container);
    const element = document.createElement('span');
    element.className = 'lumin-nav-highlight';
    element.setAttribute('aria-hidden', 'true');
    element.hidden = true;
    container.prepend(element);
    container.classList.add('lumin-nav-motion');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, previous = null, animation = null;

    function refresh() {
      const target = container.querySelector(':scope > button[aria-current="page"]:not(.hidden)');
      if (!container.isConnected || !target?.getClientRects().length || !container.getClientRects().length) {
        animation?.cancel();
        animation = null;
        previous = null;
        element.hidden = true;
        return;
      }
      if (reducedMotion.matches && animation) { animation.cancel(); animation = null; }
      // Offsets are local CSS pixels, so app zoom and RTL need no special cases.
      const next = [target.offsetLeft, target.offsetTop, target.offsetWidth, target.offsetHeight, getComputedStyle(target).borderRadius];
      if (previous && next.every((value, index) => value === previous[index])) return;
      const from = getComputedStyle(element);
      const start = { transform: from.transform, width: from.width, height: from.height, borderRadius: from.borderRadius };
      animation?.cancel();
      animation = null;
      const finish = { transform: `translate3d(${next[0]}px, ${next[1]}px, 0)`, width: `${next[2]}px`, height: `${next[3]}px`, borderRadius: next[4] };
      Object.assign(element.style, finish);
      element.hidden = false;
      if (previous && !reducedMotion.matches && typeof element.animate === 'function') {
        const moving = element.animate([start, finish], { duration: 420, easing: 'cubic-bezier(.22, 1, .36, 1)' });
        animation = moving;
        moving.finished.then(() => {
          if (animation === moving) { animation = null; moving.cancel(); }
        }).catch(() => {});
      }
      previous = next;
    }

    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    }

    const observer = new MutationObserver(schedule);
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current', 'class', 'hidden'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir', 'class', 'style'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-ui-tint'] });
    const resize = new ResizeObserver(schedule);
    resize.observe(container);
    window.addEventListener('resize', schedule, { passive: true });
    reducedMotion.addEventListener('change', schedule);
    const instance = { element, refresh };
    instances.set(container, instance);
    refresh();
    return instance;
  }

  window.LuminNavHighlight = { create };
  document.addEventListener('DOMContentLoaded', () => create(document.getElementById('app-primary-nav')));
})();
