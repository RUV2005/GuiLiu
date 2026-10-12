import { e } from './fields.js';

const providers = {
  llm: { value: 'qwen', name: 'Qwen', icon: '/assets/qwen.svg', label: 'llmService' },
  embedding: { value: 'openai', name: 'OpenAI', icon: '/assets/openai.svg', label: 'embeddingService' },
};

function modelLabel(kind, t, state = {}) {
  if (kind === 'embedding') return `text-embedding-3-small (${t('defaultModel')})`;
  const name = state.models?.chat;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 120)
    : t(state.modelsLoaded ? 'modelUnavailable' : 'modelLoading');
}

export function providerPickerMarkup(kind, t, state) {
  const provider = providers[kind];
  const id = `setup-${kind}-providers`;
  const icon = `<img src="${provider.icon}" width="24" height="24" alt="" aria-hidden="true">`;
  const model = modelLabel(kind, t, state);
  const label = `<span class="setup-provider-label"><strong>${e(provider.name)}</strong><span data-provider-model-name title="${e(model)}">${e(model)}</span></span>`;
  return `<div class="setup-field"><span id="${id}-label">${e(t(provider.label))}</span>
    <div class="setup-provider" data-setup-provider="${kind}">
      <input type="hidden" name="${kind}_provider" value="${provider.value}">
      <button type="button" class="setup-provider-toggle" data-provider-toggle aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}" aria-label="${e(t(provider.label) + ': ' + provider.name + ', ' + model)}">${icon}${label}<span class="setup-provider-chevron" aria-hidden="true"></span></button>
      <div class="setup-provider-menu" id="${id}" role="listbox" aria-labelledby="${id}-label" hidden>
        <button type="button" class="setup-provider-option" data-provider-option role="option" aria-selected="true" tabindex="-1">${icon}${label}</button>
      </div>
    </div></div>`;
}

export function updateProviderModels(root, t, state) {
  for (const picker of root.querySelectorAll('[data-setup-provider]')) {
    const kind = picker.dataset.setupProvider, provider = providers[kind];
    if (!provider) continue;
    const model = modelLabel(kind, t, state);
    for (const label of picker.querySelectorAll('[data-provider-model-name]')) {
      if (label.textContent !== model) label.textContent = model;
      label.title = model;
    }
    picker.querySelector('[data-provider-toggle]').setAttribute('aria-label', `${t(provider.label)}: ${provider.name}, ${model}`);
  }
}

export function mountProviderPickers(root, doc = root.ownerDocument) {
  function close(picker, focus = false) {
    picker.querySelector('[role="listbox"]').hidden = true;
    const trigger = picker.querySelector('[data-provider-toggle]');
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus({ preventScroll: true });
  }
  function closeAll(except) {
    for (const picker of root.querySelectorAll('[data-setup-provider]')) if (picker !== except) close(picker);
  }
  function open(picker) {
    closeAll(picker);
    picker.querySelector('[role="listbox"]').hidden = false;
    picker.querySelector('[data-provider-toggle]').setAttribute('aria-expanded', 'true');
    picker.querySelector('[data-provider-option]').focus({ preventScroll: true });
  }
  function click(event) {
    const picker = event.target.closest('[data-setup-provider]');
    if (!picker || event.target.closest('button')?.matches(':disabled')) return;
    if (event.target.closest('[data-provider-option]')) close(picker, true);
    else if (event.target.closest('[data-provider-toggle]')) {
      if (picker.querySelector('[role="listbox"]').hidden) open(picker); else close(picker);
    }
  }
  function keydown(event) {
    const picker = event.target.closest('[data-setup-provider]');
    if (!picker || event.target.matches(':disabled')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(picker, true); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); open(picker); }
  }
  function outside(event) { if (!root.contains(event.target) || !event.target.closest('[data-setup-provider]')) closeAll(); }
  function focusout(event) {
    const picker = event.target.closest('[data-setup-provider]');
    if (picker && !picker.contains(event.relatedTarget)) close(picker);
  }
  root.addEventListener('click', click); root.addEventListener('keydown', keydown); root.addEventListener('focusout', focusout);
  doc.addEventListener('pointerdown', outside);
  return { close: closeAll, dispose() {
    closeAll();
    root.removeEventListener('click', click); root.removeEventListener('keydown', keydown); root.removeEventListener('focusout', focusout);
    doc.removeEventListener('pointerdown', outside);
  } };
}
