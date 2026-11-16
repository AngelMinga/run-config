// Run window (webview view): one tab per run with its output. Plain DOM; output is set with textContent only.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const S = { runs: [], active: null, strings: {}, follow: true, wrap: saved.wrap !== false };
  const t = (key, ...args) => (S.strings[key] || key).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) { continue; }
      if (k === 'class') { el.className = v; }
      else if (k.startsWith('on')) { el.addEventListener(k.slice(2), v); }
      else if (k === 'disabled') { el.disabled = !!v; }
      else { el.setAttribute(k, v === true ? '' : v); }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) { continue; }
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ICONS = {
    rerun: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5"/>',
    debug: '<path d="M5.5 6.5a2.5 2.5 0 0 1 5 0v4a2.5 2.5 0 0 1-5 0zM8 6.5v6M3 8.5h2.5M10.5 8.5H13M3.5 5l2 1.5M12.5 5l-2 1.5"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/>',
    clear: '<path d="M3 13 13 3M5 3h8v8"/>',
    end: '<path d="M8 2.5v10M4 9l4 4 4-4M3 14h10"/>',
    wrap: '<path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m1.5-1.5L8 12l1.5 1.5M2.5 12H5"/>',
    hot: '<path d="M9 1.5 4 9h4l-1 5.5L12 7H8z" fill="currentColor" stroke="none"/>',
    restart: '<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5"/><path d="M7 6v4l3-2z" fill="currentColor"/>',
    terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4 6 2.5 2L4 10M8 10.5h4"/>',
    close: '<path d="m4.5 4.5 7 7m0-7-7 7"/>',
  };
  function icon(name) {
    const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
    span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  const app = document.getElementById('app');
  let tabsEl, toolbarEl, outEl, inputEl, emptyEl;

  function layout() {
    app.textContent = '';
    tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    toolbarEl = h('div', { class: 'toolbar', role: 'toolbar' });
    outEl = h('pre', { class: 'out' + (S.wrap ? ' wrap' : ''), tabindex: '0', role: 'log', 'aria-live': 'polite' });
    inputEl = h('input', {
      class: 'stdin', type: 'text', spellcheck: 'false', placeholder: t('Type input for the process and press Enter'),
      onkeydown: e => {
        if (e.key === 'Enter' && !e.isComposing && S.active) {
          vscode.postMessage({ type: 'stdin', id: S.active, text: inputEl.value });
          inputEl.value = '';
        }
      },
    });
    emptyEl = h('div', { class: 'empty' }, t('Nothing has run yet. Run a configuration with ⌃R, the ▷ button or the Services view.'));
    outEl.addEventListener('scroll', () => {
      // Scrolling up pauses following the output (IntelliJ's "Scroll to the end" toggle).
      const atEnd = outEl.scrollTop + outEl.clientHeight >= outEl.scrollHeight - 4;
      if (atEnd !== S.follow) { S.follow = atEnd; renderToolbar(); }
    });
    app.append(tabsEl, h('div', { class: 'body' }, toolbarEl, h('div', { class: 'console' }, emptyEl, outEl, inputEl)));
  }

  const activeRun = () => S.runs.find(r => r.id === S.active);

  function renderTabs() {
    tabsEl.textContent = '';
    for (const r of S.runs) {
      const status = r.running ? 'running' : r.exitCode && r.exitCode !== 0 ? 'failed' : 'done';
      tabsEl.append(h('div', {
        class: 'tab' + (r.id === S.active ? ' active' : ''),
        role: 'tab', tabindex: '0', 'aria-selected': String(r.id === S.active),
        title: r.running ? t('Running') : r.exitCode !== undefined ? t('Exit code {0}', r.exitCode) : t('Finished'),
        onclick: () => activate(r.id),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { activate(r.id); } },
        onauxclick: e => { if (e.button === 1 && !r.running) { vscode.postMessage({ type: 'close', id: r.id }); } },
      },
      h('span', { class: 'dot ' + status }),
      h('span', { class: 'label' }, r.title),
      r.running ? null : h('button', {
        class: 'close', title: t('Close'), 'aria-label': t('Close'),
        onclick: e => { e.stopPropagation(); vscode.postMessage({ type: 'close', id: r.id }); },
      }, icon('close'))));
    }
  }

  function toolButton(name, title, onclick, opts) {
    return h('button', {
      class: 'tool' + (opts && opts.on ? ' on' : ''), title, 'aria-label': title, 'aria-pressed': opts && 'on' in opts ? String(!!opts.on) : undefined,
      disabled: opts && opts.disabled, onclick,
    }, icon(name));
  }

  function renderToolbar() {
    toolbarEl.textContent = '';
    const r = activeRun();
    if (!r) { return; }
    const post = (type, extra) => vscode.postMessage({ type, id: r.id, ...(extra || {}) });
    toolbarEl.append(
      toolButton('rerun', t('Rerun'), () => post('rerun', { debug: false })),
      toolButton('debug', t('Debug'), () => post('rerun', { debug: true })),
      toolButton('stop', t('Stop'), () => post('stop'), { disabled: !r.running }),
      h('span', { class: 'sep' }),
      r.kind === 'flutter' ? toolButton('hot', t('Hot Reload'), () => post('hot', { restart: false }), { disabled: !r.running || !r.debug }) : null,
      r.kind === 'flutter' ? toolButton('restart', t('Hot Restart'), () => post('hot', { restart: true }), { disabled: !r.running || !r.debug }) : null,
      r.terminal ? toolButton('terminal', t('Show Terminal'), () => post('terminal')) : null,
      toolButton('end', t('Scroll to the End'), () => { S.follow = !S.follow; if (S.follow) { scrollEnd(); } renderToolbar(); }, { on: S.follow }),
      toolButton('wrap', t('Soft-Wrap'), () => {
        S.wrap = !S.wrap;
        vscode.setState({ wrap: S.wrap });
        outEl.classList.toggle('wrap', S.wrap);
        renderToolbar();
      }, { on: S.wrap }),
      toolButton('clear', t('Clear All'), () => post('clear')),
    );
  }

  function spanEl(s) {
    if (!s.cls && !s.fg && !s.bg) { return document.createTextNode(s.text); }
    const el = document.createElement('span');
    if (s.cls) { el.className = s.cls; }
    // CSSOM (allowed by the CSP) for 256/true colours.
    if (s.fg) { el.style.color = s.fg; }
    if (s.bg) { el.style.backgroundColor = s.bg; }
    el.textContent = s.text;
    return el;
  }

  function scrollEnd() { outEl.scrollTop = outEl.scrollHeight; }

  function renderOutput() {
    const r = activeRun();
    emptyEl.hidden = !!r;
    outEl.hidden = !r;
    inputEl.hidden = !(r && r.input && r.running);
    outEl.textContent = '';
    if (!r) { return; }
    if (r.terminal && !r.spans.length) {
      outEl.append(h('span', { class: 'sys' }, t('The output of this configuration is in the integrated terminal.')));
    }
    const frag = document.createDocumentFragment();
    for (const s of r.spans) { frag.append(spanEl(s)); }
    outEl.append(frag);
    S.follow = true;
    scrollEnd();
  }

  function render() {
    renderTabs();
    renderToolbar();
    renderOutput();
  }

  function activate(id) {
    S.active = id;
    vscode.postMessage({ type: 'activate', id });
    render();
  }

  // Keep the DOM bounded like the extension's buffer (≈ 2 MB of text).
  const MAX_NODES = 20000;
  function trimDom() {
    while (outEl.childNodes.length > MAX_NODES) { outEl.removeChild(outEl.firstChild); }
  }

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'strings':
        S.strings = m.strings;
        layout();
        render();
        break;
      case 'state':
        S.runs = m.runs;
        S.active = m.active && S.runs.some(r => r.id === m.active) ? m.active : (S.runs[S.runs.length - 1] || {}).id || null;
        render();
        break;
      case 'reset': {
        const i = S.runs.findIndex(r => r.id === m.run.id);
        const run = { ...m.run, spans: m.spans };
        if (i >= 0) { S.runs[i] = run; } else { S.runs.push(run); }
        if (m.activate) { S.active = run.id; }
        render();
        break;
      }
      case 'meta': {
        const r = S.runs.find(x => x.id === m.run.id);
        if (!r) { S.runs.push({ ...m.run, spans: [] }); } else { Object.assign(r, m.run); }
        renderTabs();
        if (m.run.id === S.active) { renderToolbar(); inputEl.hidden = !(m.run.input && m.run.running); }
        break;
      }
      case 'append': {
        const r = S.runs.find(x => x.id === m.id);
        if (!r) { break; }
        r.spans.push(...m.spans);
        if (r.spans.length > MAX_NODES) { r.spans.splice(0, r.spans.length - MAX_NODES); }
        if (m.id === S.active) {
          const frag = document.createDocumentFragment();
          for (const s of m.spans) { frag.append(spanEl(s)); }
          outEl.append(frag);
          trimDom();
          if (S.follow) { scrollEnd(); }
        }
        break;
      }
      case 'activate':
        if (S.runs.some(r => r.id === m.id)) { activate(m.id); }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
