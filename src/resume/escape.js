const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Escape text for safe inclusion in HTML text or attribute values. */
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Undo the entity escaping `marked` applies to text tokens (so we can re-escape exactly once). */
export const unescapeHtml = (s) => String(s ?? '').replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => UNESC[e]);

/** Allow only http(s), mailto and tel links; anything else becomes null. */
export function safeHref(href) {
  const h = String(href ?? '').trim();
  return /^(https?:|mailto:|tel:)/i.test(h) ? h : null;
}

/** Strip every HTML comment from a string. */
export const stripComments = (s) => String(s ?? '').replace(/<!--[\s\S]*?-->/g, '');
