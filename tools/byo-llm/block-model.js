/*
 * Reads an EDS block from the live document or from a selection, and describes
 * its model: name, rows/cells, and which cells are text, assets, or both.
 */

const SKIP = new Set(['default-content-wrapper', 'metadata', 'section-metadata', 'library-metadata', 'block-marker']);
const META = new Set(['metadata', 'section metadata', 'section-metadata']);

function classNames(el) {
  return (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
}

function parseFragment(html) {
  const doc = new DOMParser().parseFromString(`<div id="byo-root">${html || ''}</div>`, 'text/html');
  return doc.getElementById('byo-root') || doc.body;
}

/** @returns {'text'|'asset'|'mixed'|'empty'} */
export function cellKind(html) {
  const root = parseFragment(html);
  const hasAsset = !!(root.querySelector('img, picture, a[data-edit-as="image"]'));
  const clone = root.cloneNode(true);
  clone.querySelectorAll('img, picture, source, a[data-edit-as="image"]').forEach((n) => n.remove());
  const hasText = !!clone.textContent.replace(/\s+/g, ' ').trim();
  if (hasAsset && hasText) return 'mixed';
  if (hasAsset) return 'asset';
  if (hasText) return 'text';
  return 'empty';
}

function textOf(html) {
  const root = parseFragment(html);
  root.querySelectorAll('img, picture, source, a[data-edit-as="image"]').forEach((n) => n.remove());
  return root.textContent.replace(/\s+/g, ' ').trim();
}

function assetsOf(html) {
  return [...parseFragment(html).querySelectorAll('img')].map((img) => ({
    alt: img.getAttribute('alt') || '',
    src: img.getAttribute('src') || '',
  }));
}

function parseName(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  const match = text.match(/^([^(]+?)(?:\s*\(([^)]*)\))?\s*$/);
  if (!match) return { name: text.toLowerCase(), variant: '' };
  return {
    name: match[1].trim().toLowerCase().replace(/[^0-9a-z]+/g, '-').replace(/^-|-$/g, ''),
    variant: (match[2] || '').trim(),
  };
}

function cellsFrom(el) {
  const rows = [];
  [...el.children].forEach((row, rowIndex) => {
    if (row.tagName !== 'DIV') return;
    const cols = [...row.children].filter((c) => c.tagName === 'DIV');
    const parts = cols.length ? cols : [row];
    parts.forEach((cell, colIndex) => {
      const html = cell.innerHTML.trim();
      const kind = cellKind(html);
      rows.push({
        row: rowIndex,
        col: colIndex,
        kind,
        html,
        text: textOf(html),
        assets: assetsOf(html),
      });
    });
  });
  return rows;
}

function summarise(block) {
  const textCount = block.cells.filter((c) => c.kind === 'text' || c.kind === 'mixed').length;
  const assetCount = block.cells.filter((c) => c.kind === 'asset' || c.kind === 'mixed').length;
  const assetTotal = block.cells.reduce((n, c) => n + c.assets.length, 0);
  return {
    ...block,
    textCount,
    assetCount,
    assetTotal,
    label: block.variant ? `${block.name} (${block.variant})` : block.name,
  };
}

function fromBlockDiv(el, blockIndex = null) {
  const classes = classNames(el);
  const name = classes[0];
  if (!name || SKIP.has(name)) return null;
  const variant = classes.slice(1).join(', ');
  const cells = cellsFrom(el);
  return summarise({
    name,
    variant,
    blockIndex,
    html: el.outerHTML,
    cells,
  });
}

/** Authoring tables use the first row as the block name. */
function fromTable(table) {
  const rows = [...table.querySelectorAll(':scope > tbody > tr, :scope > tr')];
  if (!rows.length) return null;
  const nameRow = rows[0];
  const { name, variant } = parseName(nameRow.textContent || '');
  if (!name || META.has(name)) return null;
  const cells = [];
  rows.slice(1).forEach((row, rowIndex) => {
    [...row.querySelectorAll(':scope > td, :scope > th')].forEach((cell, colIndex) => {
      const html = cell.innerHTML.trim();
      cells.push({
        row: rowIndex,
        col: colIndex,
        kind: cellKind(html),
        html,
        text: textOf(html),
        assets: assetsOf(html),
      });
    });
  });
  // Prefer the live-preview div shape when applying a replacement.
  const div = document.createElement('div');
  div.className = [name, ...variant.split(',').map((v) => v.trim()).filter(Boolean)].join(' ');
  rows.slice(1).forEach((row) => {
    const rowDiv = document.createElement('div');
    [...row.querySelectorAll(':scope > td, :scope > th')].forEach((cell) => {
      const col = document.createElement('div');
      col.innerHTML = cell.innerHTML;
      rowDiv.append(col);
    });
    div.append(rowDiv);
  });
  return summarise({
    name, variant, blockIndex: null, html: div.outerHTML, cells,
  });
}

/**
 * Find the EDS block at `blockIndex` in a live-document HTML snapshot.
 * Indices match the host's selection.blockIndex (document-wide, skipping
 * default content).
 */
export function blockAtIndex(liveHtml, blockIndex) {
  if (liveHtml == null || !Number.isInteger(blockIndex) || blockIndex < 0) return null;
  const doc = new DOMParser().parseFromString(liveHtml, 'text/html');
  const root = doc.querySelector('main') || doc.body;
  let index = 0;
  let found = null;
  [...root.children].filter((el) => el.tagName === 'DIV').forEach((section) => {
    [...section.children].forEach((el) => {
      if (found || el.tagName !== 'DIV') return;
      const name = classNames(el)[0];
      if (!name || SKIP.has(name)) return;
      if (index === blockIndex) found = fromBlockDiv(el, blockIndex);
      index += 1;
    });
  });
  return found;
}

/** Parse a selection HTML string (block div, table, or plain content). */
export function parseSelection(html) {
  if (!html?.trim()) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (table) return fromTable(table);
  const block = [...doc.body.children].find((el) => {
    const name = classNames(el)[0];
    return el.tagName === 'DIV' && name && !SKIP.has(name);
  });
  if (block) return fromBlockDiv(block);
  return null;
}

/**
 * Infer which parts of a block the instruction is asking to change.
 * @returns {'text'|'assets'|'both'}
 */
export function inferScope(instruction, block) {
  // Strip "alt text" so the word "text" inside it does not count as a copy cue.
  const raw = (instruction || '').toLowerCase();
  const text = raw.replace(/\balt\s+texts?\b/g, 'alt');
  const assetCue = /\b(alt|image|images|photo|photos|picture|pictures|asset|assets|background|media)\b/.test(text);
  const textCue = /\b(text|copy|headline|heading|title|rewrite|shorten|expand|summar|grammar|tone|voice|wording|paragraph)\b/.test(text);
  if (assetCue && textCue) return 'both';
  if (assetCue && block.assetTotal) return 'assets';
  if (textCue) return 'text';
  if (block.assetTotal && !block.textCount) return 'assets';
  if (block.textCount && !block.assetTotal) return 'text';
  return 'both';
}

/** Build the instruction addendum and the HTML the model should edit. */
export function buildBlockPrompt(block, scope, instruction) {
  const resolved = scope === 'auto' ? inferScope(instruction, block) : scope;
  const structure = block.cells.map((c) => {
    const bits = [`row ${c.row + 1}, col ${c.col + 1}: ${c.kind}`];
    if (c.text) bits.push(`text="${c.text.slice(0, 120)}"`);
    if (c.assets.length) {
      bits.push(`assets=[${c.assets.map((a) => `alt="${a.alt}"`).join('; ')}]`);
    }
    return `- ${bits.join(', ')}`;
  }).join('\n');

  const rules = {
    text: `Update ONLY the text in this "${block.label}" block.
Keep every <picture>, <img>, <source> and image URL exactly as given.
Keep the block class name and the same number of rows and columns.
Return the complete block as a single <div class="${block.name}">…</div>.`,
    assets: `Update ONLY the images in this "${block.label}" block (alt text, and remove an image only if asked).
Keep all other text exactly as given.
Keep the block class name, image URLs (unless removing), and the same number of rows and columns.
Return the complete block as a single <div class="${block.name}">…</div>.`,
    both: `Update this "${block.label}" block as asked. You may change text and image alt text.
Keep image URLs unless the instruction asks to remove an image.
Keep the block class name and the same number of rows and columns.
Return the complete block as a single <div class="${block.name}">…</div>.`,
  };

  return {
    scope: resolved,
    selection: block.html,
    instruction: `${instruction.trim()}

Block model (${block.label}):
${structure}

${rules[resolved]}`,
  };
}
