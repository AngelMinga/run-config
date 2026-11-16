import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig, expandCompound, fromLaunchEntry, renameMembers, toLaunchEntry } from '../model';
import { parseIntellijXml } from '../intellij';

const folder = '/w';
const cfg = (name: string, kind: 'npm' | 'compound' = 'npm', members: string[] = []) => ({ ...emptyConfig(folder, name, kind), members });

test('compound round-trips through launch.json', () => {
  const c = { ...cfg('All', 'compound', ['api', 'web']), shared: true };
  const entry = toLaunchEntry(c, '/home');
  assert.deepEqual(entry, { type: 'compound-run', request: 'launch', name: 'All', configurations: ['api', 'web'] });
  assert.deepEqual(fromLaunchEntry(entry, folder, '/home', true), c);
});

test('expandCompound flattens nested compounds, ignores cycles and reports missing names', () => {
  const all = [cfg('api'), cfg('web'), cfg('worker'), cfg('Back', 'compound', ['api', 'worker', 'All']), cfg('All', 'compound', ['Back', 'web', 'ghost', 'api'])];
  const lookup = (n: string) => all.find(c => c.name === n);
  assert.deepEqual(expandCompound(all[4], lookup), { names: ['api', 'worker', 'web'], missing: ['ghost'] });
  // launch.json entries count as members too.
  assert.deepEqual(expandCompound(cfg('X', 'compound', ['Attach']), n => (n === 'Attach' ? { kind: 'launch' } : undefined)),
    { names: ['Attach'], missing: [] });
});

test('renameMembers follows renamed configurations in the same folder only', () => {
  const a = cfg('All', 'compound', ['api', 'web']);
  const other = { ...cfg('All', 'compound', ['api']), folder: '/other' };
  renameMembers([a, other], folder, new Map([['api', 'api (dev)']]));
  assert.deepEqual(a.members, ['api (dev)', 'web']);
  assert.deepEqual(other.members, ['api']);
});

test('imports IntelliJ compound configurations', () => {
  const xml = `<component name="RunManager">
    <configuration name="Backend + Front" type="CompoundRunConfigurationType">
      <toRun name="api start" type="js.build_tools.npm" />
      <toRun name="web dev" type="js.build_tools.npm" />
      <method v="2" />
    </configuration>
  </component>`;
  const [c] = parseIntellijXml(xml, '/p', '/home', false);
  assert.equal(c.kind, 'compound');
  assert.equal(c.name, 'Backend + Front');
  assert.deepEqual(c.members, ['api start', 'web dev']);
});
