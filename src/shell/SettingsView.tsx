import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import type { ThemePreference } from "../types";

const THEMES: { id: ThemePreference; label: string; icon: ReactNode }[] = [
  { id: "system", label: "System", icon: <Monitor width={16} height={16} aria-hidden="true" /> },
  { id: "light", label: "Light", icon: <Sun width={16} height={16} aria-hidden="true" /> },
  { id: "dark", label: "Dark", icon: <Moon width={16} height={16} aria-hidden="true" /> },
];

export interface SettingsViewProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  coreVersion: string | null;
}

/** App settings. Only appearance exists for now; profiles and tools follow in M1. */
export function SettingsView({ theme, onThemeChange, coreVersion }: SettingsViewProps) {
  return (
    <div className="section-view">
      <header className="view-header">
        <div className="view-header-main">
          <h2 className="view-title">Settings</h2>
        </div>
      </header>
      <div className="settings-body">
        <section className="settings-group" aria-labelledby="settings-appearance">
          <h3 id="settings-appearance" className="section-heading">
            Appearance
          </h3>
          <fieldset className="segmented">
            <legend className="settings-label">Theme</legend>
            <div className="segmented-options">
              {THEMES.map((option) => (
                <label
                  key={option.id}
                  className={cx("segmented-option", theme === option.id && "is-selected")}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={option.id}
                    checked={theme === option.id}
                    onChange={() => {
                      onThemeChange(option.id);
                    }}
                  />
                  {option.icon}
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="settings-help">System follows the light or dark setting of your operating system.</p>
        </section>
        <section className="settings-group" aria-labelledby="settings-about">
          <h3 id="settings-about" className="section-heading">
            About
          </h3>
          <dl className="settings-list">
            <div>
              <dt>Core version</dt>
              <dd>{coreVersion ?? "Not connected"}</dd>
            </div>
            <div>
              <dt>Licence</dt>
              <dd>MIT</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
