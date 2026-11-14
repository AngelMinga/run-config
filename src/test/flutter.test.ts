import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { deviceIcon, findFlutter, parseDevices, parseEmulators } from '../flutter';
import { buildFlutterLaunch, emptyConfig } from '../model';

test('parseDevices reads --machine output and skips unsupported devices', () => {
  const out = `Some log line\n[
    {"name":"macOS","id":"macos","isSupported":true,"targetPlatform":"darwin","emulator":false,"sdk":"macOS 27.2"},
    {"name":"Chrome","id":"chrome","isSupported":true,"targetPlatform":"web-javascript","emulator":false,"sdk":"Chrome 157"},
    {"name":"sdk gphone64","id":"emulator-5554","isSupported":true,"targetPlatform":"android-arm64","emulator":true,"sdk":"Android 15"},
    {"name":"Old","id":"x","isSupported":false,"targetPlatform":"ios"}
  ]`;
  assert.deepEqual(parseDevices(out).map(d => [d.id, d.platform, d.emulator]), [
    ['macos', 'darwin', false], ['chrome', 'web-javascript', false], ['emulator-5554', 'android-arm64', true],
  ]);
  assert.deepEqual(parseDevices('No devices'), []);
  assert.deepEqual(parseDevices('[not json'), []);
});

test('parseEmulators reads the table', () => {
  const out = `2 available emulators:

Id                  • Name                • Manufacturer • Platform

Pixel_8_Pro         • Pixel 8 Pro         • Google       • android
apple_ios_simulator • iOS Simulator       • Apple        • ios

To run an emulator, run 'flutter emulators --launch <emulator id>'.`;
  assert.deepEqual(parseEmulators(out), [
    { id: 'Pixel_8_Pro', name: 'Pixel 8 Pro', platform: 'android' },
    { id: 'apple_ios_simulator', name: 'iOS Simulator', platform: 'ios' },
  ]);
});

test('findFlutter prefers the Dart extension setting', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runcfg-fl-'));
  const sdk = path.join(home, 'sdks', 'flutter-3.41.0');
  fs.mkdirSync(path.join(sdk, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'bin', 'flutter'), '');
  assert.equal(findFlutter(['~/sdks/flutter-3.41.0'], { PATH: '' }, home, 'darwin'), path.join(sdk, 'bin', 'flutter'));
  assert.equal(findFlutter(undefined, { PATH: path.join(sdk, 'bin') }, home, 'darwin'), path.join(sdk, 'bin', 'flutter'));
});

test('deviceIcon by platform', () => {
  assert.equal(deviceIcon('web-javascript'), 'globe');
  assert.equal(deviceIcon('darwin'), 'vm');
  assert.equal(deviceIcon('android-arm64'), 'device-mobile');
});

test('buildFlutterLaunch: device and attach', () => {
  const c = { ...emptyConfig('/w', 'app', 'flutter'), runArgs: '--release', attachArgs: '--debug-url=http://x', flavor: 'dev' };
  const run = buildFlutterLaunch(c, '/w', { deviceId: 'macos' });
  assert.equal(run.request, 'launch');
  assert.equal(run.deviceId, 'macos');
  assert.deepEqual(run.toolArgs, ['--release', '--flavor', 'dev']);
  const attach = buildFlutterLaunch(c, '/w', { attach: true });
  assert.equal(attach.request, 'attach');
  assert.equal(attach.name, 'app (attach)');
  assert.equal(attach.deviceId, undefined);
  assert.deepEqual(attach.toolArgs, ['--debug-url=http://x', '--flavor', 'dev']);
});
