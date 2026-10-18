import { Lexer } from 'marked';
import { escapeHtml, unescapeHtml, safeHref } from './escape.js';

const txt = (s) => escapeHtml(unescapeHtml(s));

/**
 * Render marked inline tokens to safe HTML. Raw HTML is escaped, comments dropped,
 * images reduced to alt text, links limited to http(s)/mailto/tel.
 * @param {object[]} tokens
 * @returns {string}
 */
export function inlineHtml(tokens = []) {
  return tokens.map((t) => {
    switch (t.type) {
      case 'text': return t.tokens ? inlineHtml(t.tokens) : txt(t.text);
      case 'escape': return txt(t.text);
      case 'strong': return `<strong>${inlineHtml(t.tokens)}</strong>`;
      case 'em': return `<em>${inlineHtml(t.tokens)}</em>`;
      case 'del': return `<del>${inlineHtml(t.tokens)}</del>`;
      case 'codespan': return `<code>${txt(t.text)}</code>`;
      case 'br': return '<br>';
      case 'image': return txt(t.text);
      case 'link': {
        const href = safeHref(t.href);
        const inner = inlineHtml(t.tokens);
        return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
      }
      case 'html': return /^<!--/.test(t.raw.trim()) ? '' : escapeHtml(t.raw);
      default: return t.tokens ? inlineHtml(t.tokens) : txt(t.text ?? t.raw ?? '');
    }
  }).join('');
}

/**
 * Plain text of inline tokens (entities decoded, markup removed).
 * @param {object[]} tokens
 */
export function inlineText(tokens = []) {
  return tokens.map((t) => {
    if (t.type === 'html') return /^<!--/.test(t.raw.trim()) ? '' : t.raw;
    if (t.type === 'br') return ' ';
    if (t.tokens) return inlineText(t.tokens);
    return unescapeHtml(t.text ?? '');
  }).join('');
}

/** Lex an inline markdown string into tokens. */
export const lexInline = (s) => Lexer.lexInline(String(s ?? ''));

/** Inline markdown string → safe HTML. */
export const mdInline = (s) => inlineHtml(lexInline(s));

/**
 * Render block tokens to safe HTML (fallback for structures the resume model doesn't know).
 * @param {object[]} tokens
 */
export function blockHtml(tokens = []) {
  return tokens.map((t) => {
    switch (t.type) {
      case 'space': return '';
      case 'paragraph': return `<p>${inlineHtml(t.tokens)}</p>`;
      case 'text': return `<p>${t.tokens ? inlineHtml(t.tokens) : txt(t.text)}</p>`;
      case 'heading': return `<h4>${inlineHtml(t.tokens)}</h4>`;
      case 'code': return `<pre><code>${escapeHtml(t.text)}</code></pre>`;
      case 'blockquote': return `<blockquote>${blockHtml(t.tokens)}</blockquote>`;
      case 'hr': return '<hr>';
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        return `<${tag}>${t.items.map((i) => `<li>${listItemHtml(i.tokens)}</li>`).join('')}</${tag}>`;
      }
      case 'table': {
        const row = (cells) => `<p>${cells.map((c) => inlineHtml(c.tokens)).join(' · ')}</p>`;
        return row(t.header) + t.rows.map(row).join('');
      }
      case 'html': return /^<!--/.test(t.raw.trim()) ? '' : `<p>${escapeHtml(t.raw.trim())}</p>`;
      default: return t.tokens ? blockHtml(t.tokens) : `<p>${txt(t.text ?? t.raw ?? '')}</p>`;
    }
  }).join('');
}

/** Render a list item's tokens: leading text inline, nested blocks as HTML. */
export function listItemHtml(tokens = []) {
  return tokens.map((t) => (t.type === 'text' ? (t.tokens ? inlineHtml(t.tokens) : txt(t.text)) : blockHtml([t]))).join('');
}
