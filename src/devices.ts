import * as os from 'node:os';
import * as vscode from 'vscode';
import { deviceIcon, findFlutter, FlutterDevice, FlutterEmulator, parseDevices, parseEmulators, runFlutter } from './flutter';

const t = vscode.l10n.t;
const SELECTED_KEY = 'runConfigurations.flutterDevice';

export interface SelectedDevice {
  id: string;
  name: string;
  platform: string;
}

/** IntelliJ-style Flutter device selector, backed by `flutter devices --machine` (slow: cached, refreshed in background). */
export class DeviceService implements vscode.Disposable {
  private devices?: FlutterDevice[];
  private emulators?: FlutterEmulator[];
  private refreshing?: Promise<void>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  dispose(): void {
    this.changed.dispose();
  }

  selected(): SelectedDevice | undefined {
    return this.state.get<SelectedDevice>(SELECTED_KEY);
  }

  private async setSelected(device: SelectedDevice | undefined): Promise<void> {
    await this.state.update(SELECTED_KEY, device);
    this.changed.fire();
  }

  private flutterBin(): string | undefined {
    return findFlutter(vscode.workspace.getConfiguration('dart').get('flutterSdkPath'), process.env, os.homedir(), process.platform);
  }

  /** Re-reads devices and emulators; concurrent calls share the same run. */
  refresh(): Promise<void> {
    if (this.refreshing) { return this.refreshing; }
    const bin = this.flutterBin();
    if (!bin) {
      this.devices = [];
      this.emulators = [];
      return Promise.resolve();
    }
    this.refreshing = (async () => {
      const [devices, emulators] = await Promise.all([
        runFlutter(bin, ['devices', '--machine'], process.env).then(parseDevices, () => [] as FlutterDevice[]),
        runFlutter(bin, ['emulators'], process.env).then(parseEmulators, () => [] as FlutterEmulator[]),
      ]);
      this.devices = devices;
      this.emulators = emulators;
      // Keep the selection's display name fresh; drop nothing (the device may just be disconnected).
      const sel = this.selected();
      const match = sel && devices.find(d => d.id === sel.id);
      if (match && match.name !== sel.name) {
        await this.setSelected({ id: match.id, name: match.name, platform: match.platform });
      }
      this.changed.fire();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /** Warms the cache once, e.g. when a Flutter configuration is selected. */
  warmUp(): void {
    if (!this.devices && !this.refreshing) { void this.refresh(); }
  }

  /** Quick pick like IntelliJ's device combo: devices, emulators to open, refresh. */
  async pick(): Promise<void> {
    if (!this.flutterBin()) {
      void vscode.window.showErrorMessage(t('Flutter SDK not found. Set "dart.flutterSdkPath" or add flutter to PATH.'));
      return;
    }
    interface Item extends vscode.QuickPickItem { device?: FlutterDevice; emulator?: FlutterEmulator; action?: 'refresh' | 'default' }
    const qp = vscode.window.createQuickPick<Item>();
    qp.placeholder = t('Select the device to run Flutter configurations on');
    const build = () => {
      const sel = this.selected();
      const items: Item[] = [];
      items.push({ label: t('Devices'), kind: vscode.QuickPickItemKind.Separator });
      for (const d of this.devices ?? []) {
        items.push({
          label: `$(${deviceIcon(d.platform)}) ${d.name}`,
          description: d.id === sel?.id ? `${d.sdk} · ${t('selected')}` : d.sdk,
          device: d,
        });
      }
      if (sel && this.devices && !this.devices.some(d => d.id === sel.id)) {
        items.push({ label: `$(debug-disconnect) ${sel.name}`, description: t('not connected'), device: { ...sel, emulator: false, sdk: '' } });
      }
      if (this.devices && !this.devices.length) {
        items.push({ label: `$(info) ${t('No devices found')}` });
      }
      if (this.emulators?.length) {
        items.push({ label: t('Emulators'), kind: vscode.QuickPickItemKind.Separator });
        for (const e of this.emulators) {
          items.push({ label: `$(play-circle) ${t('Open Emulator: {0}', e.name)}`, description: e.platform, emulator: e });
        }
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: `$(refresh) ${t('Refresh')}`, action: 'refresh' });
      items.push({
        label: `$(extensions) ${t("Use the Flutter extension's device")}`,
        description: sel ? undefined : t('selected'),
        action: 'default',
      });
      qp.items = items;
      const active = items.find(i => i.device && i.device.id === sel?.id);
      if (active) { qp.activeItems = [active]; }
    };
    const load = () => {
      qp.busy = true;
      void this.refresh().then(() => { qp.busy = false; build(); });
    };
    build();
    if (!this.devices) { load(); }
    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0];
      if (!item) { return; }
      if (item.action === 'refresh') { load(); return; }
      qp.hide();
      if (item.action === 'default') {
        await this.setSelected(undefined);
      } else if (item.device) {
        await this.setSelected({ id: item.device.id, name: item.device.name, platform: item.device.platform });
      } else if (item.emulator) {
        await this.launchEmulator(item.emulator);
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  private async launchEmulator(e: FlutterEmulator): Promise<void> {
    const bin = this.flutterBin();
    if (!bin) { return; }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Starting emulator {0}…', e.name) },
      async () => {
        const before = new Set((this.devices ?? []).map(d => d.id));
        await runFlutter(bin, ['emulators', '--launch', e.id], process.env, 120000).catch(() => '');
        // The emulator takes a while to show up in `flutter devices`.
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 5000));
          await this.refresh();
          const fresh = (this.devices ?? []).find(d => !before.has(d.id) && d.emulator);
          if (fresh) {
            await this.setSelected({ id: fresh.id, name: fresh.name, platform: fresh.platform });
            return;
          }
        }
        void vscode.window.showWarningMessage(t('The emulator did not appear in the device list yet. Pick it once it has started.'));
      },
    );
  }
}
