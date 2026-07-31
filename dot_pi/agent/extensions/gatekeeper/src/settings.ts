/**
 * The `/gatekeeper` settings screen.
 *
 * Session-scoped: changes here apply immediately and are journalled onto the
 * session (`gatekeeper-config` custom entries) so a fork or a tree navigation
 * replays them. The file at `~/.pi/agent/extensions/gatekeeper.json` stays the
 * durable default and is never written from the TUI.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { AuditorModelRef } from "./auditor";
import { type GatekeeperConfig, isAskMode, isPermissionMode } from "./policy";

export interface SettingsDeps {
  config(): GatekeeperConfig;
  auditorModel(): AuditorModelRef;
  /** Apply one change; the caller repaints status and journals the config. */
  onChange(apply: (config: GatekeeperConfig) => void, ctx: ExtensionContext): void;
}

export async function showSettings(ctx: ExtensionCommandContext, deps: SettingsDeps) {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const config = deps.config();
    const items: SettingItem[] = [
      {
        id: "mode",
        label: "Mode",
        currentValue: config.mode,
        values: ["manual", "auto", "danger"],
      },
      {
        id: "askMode",
        label: "Ask mode",
        currentValue: config.askMode,
        values: ["headful", "never"],
      },
    ];

    const auditor = deps.auditorModel();
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Gatekeeper Settings")), 1, 1));
    container.addChild(
      new Text(theme.fg("dim", `Auditor model: ${auditor.provider}/${auditor.modelId}`), 1, 0),
    );

    const settingsList = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        deps.onChange((current) => {
          if (id === "mode" && isPermissionMode(newValue)) current.mode = newValue;
          else if (id === "askMode" && isAskMode(newValue)) current.askMode = newValue;
        }, ctx);
      },
      () => done(undefined),
    );
    container.addChild(settingsList);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
