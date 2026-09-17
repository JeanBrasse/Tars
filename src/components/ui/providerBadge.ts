/**
 * The colour a provider's name badge is written in.
 *
 * Vendor colours, the same exception `DESIGN.md` already makes for the vendor
 * marks themselves, and raw Tailwind palette classes. They live here because
 * `src/components/ui/` is the one place allowed to define raw appearance:
 * `src/lib/providers.ts` says what a provider is (id, label, mark, models), not
 * how it is painted. Moved, not repainted: every class below is the one that
 * provider already carried.
 *
 * The design draws a provider as a neutral chip beside the agent's name
 * (`Agents · dark`, and `MetaChip` in `DESIGN.md`), so these coloured badges
 * are left in two places only: the Brain project list and the agent detail
 * panel. Whether they survive at all is a design decision, not a lint one.
 */
const PROVIDER_BADGE_CLASS: Record<string, string> = {
  'claude': 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  'codex': 'bg-green-500/15 text-green-600 dark:text-green-400',
  'gemini': 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  'grok': 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-300',
  'opencode': 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
  'amp': 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
  'pi': 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
  'openrouter': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  'deepseek': 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  'moonshot': 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  'mimo': 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  'qwen': 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  'zhipu': 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  'minimax': 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  'nvidia': 'bg-green-500/15 text-green-600 dark:text-green-400',
  'nous-portal': 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
  'ollama': 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-300',
  'venice': 'bg-pink-500/15 text-pink-600 dark:text-pink-400',
  'ollama-cloud': 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-300',
  'custom-openai': 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-300',
};

/** The badge classes for a provider, or `fallback` when it has none. */
export function providerBadgeClass(providerId: string | undefined, fallback: string): string {
  return (providerId && PROVIDER_BADGE_CLASS[providerId]) || fallback;
}
