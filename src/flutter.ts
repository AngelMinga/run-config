import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findIn, pathDirs } from './detect';

export interface FlutterDevice {
  id: string;
  name: string;
  /** `darwin`, `web-javascript`, `android-arm64`, `ios`… */
  platform: string;
  emulator: boolean;
  sdk: string;
}

export interface FlutterEmulator {
  id: string;
  name: string;
  platform: string;
}

/** `flutter` executable: Dart extension setting, PATH, then usual install locations. */
export function findFlutter(sdkSetting: unknown, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string | undefined {
  const exe = platform === 'win32' ? 'flutter.bat' : 'flutter';
  const sdks = (Array.isArray(sdkSetting) ? sdkSetting : [sdkSetting])
    .filter((s): s is string => typeof s === 'string' && !!s)
    .map(s => s.replace(/^~(?=$|[\\/])/, home));
  const roots = [
    ...sdks,
    env.FLUTTER_ROOT ?? '',
    path.join(home, 'flutter'),
    path.join(home, 'development', 'flutter'),
    path.join(home, 'fvm', 'default'),
    path.join(home, 'snap', 'flutter', 'common', 'flutter'),
  ].filter(Boolean);
  for (const root of roots) {
    const p = path.join(root, 'bin', exe);
    if (fs.existsSync(p)) { return p; }
  }
  return findIn(pathDirs(env, platform), 'flutter', platform)
    ?? (platform !== 'win32' ? ['/opt/homebrew/bin/flutter', '/usr/local/bin/flutter'].find(p => fs.existsSync(p)) : undefined);
}

/** Output of `flutter devices --machine` (may be preceded by log lines). */
export function parseDevices(stdout: string): FlutterDevice[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) { return []; }
  try {
    const list = JSON.parse(stdout.slice(start, end + 1));
    if (!Array.isArray(list)) { return []; }
    return list
      .filter(d => d && typeof d.id === 'string' && d.isSupported !== false)
      .map(d => ({
        id: d.id,
        name: String(d.name ?? d.id),
        platform: String(d.targetPlatform ?? ''),
        emulator: d.emulator === true,
        sdk: String(d.sdk ?? ''),
      }));
  } catch {
    return [];
  }
}

/** Table rows of `flutter emulators`: `Id • Name • Manufacturer • Platform`. */
export function parseEmulators(stdout: string): FlutterEmulator[] {
  const out: FlutterEmulator[] = [];
  let header = false;
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.split('•').map(c => c.trim());
    if (cols.length < 4) { continue; }
    if (!header && cols[0] === 'Id') { header = true; continue; }
    out.push({ id: cols[0], name: cols[1], platform: cols[cols.length - 1] });
  }
  return out;
}

export function runFlutter(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout ?? ''))));
  });
}

/** Codicon for a device's target platform. */
/** Flutter platform folders a project can have (`flutter create --platforms=…`). */
export const PLATFORM_DIRS = ['android', 'ios', 'macos', 'web', 'linux', 'windows'] as const;
export type ProjectPlatform = typeof PLATFORM_DIRS[number];

/** Maps a device `targetPlatform` (`darwin`, `web-javascript`, `android-arm64`…) or an emulator platform to its project folder. */
export function devicePlatformKey(platform: string): ProjectPlatform | undefined {
  const p = platform.toLowerCase();
  if (p === 'darwin' || p.startsWith('macos')) { return 'macos'; }
  if (p.startsWith('web')) { return 'web'; }
  if (p.startsWith('android')) { return 'android'; }
  if (p.startsWith('ios')) { return 'ios'; }
  if (p.startsWith('linux')) { return 'linux'; }
  if (p.startsWith('windows')) { return 'windows'; }
  return undefined;
}

/** Platform folders present in the given Flutter project roots (union). */
export function projectPlatforms(roots: string[], exists: (p: string) => boolean = fs.existsSync): Set<ProjectPlatform> {
  const out = new Set<ProjectPlatform>();
  for (const root of roots) {
    for (const dir of PLATFORM_DIRS) {
      if (exists(path.join(root, dir))) { out.add(dir); }
    }
  }
  return out;
}

/** A device is supported when the project has its platform folder. Unknown platforms or projects are not filtered. */
export function isDeviceSupported(platform: string, platforms: Set<ProjectPlatform> | undefined): boolean {
  if (!platforms || platforms.size === 0) { return true; }
  const key = devicePlatformKey(platform);
  return !key || platforms.has(key);
}

export function deviceIcon(platform: string): string {
  if (platform.startsWith('web')) { return 'globe'; }
  if (/^(darwin|linux|windows)/.test(platform)) { return 'vm'; }
  return 'device-mobile';
}
