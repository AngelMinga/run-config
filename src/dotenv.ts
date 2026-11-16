/**
 * `.env` files like the `dotenv` package (and IntelliJ's EnvFile): `KEY=value`, optional `export`, `#` comments,
 * single quotes (literal), double quotes (escapes `\n \r \t \" \\`, may span lines) and `${VAR}` / `$VAR` expansion
 * in unquoted and double-quoted values from earlier keys, then `env`. Pure.
 */
export function parseDotenv(text: string, env: NodeJS.ProcessEnv = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const expand = (v: string) => v.replace(/\\?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (m, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
      if (m.startsWith('\\')) { return m.slice(1); }
      const name = braced ?? bare!;
      const value = out[name] ?? env[name];
      return value === undefined || value === '' ? fallback ?? '' : value;
    });
  const src = text.replace(/\r\n?/g, '\n');
  const line = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[=:][ \t]*/gm;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = line.exec(src))) {
    // Ignore matches inside a value already consumed (multi-line quoted values).
    if (m.index < pos) { continue; }
    let i = m.index + m[0].length;
    const key = m[1];
    const q = src[i];
    let value: string;
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1;
      let raw = '';
      for (; j < src.length && src[j] !== q; j++) {
        if (src[j] === '\\' && q === '"' && j + 1 < src.length) { raw += src[j] + src[++j]; } else { raw += src[j]; }
      }
      value = q === '"'
        ? expand(raw.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? (c === '$' ? '\\$' : c)))
        : raw;
      i = j + 1;
      const eol = src.indexOf('\n', i);
      pos = eol < 0 ? src.length : eol;
    } else {
      const eol = src.indexOf('\n', i);
      const end = eol < 0 ? src.length : eol;
      // An unquoted value ends at ` #` (inline comment).
      value = expand(src.slice(i, end).replace(/\s+#.*$/, '').trim());
      pos = end;
    }
    out[key] = value;
    line.lastIndex = pos;
  }
  return out;
}

/** Env of a configuration: the env file's variables, overridden by the ones set in the configuration (IntelliJ order). */
export function mergeEnv(fileEnv: Record<string, string>, own: Record<string, string>): Record<string, string> {
  return { ...fileEnv, ...own };
}
