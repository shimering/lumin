/* One display format; ISO values remain unchanged for storage and date arithmetic. */
(function (host) {
  'use strict';
  const pad = value => String(value).padStart(2, '0');
  function validDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match || Number(match[1]) < 1) return false;
    const date = new Date(0);
    date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]);
  }
  function format(value, options = {}) {
    if (value == null || value === '') return '';
    if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value)) return format(parseInput(value), options);
    // A date without a time describes a calendar day, regardless of time zone.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return validDay(value) ? value.split('-').reverse().join('/') : '';
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    if (!options.timeZone) return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).padStart(4, '0')}`;
    const parts = new Intl.DateTimeFormat('en-GB', {
      calendar: 'gregory', numberingSystem: 'latn', day: '2-digit', month: '2-digit', year: 'numeric',
      ...(options.timeZone ? { timeZone: options.timeZone } : {})
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type).value;
    return `${part('day')}/${part('month')}/${part('year').padStart(4, '0')}`;
  }
  function formatDateTime(value, options = {}) {
    const label = format(value, options);
    if (!label) return '';
    const time = new Intl.DateTimeFormat(options.locale || 'en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: options.hour12 ?? false,
      ...(options.timeZone ? { timeZone: options.timeZone } : {})
    }).format(new Date(value));
    return `${label} · ${time}`;
  }
  function parseInput(value, withTime = false) {
    const digits = String(value || '').trim().replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) % 16));
    const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/.exec(digits);
    if (!match || withTime !== Boolean(match[4])) return '';
    const day = `${match[3]}-${match[2]}-${match[1]}`;
    if (!validDay(day) || withTime && (Number(match[4]) > 23 || Number(match[5]) > 59)) return '';
    return withTime ? `${day}T${match[4]}:${match[5]}` : day;
  }
  const fields = new WeakMap();
  function enhanceInputs(root = document) {
    const inputs = [...(root.matches?.('input[type="date"], input[type="datetime-local"]') ? [root] : []),
      ...root.querySelectorAll('input[type="date"], input[type="datetime-local"]')];
    let added = false;
    inputs.forEach(input => {
      if (fields.has(input)) return;
      added = true;
      const withTime = input.type === 'datetime-local';
      const wrapper = document.createElement('span');
      wrapper.className = 'lumin-date-field';
      const text = document.createElement('input');
      text.type = 'text';
      text.autocomplete = 'off';
      text.spellcheck = false;
      text.dir = 'ltr';
      text.dataset.luminDateText = '';
      text.placeholder = withTime ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lumin-date-picker';
      button.innerHTML = '<i data-lucide="calendar-days" aria-hidden="true"></i>';
      input.before(wrapper);
      wrapper.append(input, text, button);
      input.classList.add('lumin-date-native');
      input.tabIndex = -1;
      input.setAttribute('aria-hidden', 'true');
      let editing = false, picking = false;
      const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      const arabic = () => document.documentElement.lang === 'ar' || document.documentElement.dir === 'rtl';
      const displayValue = () => {
        const value = nativeValue.get.call(input);
        return value ? format(value.slice(0, 10)) + (withTime ? ` ${value.slice(11, 16)}` : '') : '';
      };
      function validate() {
        const raw = text.value.trim();
        const invalid = raw && !parseInput(raw, withTime);
        let message = input.validationMessage;
        if (input.validity.rangeUnderflow) message = arabic() ? `اختر تاريخاً في ${format(input.min.slice(0, 10))} أو بعده` : `Choose a date on or after ${format(input.min.slice(0, 10))}`;
        if (input.validity.rangeOverflow) message = arabic() ? `اختر تاريخاً في ${format(input.max.slice(0, 10))} أو قبله` : `Choose a date on or before ${format(input.max.slice(0, 10))}`;
        text.setCustomValidity(invalid
          ? (arabic() ? `أدخل تاريخاً صحيحاً بصيغة ${text.placeholder}` : `Enter a valid date in ${text.placeholder} format`)
          : message);
      }
      function sync() {
        if (!editing) text.value = displayValue();
        text.className = [...input.classList].filter(name => !['lumin-date-native', 'hidden'].includes(name)).join(' ') + ' lumin-date-text';
        text.disabled = input.disabled;
        text.readOnly = input.readOnly;
        text.required = input.required;
        wrapper.hidden = input.hidden || input.classList.contains('hidden');
        button.disabled = input.disabled || input.readOnly;
        button.setAttribute('aria-label', arabic() ? 'فتح التقويم' : 'Open calendar');
        const label = input.getAttribute('aria-label') || [...input.labels].map(item => item.textContent.trim()).join(' ') || (arabic() ? 'التاريخ' : 'Date');
        text.setAttribute('aria-label', `${label} (${text.placeholder})`);
        for (const attribute of ['aria-labelledby', 'aria-describedby']) {
          if (input.hasAttribute(attribute)) text.setAttribute(attribute, input.getAttribute(attribute));
        }
        validate();
      }
      // Keep existing callers' ISO reads/writes and native constraints intact.
      Object.defineProperty(input, 'value', {
        configurable: true, get() { return nativeValue.get.call(this); },
        set(value) { nativeValue.set.call(this, value); sync(); }
      });
      fields.set(input, { sync });
      text.addEventListener('input', () => {
        editing = true;
        nativeValue.set.call(input, parseInput(text.value, withTime));
        validate();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        editing = false;
      });
      text.addEventListener('change', () => {
        editing = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        editing = false;
        if (parseInput(text.value, withTime)) sync();
      });
      input.addEventListener('input', () => { if (!editing) sync(); });
      input.addEventListener('change', () => { if (!editing) sync(); });
      input.addEventListener('focus', () => { if (!picking) text.focus(); });
      input.addEventListener('invalid', event => { event.preventDefault(); text.focus(); text.reportValidity(); });
      button.addEventListener('click', () => {
        if (button.disabled) return;
        picking = true;
        try {
          if (typeof input.showPicker === 'function') input.showPicker();
          else { input.focus(); input.click(); }
        } catch (_) {
          input.focus(); input.click();
        } finally { picking = false; }
      });
      new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['value', 'class', 'hidden', 'disabled', 'readonly', 'required', 'min', 'max', 'step', 'aria-label', 'aria-labelledby', 'aria-describedby'] });
      sync();
    });
    if (added && host.lucide) host.lucide.createIcons();
  }
  host.LuminDates = Object.freeze({ format, formatDateTime, parseInput, enhanceInputs, formatter: options => ({ format: value => format(value, options) }) });
  if (typeof module !== 'undefined' && module.exports) module.exports = host.LuminDates;
  if (typeof document !== 'undefined') {
    const ready = () => {
      enhanceInputs();
      document.addEventListener('reset', event => setTimeout(() => {
        event.target.querySelectorAll('.lumin-date-native').forEach(input => fields.get(input)?.sync());
      }, 0));
      new MutationObserver(() => {
        document.querySelectorAll('.lumin-date-native').forEach(input => fields.get(input)?.sync());
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'dir'] });
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType === 1) enhanceInputs(node);
        }
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
  }
})(typeof window === 'undefined' ? globalThis : window);
