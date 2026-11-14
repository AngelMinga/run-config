import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { findIntellijProjects, parseIntellijXml, readIntellijConfigs } from '../intellij';

const WORKSPACE = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="RunManager" selected="npm.bancapersonas start">
    <configuration name="bancapersonas start" type="js.build_tools.npm" nameIsGenerated="true">
      <package-json value="$PROJECT_DIR$/bancapersonas/package.json" />
      <command value="start" />
      <node-interpreter value="project" />
      <package-manager value="$USER_HOME$/.nvm/versions/node/v24.16.0/bin/pnpm" />
      <arguments value="--port 3000" />
      <node-options value="--max-old-space-size=4096" />
      <envs>
        <env name="API_URL" value="http://localhost:8080?a=1&amp;b=2" />
      </envs>
      <method v="2" />
    </configuration>
    <configuration name="run dev" type="js.build_tools.npm" allowRunningInParallel="true">
      <package-json value="$PROJECT_DIR$/package.json" />
      <command value="run" />
      <scripts>
        <script value="dev" />
      </scripts>
      <node-interpreter value="/opt/homebrew/bin/node" />
      <package-manager value="yarn" />
      <envs />
    </configuration>
    <configuration default="true" type="js.build_tools.npm">
      <command value="run" />
    </configuration>
    <configuration name="main.dart" type="FlutterRunConfigurationType" factoryName="Flutter">
      <option name="filePath" value="$PROJECT_DIR$/lib/main.dart" />
      <option name="additionalArgs" value="--dart-define=ENV=dev" />
      <option name="buildFlavor" value="dev" />
      <method v="2" />
    </configuration>
    <configuration name="Main" type="Application" />
  </component>
</project>`;

test('parses IntelliJ npm run configurations', () => {
  const configs = parseIntellijXml(WORKSPACE, '/p', '/Users/me', false);
  assert.equal(configs.length, 3);
  const [start, dev, flutter] = configs;
  assert.equal(flutter.kind, 'flutter');
  assert.equal(flutter.program, '/p/lib/main.dart');
  assert.equal(flutter.runArgs, '--dart-define=ENV=dev');
  assert.equal(flutter.flavor, 'dev');
  assert.equal(start.kind, 'npm');
  assert.equal(start.name, 'bancapersonas start');
  assert.equal(start.packageJson, '/p/bancapersonas/package.json');
  assert.equal(start.command, 'start');
  assert.equal(start.scripts, '');
  assert.equal(start.arguments, '--port 3000');
  assert.equal(start.nodeRuntime, '');
  assert.equal(start.nodeOptions, '--max-old-space-size=4096');
  assert.equal(start.packageManager, '/Users/me/.nvm/versions/node/v24.16.0/bin/pnpm');
  assert.deepEqual(start.env, { API_URL: 'http://localhost:8080?a=1&b=2' });
  assert.equal(start.allowMultiple, false);

  assert.equal(dev.scripts, 'dev');
  assert.equal(dev.nodeRuntime, '/opt/homebrew/bin/node');
  assert.equal(dev.packageManager, 'yarn');
  assert.equal(dev.allowMultiple, true);
});

test('finds projects and reads workspace.xml plus .run files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runcfg-ij-'));
  const project = path.join(root, 'bancapersonas');
  fs.mkdirSync(path.join(project, '.idea'), { recursive: true });
  fs.mkdirSync(path.join(project, '.run'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'x', '.idea'), { recursive: true });
  fs.writeFileSync(path.join(project, '.idea', 'workspace.xml'), WORKSPACE);
  fs.writeFileSync(path.join(project, '.run', 'build.run.xml'), `<component name="ProjectRunConfigurationManager">
  <configuration name="build" type="js.build_tools.npm">
    <package-json value="$PROJECT_DIR$/package.json" />
    <command value="run" />
    <scripts><script value="build" /></scripts>
  </configuration>
</component>`);

  assert.deepEqual(findIntellijProjects(root), [project]);
  const configs = readIntellijConfigs(project, '/Users/me');
  assert.deepEqual(configs.map(c => [c.name, c.shared]), [['bancapersonas start', false], ['run dev', false], ['main.dart', false], ['build', true]]);
  assert.equal(configs[3].packageJson, path.join(project, 'package.json'));
});
