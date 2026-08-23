import { create } from 'zustand';

/**
 * The small amount of UI state that is genuinely global.
 *
 * This file used to be 436 lines: a full in-memory domain model - agents,
 * tasks, projects, skills, entities, chats, their CRUD actions and four
 * selectors - seeded with sample data ("E-Commerce Platform", "Dashboard
 * Analytics", eight invented skills). None of it was ever read. Every
 * `useStore()` call site in the app destructures from the eight members below,
 * and the real data comes from IPC hooks in `src/hooks/`, not from here.
 *
 * The sample data shipped in the bundle, which is the part worth avoiding: a
 * store seeded with fake projects is one wrong selector away from showing them
 * to a user.
 *
 * Keep this file small. State that belongs to one screen belongs in that
 * screen; state that comes from the main process belongs in a hook over IPC.
 */
interface UiState {
  /** Mobile drawer. The desktop sidebar is always open. */
  mobileMenuOpen: boolean;
  /** Dark is the launch default; ClientLayout persists this to `tars-theme`. */
  darkMode: boolean;
  /** Badge on the Vault nav row, kept live by a main-process event so it is
   *  correct even when VaultView is not mounted. */
  vaultUnreadCount: number;

  setMobileMenuOpen: (open: boolean) => void;
  toggleMobileMenu: () => void;
  setDarkMode: (dark: boolean) => void;
  toggleDarkMode: () => void;
  setVaultUnreadCount: (count: number) => void;
}

export const useStore = create<UiState>((set) => ({
  mobileMenuOpen: false,
  darkMode: true,
  vaultUnreadCount: 0,

  setMobileMenuOpen: (open) => set({ mobileMenuOpen: open }),
  toggleMobileMenu: () => set((state) => ({ mobileMenuOpen: !state.mobileMenuOpen })),
  setDarkMode: (dark) => set({ darkMode: dark }),
  toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
  setVaultUnreadCount: (count) => set({ vaultUnreadCount: count }),
}));
