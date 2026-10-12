// Shared by the website and desktop renderer. Browser constraints still block
// invalid submissions; only their locale-dependent popup is replaced.
export function englishValidationMessage(field) {
  const v = field.validity;
  if (v.badInput) return 'Enter a valid number.';
  if (v.valueMissing) {
    if (field.type === 'checkbox') return 'Select this checkbox to continue.';
    if (field.type === 'radio' || field.tagName === 'SELECT') return 'Choose an option.';
    if (field.type === 'file') return 'Choose a file.';
    return 'Please complete this field.';
  }
  if (v.typeMismatch) return field.type === 'email'
    ? 'Enter a valid email address, for example name@example.com.'
    : 'Enter a complete website address, for example https://example.com.';
  if (v.patternMismatch) return field.dataset.formatHint || 'Enter a value in the required format.';
  if (v.tooShort) return 'Enter at least ' + field.minLength + ' characters.';
  if (v.tooLong) return 'Enter no more than ' + field.maxLength + ' characters.';
  if (v.rangeUnderflow) return 'Enter a value of at least ' + field.min + '.';
  if (v.rangeOverflow) return 'Enter a value no greater than ' + field.max + '.';
  if (v.stepMismatch) return 'Enter a valid increment' + (field.step && field.step !== 'any' ? ' of ' + field.step : '') + '.';
  return 'Check this value and try again.';
}

export function installEnglishValidation(doc = document) {
  const errors = new Map();
  let sequence = 0, pendingFocus = null;
  function clear(field) {
    const entry = errors.get(field);
    if (!entry) return;
    entry.note.remove();
    for (const target of entry.targets) {
      const described = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== entry.note.id);
      if (described.length) target.setAttribute('aria-describedby', described.join(' '));
      else target.removeAttribute('aria-describedby');
      const previous = entry.invalid.get(target);
      if (previous === null) target.removeAttribute('aria-invalid');
      else target.setAttribute('aria-invalid', previous);
    }
    errors.delete(field);
  }
  doc.addEventListener('invalid', event => {
    const field = event.target;
    if (!field.validity) return;
    event.preventDefault();
    clear(field);
    const control = field.hidden && field.nextElementSibling?.classList.contains('wallet-select')
      ? field.nextElementSibling.querySelector('[role=combobox]') : field;
    const note = doc.createElement('span');
    note.className = 'field-validation-error';
    note.id = 'english-field-error-' + (++sequence);
    note.lang = 'en';
    note.setAttribute('role', 'alert');
    note.textContent = englishValidationMessage(field);
    const label = field.closest('label');
    if (label) label.append(note);
    else control.after(note);
    const targets = [...new Set([field, control])], invalid = new Map();
    for (const target of targets) {
      invalid.set(target, target.getAttribute('aria-invalid'));
      target.setAttribute('aria-invalid', 'true');
      target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), note.id].filter(Boolean).join(' '));
    }
    errors.set(field, {note, targets, invalid});
    if (!pendingFocus) {
      pendingFocus = control;
      setTimeout(() => { const target = pendingFocus; pendingFocus = null; if (target?.isConnected) target.focus(); }, 0);
    }
  }, true);
  for (const event of ['input', 'change']) doc.addEventListener(event, e => clear(e.target), true);
  doc.addEventListener('reset', e => { for (const field of errors.keys()) if (field.form === e.target) clear(field); }, true);
  // React route changes and rebuilt wallet panels must not retain detached fields.
  const observer = new MutationObserver(() => {
    for (const field of errors.keys()) if (!field.isConnected) clear(field);
  });
  observer.observe(doc.documentElement, {childList:true, subtree:true});
}
