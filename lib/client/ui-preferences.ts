"use client";

import { useCallback, useSyncExternalStore } from "react";

const changeEvent = "portfolio-ui-preference-change";
const memory = new Map<string, boolean>();

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null) memory.clear();
    else memory.delete(event.key);
    notify();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changeEvent, notify);
  };
}

const serverSnapshot = () => false;

// Only display preferences belong here, never balances or account data.
export function useUiPreference(name: string) {
  const key = `portfolio:ui:v1:${name}`;
  const getSnapshot = useCallback(() => {
    if (memory.has(key)) return memory.get(key) ?? false;
    try {
      const saved = window.localStorage.getItem(key);
      if (saved !== null) return saved === "true";
    } catch {
      // Restricted storage must not make navigation unusable.
    }
    return false;
  }, [key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  const setValue = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(key, String(next));
      memory.delete(key);
    } catch {
      // Retain the preference for this page session when storage is disabled.
      memory.set(key, next);
    }
    window.dispatchEvent(new Event(changeEvent));
  }, [key]);
  return [value, setValue] as const;
}
