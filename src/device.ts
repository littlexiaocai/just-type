/**
 * 只对这台设备生效的设置，存在本机 localStorage，不随 Obsidian Sync 同步。
 *
 * 目前只有「在这台设备上停用」：Just Type 专为 iPad 外接键盘优化，在 iPhone（常用屏幕键盘）和 Mac（第三方输入法
 * 也用 Shift 切中英）上会互相干扰。用户在那台设备上停用即可；不要去关「已安装插件」列表里的开关——
 * 开了同步时，那个开关会连带关掉其他设备上的 Just Type。
 *
 * 键名与 update.ts 一样用 appId 前缀：同一台设备上不同的库各记各的。
 */
import type { App } from "obsidian";

const STORE_KEY = "just-type-device";

interface DeviceState {
  disabled?: boolean;
}

export class DeviceSettings {
  private state: DeviceState;

  constructor(private app: App) {
    this.state = this.load();
  }

  private storageKey(): string {
    const appId = (this.app as unknown as { appId?: unknown }).appId;
    return typeof appId === "string" && appId ? `${appId}-${STORE_KEY}` : `${STORE_KEY}:${this.app.vault.getName()}`;
  }

  private load(): DeviceState {
    try {
      const raw = window.localStorage.getItem(this.storageKey());
      const value = raw ? JSON.parse(raw) as unknown : null;
      return value !== null && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  get disabled(): boolean {
    return this.state.disabled === true;
  }

  setDisabled(on: boolean): void {
    this.state.disabled = on;
    try {
      window.localStorage.setItem(this.storageKey(), JSON.stringify(this.state));
    } catch {
      // 存不下时本次打开照样生效，只是下次打开要重新设。
    }
  }
}
