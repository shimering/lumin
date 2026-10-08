// Use Lumin's shared specialty icon renderer, including saved legacy icon aliases.
const clinicalSpecialtyPicker = { open: false, signature: '', typeahead: '', typedAt: 0 };

function clinicalSpecialtyIconMarkup(specialty, lazy = false) {
  return specialtyIconMarkup(specialty?.iconName, null, 'compact', lazy);
}

function renderClinicalSpecialtyPicker(specialties = activeDentalSpecialties()) {
  const trigger = document.getElementById('chart-actions-specialty-trigger');
  const select = document.getElementById('chart-actions-specialty-filter');
  const menu = document.getElementById('chart-actions-specialty-menu');
  if (!trigger || !select || !menu) return;
  if (!specialties.some(item => item.id === clinicalActionsPanel.specialty)) clinicalActionsPanel.specialty = '';
  const all = clinicalActionsText('All specialties', 'كل التخصصات');
  const selected = specialties.find(item => item.id === clinicalActionsPanel.specialty);
  const label = clinicalActionsText('Filter procedures by specialty', 'تصفية الإجراءات حسب التخصص');
  trigger.setAttribute('aria-label', `${label}: ${selected?.name || all}`);
  trigger.title = selected?.name || all;
  trigger.innerHTML = `${clinicalSpecialtyIconMarkup(selected)}<span>${escapeHtml(selected?.name || all)}</span><i data-lucide="chevron-down" aria-hidden="true"></i>`;
  menu.dir = clinicalActionsText('ltr', 'rtl');
  menu.lang = clinicalActionsText('en', 'ar');
  menu.setAttribute('aria-label', label);
  const signature = JSON.stringify([specialties.map(item => [item.id, item.name, item.iconName]), clinicalActionsPanel.specialty, all]);
  if (signature !== clinicalSpecialtyPicker.signature) {
    clinicalSpecialtyPicker.signature = signature;
    const options = [{ id: '', name: all }, ...specialties];
    select.innerHTML = options.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    select.value = clinicalActionsPanel.specialty;
    menu.innerHTML = options.map(item => `<button type="button" role="option" tabindex="-1" class="chart-specialty-option" data-clinical-specialty="${escapeHtml(item.id)}" aria-selected="${item.id === clinicalActionsPanel.specialty}">
      ${clinicalSpecialtyIconMarkup(item, true)}<span>${escapeHtml(item.name)}</span><i data-lucide="check" aria-hidden="true"></i>
    </button>`).join('');
  }
  if (window.lucide) lucide.createIcons();
  if (clinicalSpecialtyPicker.open) positionClinicalSpecialtyPicker();
}

function closeClinicalSpecialtyPicker(restoreFocus = false) {
  clinicalSpecialtyPicker.open = false;
  clinicalSpecialtyPicker.typeahead = '';
  const menu = document.getElementById('chart-actions-specialty-menu');
  if (menu) menu.hidden = true;
  const trigger = document.getElementById('chart-actions-specialty-trigger');
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}

function positionClinicalSpecialtyPicker() {
  if (!clinicalSpecialtyPicker.open) return;
  const trigger = document.getElementById('chart-actions-specialty-trigger');
  const menu = document.getElementById('chart-actions-specialty-menu');
  const panel = document.getElementById('action-palette-card');
  const anchor = trigger.getBoundingClientRect();
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft || 0, viewportTop = viewport?.offsetTop || 0;
  const viewportWidth = viewport?.width || innerWidth, viewportBottom = viewportTop + (viewport?.height || innerHeight);
  const panelBox = panel.getBoundingClientRect();
  const top = clinicalActionsIsMobile() ? Math.max(viewportTop, panelBox.top) : viewportTop;
  const bottom = clinicalActionsIsMobile() ? Math.min(viewportBottom, panelBox.bottom) : viewportBottom;
  if (anchor.bottom <= top || anchor.top >= bottom || !trigger.getClientRects().length) { closeClinicalSpecialtyPicker(); return; }
  const width = Math.min(Math.max(anchor.width, 240 * zoom), viewportWidth - 24);
  const start = menu.dir === 'rtl' ? anchor.right - width : anchor.left;
  const left = Math.max(viewportLeft + 12, Math.min(start, viewportLeft + viewportWidth - width - 12));
  const below = bottom - anchor.bottom - 8, above = anchor.top - top - 8;
  const down = below >= Math.min(192 * zoom, menu.scrollHeight * zoom) || below >= above;
  const height = Math.max(44 * zoom, Math.min(336 * zoom, down ? below : above));
  menu.style.width = `${width / zoom}px`;
  menu.style.maxHeight = `${height / zoom}px`;
  menu.style.left = `${left / zoom}px`;
  menu.style.top = `${(down ? anchor.bottom + 4 : anchor.top - Math.min(height, menu.scrollHeight * zoom) - 4) / zoom}px`;
}

function toggleClinicalSpecialtyPicker() {
  if (clinicalSpecialtyPicker.open) { closeClinicalSpecialtyPicker(true); return; }
  renderClinicalSpecialtyPicker();
  const menu = document.getElementById('chart-actions-specialty-menu');
  if (!menu) return;
  clinicalSpecialtyPicker.open = true;
  menu.hidden = false;
  document.getElementById('chart-actions-specialty-trigger').setAttribute('aria-expanded', 'true');
  positionClinicalSpecialtyPicker();
  menu.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
}

document.addEventListener('DOMContentLoaded', () => {
  const menu = document.getElementById('chart-actions-specialty-menu');
  const trigger = document.getElementById('chart-actions-specialty-trigger');
  if (!menu || !trigger || menu.dataset.ready) return;
  menu.dataset.ready = 'true';
  // A portal keeps the menu clear of the sheet's scroll and clipping containers.
  document.body.appendChild(menu);
  trigger.addEventListener('click', toggleClinicalSpecialtyPicker);
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!clinicalSpecialtyPicker.open) toggleClinicalSpecialtyPicker();
    const options = [...menu.querySelectorAll('[role="option"]')];
    (event.key === 'End' || event.key === 'ArrowUp' ? options.at(-1) : options[0])?.focus({ preventScroll: true });
  });
  menu.addEventListener('click', event => {
    const option = event.target.closest('[data-clinical-specialty]');
    if (!option) return;
    event.stopPropagation();
    filterClinicalActionsSpecialty(option.dataset.clinicalSpecialty);
    closeClinicalSpecialtyPicker(true);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      closeClinicalSpecialtyPicker(true);
      return;
    }
    const options = [...menu.querySelectorAll('[role="option"]')], index = options.indexOf(document.activeElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      const now = Date.now();
      clinicalSpecialtyPicker.typeahead = (now - clinicalSpecialtyPicker.typedAt < 700 ? clinicalSpecialtyPicker.typeahead : '') + event.key.toLocaleLowerCase();
      clinicalSpecialtyPicker.typedAt = now;
      next = options.findIndex(option => option.textContent.trim().toLocaleLowerCase().startsWith(clinicalSpecialtyPicker.typeahead));
    }
    if (next >= 0) { event.preventDefault(); options[next].focus(); }
  });
});

document.addEventListener('click', event => {
  if (clinicalSpecialtyPicker.open && !event.target.closest('#chart-actions-specialty-menu, #chart-actions-specialty-trigger')) closeClinicalSpecialtyPicker();
}, true);
window.addEventListener('resize', positionClinicalSpecialtyPicker, { passive: true });
window.visualViewport?.addEventListener('resize', positionClinicalSpecialtyPicker, { passive: true });
document.addEventListener('scroll', event => {
  if (!document.getElementById('chart-actions-specialty-menu')?.contains(event.target)) positionClinicalSpecialtyPicker();
}, { capture: true, passive: true });
