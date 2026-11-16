/**
 * ANSI (SGR) → styled spans for the Run window. Spans carry plain text (the webview sets it with `textContent`, so
 * output can never inject HTML); colours become classes (`fg-1`, `bg-4`, `b`, `i`, `u`, `dim`) or `#rrggbb` for
 * 256/true colour, applied through CSSOM. Other escape sequences (cursor moves, line clears, OSC titles) are dropped.
 * The converter keeps the active style between chunks, since output arrives in arbitrary pieces.
 */

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Span {
  text: string;
  /** Space-separated classes, '' for plain text. */
  cls: string;
  /** `#rrggbb` for 256/true colour, which has no class. */
  fg?: string;
  bg?: string;
}

const ESC_SEQ = /\x1b(?:\[([0-9;?]*)([A-Za-z])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-B]|[=>78NOMDEHc])/g;

function xterm256(n: number): string | undefined {
  if (n < 16) { return undefined; }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return '#' + [v, v, v].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return '#' + [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map(x => level(x).toString(16).padStart(2, '0')).join('');
}

export class AnsiConverter {
  private style: Style = {};
  /** Escape sequence cut at the end of the previous chunk. */
  private pending = '';

  /** Converts a chunk into styled spans. */
  convert(chunk: string): Span[] {
    let text = this.pending + chunk;
    this.pending = '';
    // Keep an unfinished escape sequence for the next chunk.
    const lastEsc = text.lastIndexOf('\x1b');
    if (lastEsc >= 0 && lastEsc > text.length - 32) {
      const tail = text.slice(lastEsc);
      ESC_SEQ.lastIndex = 0;
      const m = ESC_SEQ.exec(tail);
      if (!m || m.index !== 0) {
        this.pending = tail;
        text = text.slice(0, lastEsc);
      }
    }
    const spans: Span[] = [];
    let last = 0;
    const push = (s: string) => {
      // Progress bars rewrite the line with `\r`: keep line breaks, drop lone carriage returns.
      const clean = s.replace(/\r(?!\n)/g, '').replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      if (clean) { spans.push(this.span(clean)); }
    };
    ESC_SEQ.lastIndex = 0;
    for (let m = ESC_SEQ.exec(text); m; m = ESC_SEQ.exec(text)) {
      push(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[2] === 'm') { this.apply(m[1] ?? ''); }
    }
    push(text.slice(last));
    return spans;
  }

  private span(text: string): Span {
    const s = this.style;
    let fg = s.fg;
    let bg = s.bg;
    if (s.inverse) { [fg, bg] = [bg ?? 'default-bg', fg ?? 'default-fg']; }
    const cls: string[] = [];
    const out: Span = { text, cls: '' };
    const color = (v: string | undefined, kind: 'fg' | 'bg') => {
      if (!v) { return; }
      if (v.startsWith('#')) { out[kind] = v; } else { cls.push(`${kind}-${v}`); }
    };
    color(fg, 'fg');
    color(bg, 'bg');
    if (s.bold) { cls.push('b'); }
    if (s.dim) { cls.push('dim'); }
    if (s.italic) { cls.push('i'); }
    if (s.underline) { cls.push('u'); }
    out.cls = cls.join(' ');
    return out;
  }

  private apply(params: string): void {
    const codes = params === '' ? [0] : params.split(';').map(p => parseInt(p, 10) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { this.style = {}; }
      else if (c === 1) { this.style.bold = true; }
      else if (c === 2) { this.style.dim = true; }
      else if (c === 3) { this.style.italic = true; }
      else if (c === 4) { this.style.underline = true; }
      else if (c === 7) { this.style.inverse = true; }
      else if (c === 22) { this.style.bold = false; this.style.dim = false; }
      else if (c === 23) { this.style.italic = false; }
      else if (c === 24) { this.style.underline = false; }
      else if (c === 27) { this.style.inverse = false; }
      else if (c >= 30 && c <= 37) { this.style.fg = String(c - 30); }
      else if (c >= 90 && c <= 97) { this.style.fg = String(c - 90 + 8); }
      else if (c >= 40 && c <= 47) { this.style.bg = String(c - 40); }
      else if (c >= 100 && c <= 107) { this.style.bg = String(c - 100 + 8); }
      else if (c === 39) { this.style.fg = undefined; }
      else if (c === 49) { this.style.bg = undefined; }
      else if (c === 38 || c === 48) {
        const key = c === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5) {
          const n = codes[i + 2] ?? 0;
          this.style[key] = n < 16 ? String(n) : xterm256(n);
          i += 2;
        } else if (codes[i + 1] === 2) {
          const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0];
          this.style[key] = '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
          i += 4;
        }
      }
    }
  }
}

/** Strips every escape sequence (for plain-text copies and tests). */
export function stripAnsi(text: string): string {
  return text.replace(ESC_SEQ, '');
}
