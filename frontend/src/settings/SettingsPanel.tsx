/**
 * SettingsPanel.tsx — the Settings window (Ctrl+, or 'settings): every
 * setting 'config knows, grouped, searchable, with a control that fits
 * it (a switch, a list, a number, a slider) and a reset for the ones
 * you've changed. Sound settings pick from the sounds or take a file, and
 * play it. It changes settings through the same setSetting as 'config,
 * so the two always agree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { PRESET_NAMES, SOUND_EVENTS, isSoundFile, playValue } from "../sound/sounds";

export interface PanelSetting {
  key: string;
  label: string;
  description: string;
  default: string | number | boolean;
  choices?: string[];
}

export interface SettingsApi {
  defs: PanelSetting[];
  get: (key: string) => string | number | boolean;
  set: (key: string, value: string) => { ok: boolean; message: string };
  reset: (key: string) => { ok: boolean; message: string };
  isSet: (key: string) => boolean;
  /** Choices found at run time (the shells installed, say), or null. */
  choicesFor?: (key: string) => Promise<string[] | null>;
  /** Opens ~/.oxis/config.lua in the editor. */
  editConfigFile?: () => void;
}

const GROUPS: [string, (key: string) => boolean][] = [
  ["Terminal", k => ["shell", "startIn", "newShellHere", "restoreSession", "promptColors", "copyOnSelect", "notifyAfter", "desktopNotify", "summonKey"].includes(k)],
  ["Appearance", k => ["fontSize", "cursorStyle", "cursorBlink", "homeSky"].includes(k)],
  ["Editor", k => k.startsWith("editor")],
  ["Sounds", k => k === "sounds" || k.startsWith("sound")],
  ["Plugins and updates", k => ["luaEngine", "countInstalls", "updateCheckOnStartup"].includes(k)],
];
const groupOf = (key: string) => GROUPS.find(([, has]) => has(key))?.[0] ?? "Other";

const soundSetting = (key: string) => SOUND_EVENTS.some(e => e.setting === key);

function SettingControl({ def, api, onChange }: { def: PanelSetting; api: SettingsApi; onChange: (msg: string, ok: boolean) => void }) {
  const value = api.get(def.key);
  const commit = (v: string) => {
    if (v === String(value)) return;
    const r = api.set(def.key, v);
    onChange(r.ok ? "" : r.message, r.ok);
  };
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const [found, setFound] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void api.choicesFor?.(def.key).then(c => { if (live && c?.length) setFound(c); }).catch(() => {});
    return () => { live = false; };
  }, [api, def.key]);

  if (typeof def.default === "boolean") {
    const on = value === true;
    return (
      <button className={`set-switch${on ? " set-switch--on" : ""}`} role="switch" aria-checked={on}
        onClick={() => commit(on ? "false" : "true")}>
        <span className="set-switch-knob" />
      </button>
    );
  }
  const choices = def.choices ?? found;
  if (choices) {
    const list = choices.includes(String(value)) ? choices : [String(value), ...choices];
    return (
      <select className="set-select" value={String(value)} onChange={e => commit(e.target.value)}>
        {list.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  }
  if (def.key === "soundVolume") {
    return (
      <span className="set-range">
        <input type="range" min={0} max={100} step={5} value={Number(draft) || 0}
          onChange={e => setDraft(e.target.value)}
          onMouseUp={() => { commit(draft); void playValue("ping").catch(() => {}); }}
          onKeyUp={() => commit(draft)} />
        <span className="set-range-value">{draft}</span>
      </span>
    );
  }
  if (soundSetting(def.key)) {
    const v = String(value);
    const custom = isSoundFile(v);
    return (
      <span className="set-sound">
        <select className="set-select" value={custom ? "__file" : v}
          onChange={e => { if (e.target.value !== "__file") { commit(e.target.value); void playValue(e.target.value).catch(() => {}); } else setDraft(""); }}>
          {PRESET_NAMES.map(n => <option key={n} value={n}>{n}</option>)}
          <option value="__file">a sound file…</option>
        </select>
        {(custom || draft === "") && (
          <input className="set-input" placeholder="C:\sounds\done.wav" value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={() => { if (draft.trim()) { commit(draft.trim()); void playValue(draft.trim()).catch(err => onChange(`can't play it: ${err instanceof Error ? err.message : err}`, false)); } }} />
        )}
        <button className="set-play" title="Play it" onClick={() => void playValue(v).catch(err => onChange(`can't play it: ${err instanceof Error ? err.message : err}`, false))}>▶</button>
      </span>
    );
  }
  const numeric = typeof def.default === "number";
  return (
    <input className={`set-input${numeric ? " set-input--number" : ""}`} type={numeric ? "number" : "text"} value={draft}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(String(value)); }}
      onBlur={() => commit(draft)} />
  );
}

export function SettingsPanel({ api, onClose, initialQuery = "" }: { api: SettingsApi; onClose: () => void; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [, bump] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => searchRef.current?.focus(), 20); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = api.defs.filter(d => !q || `${d.key} ${d.label} ${d.description}`.toLowerCase().includes(q));
    const out = new Map<string, PanelSetting[]>();
    for (const [name] of GROUPS) out.set(name, []);
    out.set("Other", []);
    for (const d of shown) out.get(groupOf(d.key))!.push(d);
    return [...out].filter(([, list]) => list.length);
  }, [api.defs, query]);

  const note = (key: string) => (msg: string, ok: boolean) => { setNotes(n => ({ ...n, [key]: ok ? "" : msg })); bump(x => x + 1); };

  return (
    <div className="cmdp-backdrop set-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="set-panel" role="dialog" aria-label="Settings">
        <div className="set-head">
          <span className="set-title">Settings</span>
          <input ref={searchRef} className="set-search" placeholder="Search settings…" value={query} onChange={e => setQuery(e.target.value)} />
          <button className="set-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="set-body">
          {groups.length === 0 && <div className="cmdp-empty">no setting matches “{query}”</div>}
          {groups.map(([name, list]) => (
            <section key={name} className="set-group">
              <h3 className="set-group-name">{name}</h3>
              {list.map(def => (
                <div key={def.key} className="set-row">
                  <div className="set-text">
                    <div className="set-label">{def.label}<code className="set-key">{def.key}</code></div>
                    <div className="set-desc">{def.description}</div>
                    {notes[def.key] && <div className="set-error">{notes[def.key]}</div>}
                  </div>
                  <div className="set-control">
                    <SettingControl def={def} api={api} onChange={note(def.key)} />
                    {api.isSet(def.key) && String(api.get(def.key)) !== String(def.default) && (
                      <button className="set-reset" title={`Back to ${String(def.default) || "empty"}`}
                        onClick={() => { api.reset(def.key); note(def.key)("", true); }}>↺</button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="set-foot">
          <span>Changes apply at once. The same settings: <code>'config</code> in the terminal.</span>
          {api.editConfigFile && <button className="set-link" onClick={api.editConfigFile}>Edit config.lua</button>}
        </div>
      </div>
    </div>
  );
}
