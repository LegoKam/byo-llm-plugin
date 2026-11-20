// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { PROVIDERS, generate, toSafeHtml } from './llm.js';
import {
  ACCEPT, MAX_FILES, formatBytes, readAttachment,
} from './attachments.js';
import { loadSettings, saveSettings } from './secrets.js';

const PRESETS = {
  'Improve writing': 'Improve the writing: make it clearer and more engaging, and keep the meaning.',
  Shorten: 'Make this shorter while keeping the key points.',
  Expand: 'Expand this with more detail.',
  Summarise: 'Summarise this in a short paragraph.',
  'Fix grammar': 'Fix spelling and grammar. Change nothing else.',
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([name, value]) => {
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, '');
    else if (value !== false && value != null) node.setAttribute(name, value);
  });
  node.append(...children.filter((child) => child != null));
  return node;
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control, hint);
}

function setStatus(node, message = '', type = 'info') {
  node.textContent = message;
  node.dataset.type = type;
  node.hidden = !message;
}

function htmlToText(html) {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
}

function isConfigured(settings) {
  const provider = PROVIDERS[settings.provider];
  if (!provider) return false;
  const hasEndpoint = !!(settings.endpoint || provider.endpoint);
  return hasEndpoint && !!(settings.model || !provider.modelRequired);
}

(async function init() {
  const sdk = await DA_SDK;
  const { context, actions } = sdk;
  const { org } = context;
  let { token } = sdk;
  // The host posts a fresh token when the session is renewed.
  window.addEventListener('message', (e) => {
    if (e.data?.token) token = e.data.token;
  });

  const state = {
    settings: {
      provider: '', endpoint: '', model: '', apiKey: '',
    },
    selection: '',
    attachments: [],
    result: '',
    resultSelection: '',
    controller: null,
    loadFailed: false,
  };

  /* ---------- Generate view ---------- */

  const notice = el('p', { class: 'notice', hidden: true });
  const selectionPreview = el('p', { class: 'selection-preview' });
  const prompt = el('textarea', {
    id: 'prompt',
    rows: '4',
    placeholder: 'e.g. Rewrite this for a younger audience',
  });
  const fileInput = el('input', {
    type: 'file', multiple: true, accept: ACCEPT, class: 'visually-hidden',
  });
  const fileList = el('ul', { class: 'file-list' });
  const generateBtn = el('button', { type: 'button', class: 'primary' }, 'Generate');
  const status = el('p', { class: 'status', role: 'status', hidden: true });
  const resultPreview = el('div', { class: 'result-preview' });
  const resultActions = el('div', { class: 'actions' });
  const resultSection = el('section', { class: 'result', hidden: true }, el('h2', {}, 'Result'), resultPreview, resultActions);

  function renderSelection() {
    const text = state.selection ? htmlToText(state.selection) : '';
    selectionPreview.textContent = text
      || 'Nothing selected. Select content in the page to work on it, or just describe what to create.';
    selectionPreview.classList.toggle('empty', !text);
  }

  async function refreshSelection() {
    try {
      state.selection = await actions.getSelection();
    } catch {
      state.selection = '';
    }
    renderSelection();
  }

  function renderFiles() {
    fileList.replaceChildren(...state.attachments.map((attachment) => el(
      'li',
      {},
      el('span', { class: 'file-name', title: attachment.name }, attachment.name),
      el('span', { class: 'file-size' }, attachment.truncated ? 'truncated' : formatBytes(attachment.size)),
      el('button', {
        type: 'button',
        class: 'quiet',
        'aria-label': `Remove ${attachment.name}`,
        onclick: () => {
          state.attachments = state.attachments.filter((a) => a !== attachment);
          renderFiles();
        },
      }, 'Remove'),
    )));
  }

  async function addFiles(files) {
    const room = MAX_FILES - state.attachments.length;
    const errors = files.length > room ? [`Only ${MAX_FILES} files can be attached.`] : [];
    const results = await Promise.allSettled(files.slice(0, Math.max(room, 0)).map(readAttachment));
    results.forEach((result) => {
      if (result.status === 'fulfilled') state.attachments.push(result.value);
      else errors.push(result.reason.message);
    });
    renderFiles();
    setStatus(status, errors.join(' '), 'error');
  }

  function send(html, message) {
    actions.sendHTML(html);
    setStatus(status, message, 'success');
  }

  function renderResult() {
    resultSection.hidden = !state.result;
    // state.result has been through toSafeHtml().
    resultPreview.innerHTML = state.result;
    const buttons = state.resultSelection
      ? [
        el('button', {
          type: 'button',
          class: 'primary',
          onclick: () => send(state.result, 'Replaced the current selection.'),
        }, 'Replace selection'),
        el('button', {
          type: 'button',
          onclick: () => send(`${state.resultSelection}${state.result}`, 'Inserted after the selection.'),
        }, 'Insert after selection'),
      ]
      : [
        el('button', {
          type: 'button',
          class: 'primary',
          onclick: () => send(state.result, 'Inserted at the cursor.'),
        }, 'Insert at cursor'),
      ];
    resultActions.replaceChildren(...buttons);
  }

  function renderConfigured() {
    const configured = isConfigured(state.settings);
    notice.hidden = configured || state.loadFailed;
    notice.textContent = configured ? '' : 'No LLM is configured for this organisation yet. Open Settings to add one.';
    generateBtn.disabled = !configured;
  }

  async function onGenerate() {
    if (state.controller) {
      state.controller.abort();
      return;
    }
    const instruction = prompt.value.trim();
    if (!instruction) {
      setStatus(status, 'Describe what the LLM should do.', 'error');
      prompt.focus();
      return;
    }
    await refreshSelection();
    const { selection } = state;
    state.controller = new AbortController();
    generateBtn.textContent = 'Stop';
    setStatus(status, `Generating with ${state.settings.model || PROVIDERS[state.settings.provider].label}…`);
    try {
      const raw = await generate(
        state.settings,
        { instruction, selection, attachments: state.attachments },
        { signal: state.controller.signal },
      );
      state.result = toSafeHtml(raw);
      state.resultSelection = selection;
      renderResult();
      setStatus(status);
      if (!state.result) setStatus(status, 'The LLM returned nothing that can be inserted.', 'error');
    } catch (error) {
      if (error.name === 'AbortError') setStatus(status, 'Stopped.');
      else setStatus(status, error.message, 'error');
    } finally {
      state.controller = null;
      generateBtn.textContent = 'Generate';
    }
  }

  generateBtn.addEventListener('click', onGenerate);
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  const presets = el('div', { class: 'chips' }, ...Object.entries(PRESETS).map(([label, text]) => el('button', {
    type: 'button',
    class: 'chip',
    onclick: () => {
      prompt.value = text;
      prompt.focus();
    },
  }, label)));

  const settingsView = el('main', { class: 'view', hidden: true });
  const generateView = el(
    'main',
    { class: 'view' },
    el(
      'header',
      {},
      el('h1', {}, 'BYO LLM'),
      el('button', {
        type: 'button',
        class: 'quiet',
        onclick: () => {
          generateView.hidden = true;
          settingsView.hidden = false;
        },
      }, 'Settings'),
    ),
    notice,
    el(
      'section',
      {},
      el(
        'div',
        { class: 'section-head' },
        el('h2', {}, 'Selection'),
        el('button', { type: 'button', class: 'quiet', onclick: refreshSelection }, 'Refresh'),
      ),
      selectionPreview,
    ),
    el(
      'section',
      {},
      el('label', { class: 'field-label', for: 'prompt' }, 'What should the LLM do?'),
      prompt,
      presets,
    ),
    el(
      'section',
      {},
      el('label', { class: 'attach' }, fileInput, el('span', { class: 'button' }, 'Attach files')),
      el('p', { class: 'hint' }, 'Text, Markdown, CSV, JSON, HTML, PDF or images, as context.'),
      fileList,
    ),
    generateBtn,
    status,
    resultSection,
  );

  /* ---------- Settings view ---------- */

  const providerSelect = el('select', {}, ...Object.entries(PROVIDERS).map(([value, { label }]) => el('option', { value }, label)));
  const endpointInput = el('input', { type: 'url', autocomplete: 'off', spellcheck: 'false' });
  const endpointHint = el('span', { class: 'hint' });
  const modelInput = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const keyInput = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const saveBtn = el('button', { type: 'submit', class: 'primary' }, 'Save');
  const testBtn = el('button', { type: 'button' }, 'Test connection');
  const settingsStatus = el('p', { class: 'status', role: 'status', hidden: true });

  function renderProvider() {
    const provider = PROVIDERS[providerSelect.value];
    endpointInput.placeholder = provider.endpoint || 'https://';
    endpointHint.textContent = provider.endpointHint;
    modelInput.placeholder = provider.modelRequired ? 'Model name, as your provider lists it' : 'Optional: the deployment sets the model';
  }

  function fillForm() {
    const { settings } = state;
    providerSelect.value = PROVIDERS[settings.provider] ? settings.provider : 'openai';
    endpointInput.value = settings.endpoint;
    modelInput.value = settings.model;
    keyInput.value = '';
    keyInput.placeholder = settings.apiKey ? 'Saved. Leave blank to keep it.' : 'Paste your API key';
    renderProvider();
  }

  /**
   * Settings as entered. A blank key keeps the saved one, unless the provider
   * or endpoint changed: a saved key is never sent to a different service.
   */
  function readForm() {
    const provider = providerSelect.value;
    const endpoint = endpointInput.value.trim();
    const entered = keyInput.value.trim();
    const sameTarget = provider === state.settings.provider && endpoint === state.settings.endpoint;
    const keptKey = sameTarget ? state.settings.apiKey : '';
    return {
      provider,
      endpoint,
      model: modelInput.value.trim(),
      apiKey: entered || keptKey,
      clearedKey: !entered && !sameTarget && !!state.settings.apiKey,
    };
  }

  function validate(settings) {
    if (!isConfigured(settings)) {
      const needs = PROVIDERS[settings.provider].modelRequired ? 'an endpoint and a model' : 'an endpoint';
      setStatus(settingsStatus, `Enter ${needs}.`, 'error');
      return false;
    }
    return true;
  }

  async function withBusy(button, label, task) {
    const original = button.textContent;
    saveBtn.disabled = true;
    testBtn.disabled = true;
    button.textContent = label;
    try {
      await task();
    } catch (error) {
      setStatus(settingsStatus, error.message, 'error');
    } finally {
      saveBtn.disabled = false;
      testBtn.disabled = false;
      button.textContent = original;
    }
  }

  function onSave(e) {
    e.preventDefault();
    const { clearedKey, ...settings } = readForm();
    if (!validate(settings)) return;
    withBusy(saveBtn, 'Saving…', async () => {
      state.settings = await saveSettings({ org, token, settings });
      state.loadFailed = false;
      fillForm();
      renderConfigured();
      const note = clearedKey ? ' The saved API key was removed because the endpoint changed; enter the key for the new endpoint.' : '';
      setStatus(settingsStatus, `Saved for everyone in ${org}.${note}`, clearedKey ? 'info' : 'success');
    });
  }

  function onTest() {
    const { clearedKey, ...settings } = readForm();
    if (!validate(settings)) return;
    withBusy(testBtn, 'Testing…', async () => {
      setStatus(settingsStatus, 'Sending a test prompt…');
      const reply = await generate(settings, { instruction: 'Reply with the single word: OK' });
      setStatus(settingsStatus, `Connected. The LLM replied: ${htmlToText(toSafeHtml(reply)).slice(0, 80)}`, 'success');
    });
  }

  providerSelect.addEventListener('change', renderProvider);
  testBtn.addEventListener('click', onTest);

  settingsView.append(
    el(
      'header',
      {},
      el('h1', {}, 'Settings'),
      el('button', {
        type: 'button',
        class: 'quiet',
        onclick: () => {
          settingsView.hidden = true;
          generateView.hidden = false;
        },
      }, 'Back'),
    ),
    el(
      'p',
      { class: 'hint' },
      `These settings apply to everyone in ${org}. They are stored in the "secrets" sheet of the organisation's da.live config, so anyone who can read that config can read the API key.`,
    ),
    el(
      'form',
      { onsubmit: onSave },
      field('Provider', providerSelect),
      field('Endpoint', endpointInput, endpointHint),
      field('Model', modelInput),
      field('API key', keyInput),
      el('div', { class: 'actions' }, saveBtn, testBtn),
      settingsStatus,
    ),
  );

  /* ---------- Start ---------- */

  document.body.append(generateView, settingsView);
  // Pick up the editor selection whenever the author moves into the panel.
  document.documentElement.addEventListener('pointerenter', refreshSelection);
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  renderSelection();
  refreshSelection();
  try {
    state.settings = await loadSettings({ org, token });
  } catch (error) {
    state.loadFailed = true;
    setStatus(status, error.message, 'error');
  }
  fillForm();
  renderConfigured();
}());
