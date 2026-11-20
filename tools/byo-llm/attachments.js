/*
 * Reads files the author attaches as context for the LLM.
 * Text files are sent inline as text; images and PDFs are sent as base64.
 */

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXT_TYPES = ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'];
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml'];

export const ACCEPT = [
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
  '.pdf',
  ...IMAGE_TYPES,
].join(',');

/** @returns {'text'|'image'|'pdf'|null} how a file can be sent, or null if unsupported */
export function classify({ name = '', type = '' }) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (IMAGE_TYPES.includes(type)) return 'image';
  if (type.startsWith('text/') || TEXT_TYPES.includes(type) || TEXT_EXTENSIONS.includes(ext)) return 'text';
  return null;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/**
 * @returns {Promise<{name, size, kind, mediaType, text?, base64?, truncated?}>}
 * @throws {Error} with an author-facing message if the file cannot be used
 */
export async function readAttachment(file) {
  const kind = classify(file);
  if (!kind) {
    throw new Error(`${file.name}: unsupported file type. Attach text, Markdown, CSV, JSON, HTML, PDF or image files.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name}: larger than ${formatBytes(MAX_FILE_BYTES)}.`);
  }
  const attachment = { name: file.name, size: file.size, kind };
  if (kind === 'text') {
    const text = await file.text();
    attachment.truncated = text.length > MAX_TEXT_CHARS;
    attachment.text = text.slice(0, MAX_TEXT_CHARS);
    return attachment;
  }
  attachment.mediaType = kind === 'pdf' ? 'application/pdf' : file.type;
  attachment.base64 = await readAsBase64(file);
  return attachment;
}
