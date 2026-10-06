import { Pipe, type PipeTransform } from '@angular/core';
import { Marked } from 'marked';
import DOMPurify, { type Config } from 'dompurify';
import { MARKDOWN_MAX_CHARS } from '../../core/constants/ui.constants';

const markdown = new Marked({ gfm: true, breaks: false });

const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'style',
    'script',
    'img',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'svg',
    'math',
    'video',
    'audio',
  ],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
};

let linkHookInstalled = false;
function ensureLinkHook(): void {
  if (linkHookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  linkHookInstalled = true;
}

/**
 * AI-authored markdown → sanitized HTML string for `[innerHTML]` (marked + DOMPurify; Angular sanitizes again).
 * Pure: parses only when the source string changes.
 */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(source: string | null | undefined): string {
    if (!source?.trim()) return '';
    ensureLinkHook();
    const text = source.length > MARKDOWN_MAX_CHARS ? `${source.slice(0, MARKDOWN_MAX_CHARS)}\n\n…` : source;
    // marked ^18: the sync overload returns string.
    const html = markdown.parse(text, { async: false });
    return DOMPurify.sanitize(html, PURIFY_CONFIG);
  }
}
