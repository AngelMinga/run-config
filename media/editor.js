// Run/Debug Configurations dialog (webview). Plain DOM, no framework.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const S = {
    configs: [], others: [], folders: [], packageJsons: [], dartEntrypoints: [], hasDart: true, commands: [], tasks: [],
    home: '', sep: '/', strings: {}, detection: null, inspected: {},
    selectedId: null, dirty: false, error: '', nextId: 1,
  };

  const t = (key, ...args) => (S.strings[key] || key).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
  const tilde = p => (p && S.home && (p === S.home || p.startsWith(S.home + S.sep)) ? '~' + p.slice(S.home.length) : p || '');
  const untilde = p => (p && /^~(?=$|[\\/])/.test(p) ? S.home + p.slice(1) : p);
  const dirname = p => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : p; };
  const baseName = p => p.split(/[\\/]/).pop();
  const joinPath = (a, b) => (a.endsWith(S.sep) ? a + b : a + S.sep + b);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) { continue; }
      if (k === 'class') { el.className = v; }
      else if (k.startsWith('on')) { el.addEventListener(k.slice(2), v); }
      else if (k === 'value') { el.value = v; }
      else if (k === 'checked' || k === 'disabled' || k === 'selected') { el[k] = !!v; }
      else { el.setAttribute(k, v === true ? '' : v); }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) { continue; }
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // Small inline icons (codicon-like), stroke = currentColor.
  const ICONS = {
    add: '<path d="M8 3v10M3 8h10"/>',
    remove: '<path d="M3 8h10"/>',
    copy: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/>',
    play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>',
    debug: '<path d="M5.5 6.5a2.5 2.5 0 0 1 5 0v4a2.5 2.5 0 0 1-5 0zM8 6.5v6M3 8.5h2.5M10.5 8.5H13M3.5 5l2 1.5M12.5 5l-2 1.5M3.5 12.5l2-1.5M12.5 12.5l-2-1.5M6 4.5 5 3M10 4.5l1-1.5"/>',
    pkg: '<path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="M2.5 5 8 7.5 13.5 5M8 7.5v6"/>',
    launch: '<path d="M4 3.5v9l8-4.5z"/>',
    flutter: '<path d="M9.5 1.5 3 8l2 2 8.5-8.5zM9.5 7.5 6 11l3.5 3.5h4L10 11l3.5-3.5z" fill="currentColor" stroke="none"/>',
    chevron: '<path d="m4 6 4 4 4-4"/>',
    folder: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5"/>',
    link: '<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5"/>',
  };
  function icon(name, cls) {
    const span = h('span', { class: 'icon' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  const selected = () => S.configs.find(c => c.id === S.selectedId);
  const withId = c => ({ ...c, env: { ...(c.env || {}) }, id: 'c' + S.nextId++ });

  function folderFor(packageJson, fallback) {
    let best = '';
    for (const f of S.folders) {
      if ((packageJson === f.path || packageJson.startsWith(f.path + S.sep)) && f.path.length > best.length) { best = f.path; }
    }
    return best || fallback || (S.folders[0] && S.folders[0].path) || '';
  }

  const KINDS = [
    { kind: 'npm', icon: 'pkg', cls: 'npm' },
    { kind: 'flutter', icon: 'flutter', cls: 'flutter' },
  ];
  const kindOf = c => (c.kind === 'flutter' ? KINDS[1] : KINDS[0]);
  const anchor = c => (c.kind === 'flutter' ? c.program : c.packageJson);

  function markDirty() {
    S.dirty = true;
    S.error = '';
    renderFooter();
  }

  // ---------- inspection (scripts, "Project" node / package manager) ----------
  let inspectTimer;
  function requestInspect(c) {
    if (c.kind === 'flutter') { return; }
    clearTimeout(inspectTimer);
    inspectTimer = setTimeout(() => {
      vscode.postMessage({ type: 'inspect', id: c.id, config: strip(c) });
    }, 250);
  }

  function strip(c) {
    const { id: _id, ...rest } = c;
    return rest;
  }

  // ---------- rendering ----------
  const app = document.getElementById('app');
  let sidebarEl, formEl, footerEl;

  function render() {
    app.textContent = '';
    sidebarEl = h('aside', { class: 'sidebar' });
    formEl = h('section', { class: 'content' });
    footerEl = h('footer', { class: 'footer' });
    app.append(h('div', { class: 'main' }, sidebarEl, formEl), footerEl);
    renderSidebar();
    renderForm();
    renderFooter();
  }

  function toolButton(name, title, onclick, disabled) {
    return h('button', { class: 'tool', title, 'aria-label': title, onclick, disabled }, icon(name));
  }

  let addMenu;
  function closeAddMenu() {
    if (addMenu) { addMenu.remove(); addMenu = undefined; }
  }
  function toggleAddMenu(button) {
    if (addMenu) { closeAddMenu(); return; }
    const r = button.getBoundingClientRect();
    addMenu = h('div', { class: 'menu', role: 'menu' },
      h('div', { class: 'menu-title' }, t('Add New Configuration')),
      KINDS.map(k => h('button', {
        class: 'menu-item', role: 'menuitem',
        onclick: () => { closeAddMenu(); addConfig(k.kind); },
      }, icon(k.icon, k.cls), t(k.kind === 'npm' ? 'npm' : 'Flutter'))));
    // CSSOM is allowed by the CSP (inline style attributes are not).
    addMenu.style.top = `${r.bottom + 2}px`;
    addMenu.style.left = `${r.left}px`;
    document.body.append(addMenu);
    addMenu.querySelector('button').focus();
  }
  document.addEventListener('mousedown', e => {
    if (addMenu && !addMenu.contains(e.target) && !e.target.closest('.tool')) { closeAddMenu(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAddMenu(); }
  });

  function renderSidebar() {
    sidebarEl.textContent = '';
    const sel = selected();
    sidebarEl.append(h('div', { class: 'toolbar' },
      toolButton('add', t('Add New Configuration'), e => toggleAddMenu(e.currentTarget)),
      toolButton('remove', t('Remove Configuration'), removeConfig, !sel),
      toolButton('copy', t('Copy Configuration'), copyConfig, !sel),
    ));
    const tree = h('div', { class: 'tree', role: 'tree' });
    const multi = S.folders.length > 1;
    if (!S.configs.length) {
      tree.append(h('div', { class: 'empty' }, t('No run configurations. Click + to add one.')));
    }
    for (const k of KINDS) {
      const group = S.configs.filter(c => kindOf(c) === k);
      if (!group.length) { continue; }
      tree.append(h('div', { class: 'group' }, icon('chevron', 'small'), icon(k.icon, k.cls), t(k.kind === 'npm' ? 'npm' : 'Flutter')));
      for (const c of group) {
      tree.append(h('div', {
        class: 'item' + (c.id === S.selectedId ? ' selected' : ''),
        role: 'treeitem',
        tabindex: '0',
        title: anchor(c),
        onclick: () => selectConfig(c.id),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { selectConfig(c.id); } },
      }, icon(k.icon, k.cls), h('span', { class: 'label' }, c.name || t('Unnamed')),
      multi ? h('span', { class: 'desc' }, baseName(c.folder)) : null,
      c.shared ? h('span', { class: 'badge', title: t('Store as project file') }, 'launch.json') : null));
      }
    }
    if (S.others.length) {
      tree.append(h('div', { class: 'group' }, icon('chevron', 'small'), icon('launch'), t('Other launch.json configurations')));
      for (const o of S.others) {
        tree.append(h('div', {
          class: 'item other',
          role: 'treeitem',
          tabindex: '0',
          title: t('Edit in launch.json'),
          onclick: () => vscode.postMessage({ type: 'openLaunch', folder: o.folder, name: o.name }),
        }, icon('launch'), h('span', { class: 'label' }, o.name), h('span', { class: 'desc' }, o.type), icon('link', 'trail')));
      }
    }
    sidebarEl.append(tree);
  }

  function row(label, control, opts) {
    return h('div', { class: 'row' + (opts && opts.cls ? ' ' + opts.cls : '') },
      h('label', { for: opts && opts.for }, label), h('div', { class: 'control' }, control));
  }

  function datalist(id, values) {
    return h('datalist', { id }, values.map(v => (typeof v === 'string' ? h('option', { value: v }) : h('option', { value: v.value }, v.label))));
  }

  function textInput(c, field, opts) {
    return h('input', {
      id: 'f-' + field,
      type: 'text',
      value: opts && opts.path ? tilde(c[field]) : c[field],
      list: opts && opts.list,
      placeholder: opts && opts.placeholder,
      spellcheck: 'false',
      oninput: e => {
        c[field] = opts && opts.path ? untilde(e.target.value.trim()) : e.target.value;
        if (opts && opts.onChange) { opts.onChange(); }
        markDirty();
      },
    });
  }

  function versionSuffix(v) { return v ? '  ·  ' + v : ''; }

  function nodeOptions(c) {
    const info = S.inspected[c.id] || {};
    const pn = info.projectNode;
    const opts = [{ value: '', label: `${t('Project')}  —  ${pn ? 'node (' + tilde(pn.path) + ')' + versionSuffix(pn.version) : '…'}` }];
    const nodes = S.detection ? S.detection.nodes : [];
    for (const n of nodes) { opts.push({ value: n.path, label: tilde(n.path) + versionSuffix(n.version) }); }
    if (c.nodeRuntime && !nodes.some(n => n.path === c.nodeRuntime)) {
      opts.push({ value: c.nodeRuntime, label: tilde(c.nodeRuntime) });
    }
    if (!S.detection) { opts.push({ value: '__detecting__', label: t('Detecting…'), disabled: true }); }
    opts.push({ value: '__browse__', label: t('Browse…') });
    return opts;
  }

  function pmOptions(c) {
    const info = S.inspected[c.id] || {};
    const pp = info.projectPm;
    const opts = [{ value: '', label: `${t('Project')}  —  ${pp ? pp.name + (pp.path && pp.path !== pp.name ? ' (' + tilde(pp.path) + ')' : '') + versionSuffix(pp.version) : '…'}` }];
    const pms = S.detection ? S.detection.packageManagers : [];
    for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
      const first = pms.find(p => p.name === name);
      opts.push({ value: name, label: name + (first ? '' : '  —  ' + t('not found')) });
    }
    for (const p of pms) { opts.push({ value: p.path, label: `${p.name}  —  ${tilde(p.path)}${versionSuffix(p.version)}` }); }
    if (c.packageManager && !opts.some(o => o.value === c.packageManager)) {
      opts.push({ value: c.packageManager, label: tilde(c.packageManager) });
    }
    if (!S.detection) { opts.push({ value: '__detecting__', label: t('Detecting…'), disabled: true }); }
    opts.push({ value: '__browse__', label: t('Browse…') });
    return opts;
  }

  function runtimeSelect(c, field, optionsOf) {
    const select = h('select', {
      id: 'f-' + field,
      onchange: e => {
        const v = e.target.value;
        if (v === '__browse__') {
          e.target.value = c[field];
          vscode.postMessage({ type: 'browse', field, current: c[field], folder: c.folder });
          return;
        }
        c[field] = v;
        if (field === 'nodeRuntime') { requestInspect(c); }
        markDirty();
      },
    }, optionsOf(c).map(o => h('option', { value: o.value, disabled: o.disabled, selected: o.value === c[field] }, o.label)));
    return select;
  }

  function refreshRuntimeSelects() {
    const c = selected();
    if (!c) { return; }
    for (const [field, fn] of [['nodeRuntime', nodeOptions], ['packageManager', pmOptions]]) {
      const old = document.getElementById('f-' + field);
      if (old && document.activeElement !== old) { old.replaceWith(runtimeSelect(c, field, fn)); }
    }
    const scripts = document.getElementById('dl-scripts');
    if (scripts) { scripts.replaceWith(datalist('dl-scripts', ((S.inspected[c.id] || {}).scripts || []))); }
  }

  function renderForm() {
    formEl.textContent = '';
    const c = selected();
    if (!c) {
      formEl.append(h('div', { class: 'placeholder' }, t('No run configurations. Click + to add one.')));
      return;
    }
    const top = h('div', { class: 'top' },
      h('div', { class: 'row name' }, h('label', { for: 'f-name' }, t('Name:')),
        h('div', { class: 'control' }, textInput(c, 'name', { onChange: renderSidebarSoon }))),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: c.allowMultiple, onchange: e => { c.allowMultiple = e.target.checked; markDirty(); },
      }), t('Allow multiple instances')),
      h('label', { class: 'check', title: c.shared ? t('Saved in .vscode/launch.json (shared with the team).') : t('Saved privately in this workspace (not committed).') },
        h('input', {
          type: 'checkbox', checked: c.shared, onchange: e => { c.shared = e.target.checked; markDirty(); renderSidebar(); renderForm(); },
        }), t('Store as project file')),
    );
    const hint = h('div', { class: 'hint' }, c.shared ? t('Saved in .vscode/launch.json (shared with the team).') : t('Saved privately in this workspace (not committed).'));

    const browseBtn = field => h('button', {
      class: 'browse', title: t('Browse…'), 'aria-label': t('Browse…'),
      onclick: () => vscode.postMessage({ type: 'browse', field, current: c[field], folder: c.folder }),
    }, '…');

    const folderRow = () => (S.folders.length > 1 ? row(t('Workspace folder:'), h('select', {
      id: 'f-folder',
      onchange: e => { c.folder = e.target.value; markDirty(); renderSidebar(); },
    }, S.folders.map(f => h('option', { value: f.path, selected: f.path === c.folder }, f.name))), { for: 'f-folder' }) : null);
    const envRow = label => row(label, h('textarea', {
      id: 'f-env', rows: '3', spellcheck: 'false', placeholder: t('One KEY=value per line'),
      oninput: e => { c.env = parseEnv(e.target.value); markDirty(); },
    }, formatEnv(c.env)), { for: 'f-env', cls: 'top-align' });
    const beforeRow = () => row(t('Before launch:'), [textInput(c, 'preLaunchTask', { list: 'dl-tasks', placeholder: t('VS Code task to run before launch (preLaunchTask)') }),
      datalist('dl-tasks', S.tasks)], { for: 'f-preLaunchTask' });
    const help = text => h('div', { class: 'help' }, text);

    if (c.kind === 'flutter') {
      formEl.append(top, hint, h('div', { class: 'panel' },
        h('div', { class: 'tabs' }, h('span', { class: 'tab active' }, t('Configuration'))),
        S.hasDart ? null : h('div', { class: 'warning' }, t('The Dart and Flutter extensions are needed to run Flutter configurations.')),
        folderRow(),
        row(t('Dart entrypoint:'), [textInput(c, 'program', {
          path: true, list: 'dl-dart', onChange: () => {
            const folder = folderFor(c.program, c.folder);
            if (folder !== c.folder) { c.folder = folder; renderSidebarSoon(); }
          },
        }), browseBtn('program'), datalist('dl-dart', S.dartEntrypoints.map(tilde))], { for: 'f-program' }),
        help(t('The entry-point for the application (e.g. lib/main.dart).')),
        row(t('Additional run args:'), textInput(c, 'runArgs'), { for: 'f-runArgs' }),
        help(t("Additional arguments to 'flutter run'.")),
        row(t('Build flavor:'), textInput(c, 'flavor'), { for: 'f-flavor' }),
        help(t('An optional build flavor; either a Gradle product flavor or an Xcode custom scheme.')),
        envRow(t('Environment variables:')),
        help(t('Additional environment variables.')),
        beforeRow(),
      ));
      return;
    }

    const panel = h('div', { class: 'panel' },
      h('div', { class: 'tabs' }, h('span', { class: 'tab active' }, t('Configuration'))),
      folderRow(),
      row(t('package.json:'), [textInput(c, 'packageJson', {
        path: true, list: 'dl-pkg', onChange: () => {
          const folder = folderFor(c.packageJson, c.folder);
          if (folder !== c.folder) { c.folder = folder; renderSidebarSoon(); }
          requestInspect(c);
        },
      }), browseBtn('packageJson'), datalist('dl-pkg', S.packageJsons.map(tilde))], { for: 'f-packageJson' }),
      row(t('Command:'), [textInput(c, 'command', { list: 'dl-cmd' }), datalist('dl-cmd', S.commands)], { for: 'f-command' }),
      row(t('Scripts:'), [textInput(c, 'scripts', { list: 'dl-scripts', placeholder: t('Scripts from package.json') }),
        datalist('dl-scripts', ((S.inspected[c.id] || {}).scripts || []))], { for: 'f-scripts' }),
      row(t('Arguments:'), textInput(c, 'arguments'), { for: 'f-arguments' }),
      h('hr'),
      row(t('Node runtime:'), [runtimeSelect(c, 'nodeRuntime', nodeOptions),
        h('button', { class: 'browse', title: t('Refresh'), 'aria-label': t('Refresh'), onclick: () => { S.detection = null; refreshRuntimeSelects(); vscode.postMessage({ type: 'refresh' }); } }, icon('refresh'))],
      { for: 'f-nodeRuntime' }),
      row(t('Node options:'), textInput(c, 'nodeOptions'), { for: 'f-nodeOptions' }),
      row(t('Package manager:'), runtimeSelect(c, 'packageManager', pmOptions), { for: 'f-packageManager' }),
      envRow(t('Environment:')),
      beforeRow(),
    );
    formEl.append(top, hint, panel);
  }

  let sidebarTimer;
  function renderSidebarSoon() {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(renderSidebar, 150);
  }

  function renderFooter() {
    footerEl.textContent = '';
    const c = selected();
    footerEl.append(
      h('button', { class: 'secondary', disabled: !c, onclick: () => save({ run: false }) }, icon('play', 'run'), t('Run')),
      h('button', { class: 'secondary', disabled: !c, onclick: () => save({ run: true }) }, icon('debug', 'debug'), t('Debug')),
      h('span', { class: 'error', role: 'alert' }, S.error),
      h('span', { class: 'spacer' }),
      h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'cancel' }) }, t('Cancel')),
      h('button', { class: 'secondary', disabled: !S.dirty, onclick: () => save({}) }, t('Apply')),
      h('button', { class: 'primary', onclick: () => save({ close: true }) }, t('OK')),
    );
  }

  // ---------- env helpers (same rules as model.ts) ----------
  function parseEnv(text) {
    const env = {};
    for (const raw of text.split(/\r?\n|;/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) { continue; }
      const eq = line.indexOf('=');
      if (eq > 0) { env[line.slice(0, eq).trim()] = line.slice(eq + 1); }
    }
    return env;
  }
  function formatEnv(env) {
    return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  }

  // ---------- actions ----------
  function selectConfig(id) {
    S.selectedId = id;
    S.error = '';
    renderSidebar();
    renderForm();
    renderFooter();
    const c = selected();
    if (c && c.kind !== 'flutter' && !S.inspected[c.id]) { requestInspect(c); }
  }

  function uniqueName(base, folder) {
    const taken = n => S.configs.some(o => o.folder === folder && o.name === n);
    if (!taken(base)) { return base; }
    for (let i = 2; ; i++) { if (!taken(`${base} (${i})`)) { return `${base} (${i})`; } }
  }

  function addConfig(kind) {
    const ref = selected();
    const folder = ref ? ref.folder : (S.folders[0] && S.folders[0].path) || '';
    const flutter = kind === 'flutter';
    const entry = flutter && (S.dartEntrypoints.find(p => p.startsWith(folder + S.sep)) || (folder ? joinPath(joinPath(folder, 'lib'), 'main.dart') : ''));
    const c = withId({
      kind: flutter ? 'flutter' : 'npm',
      name: uniqueName(flutter ? baseName(entry) || 'main.dart' : t('Unnamed'), folder), folder, shared: false, allowMultiple: false,
      packageJson: folder ? joinPath(folder, 'package.json') : '', command: 'run', scripts: '', arguments: '',
      nodeRuntime: '', nodeOptions: '', packageManager: '', env: {}, preLaunchTask: '',
      program: entry || '', runArgs: '', flavor: '',
    });
    S.configs.push(c);
    markDirty();
    selectConfig(c.id);
    const name = document.getElementById('f-name');
    if (name) { name.focus(); name.select(); }
  }

  function removeConfig() {
    const i = S.configs.findIndex(c => c.id === S.selectedId);
    if (i < 0) { return; }
    S.configs.splice(i, 1);
    const next = S.configs[Math.min(i, S.configs.length - 1)];
    markDirty();
    selectConfig(next ? next.id : null);
  }

  function copyConfig() {
    const ref = selected();
    if (!ref) { return; }
    const { origin: _origin, ...rest } = ref;
    const c = withId({ ...rest, name: uniqueName(ref.name, ref.folder) });
    S.configs.splice(S.configs.indexOf(ref) + 1, 0, c);
    markDirty();
    selectConfig(c.id);
  }

  function save(opts) {
    const c = selected();
    const configs = S.configs.map(strip);
    const sel = c ? { folder: c.folder, name: c.name } : undefined;
    vscode.postMessage({
      type: 'save',
      configs,
      close: !!opts.close,
      selected: sel,
      run: opts.run !== undefined && sel ? { ...sel, debug: opts.run } : undefined,
    });
  }

  // ---------- messages ----------
  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'init': {
        Object.assign(S, {
          configs: m.configs.map(withId), others: m.others, folders: m.folders, packageJsons: m.packageJsons,
          dartEntrypoints: m.dartEntrypoints || [], hasDart: m.hasDart !== false,
          commands: m.commands, home: m.home, sep: m.sep, strings: m.strings, dirty: false, error: '', inspected: {},
        });
        const pre = m.selected && S.configs.find(c => c.folder === m.selected.folder && c.name === m.selected.name);
        render();
        selectConfig(pre ? pre.id : S.configs[0] ? S.configs[0].id : null);
        break;
      }
      case 'detection':
        S.detection = m.detection;
        refreshRuntimeSelects();
        break;
      case 'tasks': {
        S.tasks = m.tasks;
        const dl = document.getElementById('dl-tasks');
        if (dl) { dl.replaceWith(datalist('dl-tasks', S.tasks)); }
        break;
      }
      case 'inspected':
        S.inspected[m.id] = m;
        if (m.id === S.selectedId) { refreshRuntimeSelects(); }
        break;
      case 'browsed': {
        const c = selected();
        if (!c) { break; }
        c[m.field] = m.value;
        if (m.field === 'packageJson' || m.field === 'program') { c.folder = folderFor(m.value, c.folder); }
        markDirty();
        requestInspect(c);
        renderSidebar();
        renderForm();
        break;
      }
      case 'saved': {
        const cur = selected();
        const key = cur ? cur.folder + '::' + cur.name : '';
        S.configs = m.configs.map(withId);
        S.inspected = {};
        S.dirty = false;
        const again = S.configs.find(c => c.folder + '::' + c.name === key);
        selectConfig(again ? again.id : S.configs[0] ? S.configs[0].id : null);
        break;
      }
      case 'error':
        S.error = m.message;
        renderFooter();
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
