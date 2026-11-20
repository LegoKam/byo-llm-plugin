// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  ACCEPT, MAX_FILES, formatBytes, readAttachment,
} from './attachments.js';
import {
  blockAtIndex, parseSelection, inferScope, buildBlockPrompt,
} from './block-model.js';
import {
  PROVIDERS, generate, toSafeHtml, restoreAssets,
} from './llm.js';
import { loadSettings, saveSettings } from './secrets.js';

const PRESETS = {
  'Improve writing': 'Improve the writing: make it clearer and more engaging, and keep the meaning.',
  Shorten: 'Make this shorter while keeping the key points.',
  Expand: 'Expand this with more detail.',
  Summarise: 'Summarise this in a short paragraph.',
  'Fix grammar': 'Fix spelling and grammar. Change nothing else.',
  'Update alt text': 'Write clearer alt text for the images. Leave the copy unchanged.',
};

const SCOPES = [
  { id: 'auto', label: 'Auto' },
  { id: 'text', label: 'Text' },
  { id: 'assets', label: 'Assets' },
  { id: 'both', label: 'Both' },
];

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
    block: null,
    liveHtml: '',
    liveBlockIndex: null,
    scope: 'auto',
    attachments: [],
    result: '',
    resultMeta: null,
    controller: null,
    loadFailed: false,
  };

  /* ---------- Generate view ---------- */

  const notice = el('p', { class: 'notice', hidden: true });
  const selectionCard = el('div', { class: 'selection-card empty' });
  const scopeChips = el('div', { class: 'chips scope-chips', hidden: true });
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

  function resolveBlock() {
    const fromLive = blockAtIndex(state.liveHtml, state.liveBlockIndex);
    if (fromLive) return fromLive;
    return parseSelection(state.selection);
  }

  function renderScope() {
    const { block } = state;
    scopeChips.hidden = !block;
    if (!block) return;
    scopeChips.replaceChildren(...SCOPES.map(({ id, label }) => {
      const disabled = (id === 'text' && !block.textCount)
        || (id === 'assets' && !block.assetTotal);
      return el('button', {
        type: 'button',
        class: `chip${state.scope === id ? ' is-active' : ''}`,
        disabled,
        onclick: () => {
          state.scope = id;
          renderScope();
        },
      }, label);
    }));
  }

  function renderSelection() {
    state.block = resolveBlock();
    selectionCard.classList.toggle('empty', !state.block && !state.selection);
    if (state.block) {
      const { block } = state;
      const bits = [];
      if (block.textCount) bits.push(`${block.textCount} text`);
      if (block.assetTotal) bits.push(`${block.assetTotal} asset${block.assetTotal === 1 ? '' : 's'}`);
      const meta = el('div', { class: 'selection-meta' });
      meta.append(
        el('span', { class: 'block-name' }, block.label),
        el('span', { class: 'block-fields' }, bits.join(' · ') || 'empty'),
      );
      selectionCard.replaceChildren(meta);
    } else if (state.selection) {
      selectionCard.replaceChildren(
        el('p', { class: 'selection-preview' }, htmlToText(state.selection)),
      );
    } else {
      selectionCard.replaceChildren(el(
        'p',
        { class: 'selection-preview' },
        'Nothing selected. Select a block or text in the page, or just describe what to create.',
      ));
    }
    renderScope();
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

  async function applyResult(mode) {
    const { result, resultMeta } = state;
    if (!result) return;
    if (mode === 'replace-block' && resultMeta?.block) {
      const expected = resultMeta.liveHtml != null && Number.isInteger(resultMeta.blockIndex)
        ? { html: resultMeta.liveHtml, blockIndex: resultMeta.blockIndex }
        : undefined;
      const outcome = await actions.sendHTML(result, { replace: true, expected });
      if (outcome && outcome.ok === false) {
        setStatus(status, outcome.message || outcome.error || 'Could not replace the block.', 'error');
        return;
      }
      setStatus(status, `Updated the ${resultMeta.block.label} block (${resultMeta.scope}).`, 'success');
      return;
    }
    if (mode === 'replace-selection') {
      actions.sendHTML(result);
      setStatus(status, 'Replaced the current selection.', 'success');
      return;
    }
    if (mode === 'insert-after') {
      actions.sendHTML(`${resultMeta?.selectionHtml || ''}${result}`);
      setStatus(status, 'Inserted after the selection.', 'success');
      return;
    }
    actions.sendHTML(result);
    setStatus(status, 'Inserted at the cursor.', 'success');
  }

  function renderResult() {
    resultSection.hidden = !state.result;
    // state.result has been through toSafeHtml().
    resultPreview.innerHTML = state.result;
    const meta = state.resultMeta;
    let buttons;
    if (meta?.block) {
      buttons = [
        el('button', {
          type: 'button',
          class: 'primary',
          onclick: () => applyResult('replace-block'),
        }, `Replace ${meta.block.name} block`),
      ];
    } else if (meta?.selectionHtml) {
      buttons = [
        el('button', {
          type: 'button',
          class: 'primary',
          onclick: () => applyResult('replace-selection'),
        }, 'Replace selection'),
        el('button', {
          type: 'button',
          onclick: () => applyResult('insert-after'),
        }, 'Insert after selection'),
      ];
    } else {
      buttons = [
        el('button', {
          type: 'button',
          class: 'primary',
          onclick: () => applyResult('insert'),
        }, 'Insert at cursor'),
      ];
    }
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
    const {
      block, selection: selectionHtml, liveHtml, liveBlockIndex: blockIndex,
    } = state;
    let promptPayload = { instruction, selection: selectionHtml, attachments: state.attachments };
    let scope = null;
    if (block) {
      const built = buildBlockPrompt(block, state.scope, instruction);
      scope = built.scope;
      promptPayload = {
        instruction: built.instruction,
        selection: built.selection,
        attachments: state.attachments,
      };
    }
    state.controller = new AbortController();
    generateBtn.textContent = 'Stop';
    const modelLabel = state.settings.model || PROVIDERS[state.settings.provider].label;
    const scopeNote = block ? ` · ${scope} on ${block.name}` : '';
    setStatus(status, `Generating with ${modelLabel}${scopeNote}…`);
    try {
      const raw = await generate(
        state.settings,
        promptPayload,
        { signal: state.controller.signal },
      );
      let html = toSafeHtml(raw, { keepAssets: !!block });
      if (block && scope === 'text') html = restoreAssets(block.html, html);
      // Prefer a single outer block div when the model wrapped extras.
      if (block) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const match = [...doc.body.querySelectorAll('div')]
          .find((n) => n.classList.contains(block.name));
        if (match) html = match.outerHTML;
      }
      state.result = html;
      state.resultMeta = {
        block,
        scope: scope || (block ? inferScope(instruction, block) : null),
        selectionHtml,
        liveHtml,
        blockIndex,
      };
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
      selectionCard,
      scopeChips,
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
    // A blank endpoint means the provider's default, so compare what is actually called.
    const target = (value) => (value || PROVIDERS[provider].endpoint).replace(/\/+$/, '');
    const sameTarget = provider === state.settings.provider
      && target(endpoint) === target(state.settings.endpoint);
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

  if (sdk.capabilities?.liveDocument === 1 && typeof actions.subscribeLiveDocument === 'function') {
    actions.subscribeLiveDocument(({ html, selection }) => {
      state.liveHtml = html || '';
      state.liveBlockIndex = Number.isInteger(selection?.blockIndex) ? selection.blockIndex : null;
      renderSelection();
    });
  }

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
