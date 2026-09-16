/**
 * tabs.ts — OXIS tab management
 */

import { events } from "./events";

export interface Tab {
  id: string;
  isHome?: boolean;
  label?: string;
}

const MAX_TABS = 9;
let _tc = 0;

export function mkTab(label?: string): Tab {
  return { id: `t${_tc++}`, label };
}

export const HOME_TAB: Tab = { id: "__home__", isHome: true };

export function canAddTab(tabs: Tab[]): boolean {
  return tabs.filter(t => !t.isHome).length < MAX_TABS;
}

export function addTab(tabs: Tab[]): Tab[] {
  if (!canAddTab(tabs)) return tabs;
  const t = mkTab();
  events.emit("tab_created", { id: t.id });
  return [...tabs, t];
}

export function removeTab(tabs: Tab[], id: string): Tab[] {
  events.emit("tab_closed", { id });
  return tabs.filter(t => t.id !== id);
}

export function resolveActiveTab(tabs: Tab[], active: string): string {
  if (tabs.find(t => t.id === active)) return active;
  const rest = tabs.filter(t => !t.isHome);
  return rest.length ? rest[rest.length - 1].id : "__home__";
}

export { MAX_TABS };
