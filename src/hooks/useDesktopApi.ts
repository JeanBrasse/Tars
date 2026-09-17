'use client';

import { useSyncExternalStore } from 'react';
import type { ElectronAPI } from '@/types/electron';

/**
 * Is the preload bridge there, asked in a way that survives hydration.
 *
 * `typeof window !== 'undefined' && !!window.electronAPI` read during render
 * answers `false` while the page is being pre-rendered and `true` in the app,
 * so a page that branched on it rendered one tree into the HTML and a different
 * one on the client. React then threw the tree away and built it again
 * ("Hydration failed because the server rendered HTML didn't match the
 * client"), and while rebuilding it re-created the theme `<script>` of
 * `app/layout.tsx`, which is what wrote "Encountered a script tag while
 * rendering React component" to the console on every one of those pages.
 *
 * `useSyncExternalStore` is React's own answer for a value the server cannot
 * know: the third argument is used for the pre-render and for the hydration
 * pass, so both agree, and the real answer lands in the commit right after.
 * Nothing on screen changes: the pre-rendered HTML already carried the
 * fallback, and the app still swaps it for the real page as it hydrates.
 *
 * Effects and callbacks keep using `isElectron()`: they only run on the
 * client, where the two answers are the same.
 */
export function useDesktopApi(part?: (api: ElectronAPI) => unknown): boolean {
  return useSyncExternalStore(subscribe, () => readApi(part), onServer);
}

/** The bridge is installed before the first script runs and never leaves. */
function subscribe(): () => void {
  return () => {};
}

function readApi(part?: (api: ElectronAPI) => unknown): boolean {
  if (typeof window === 'undefined') return false;
  const api = window.electronAPI;
  if (!api) return false;
  return part ? !!part(api) : true;
}

function onServer(): boolean {
  return false;
}
