// Garde de couverture : le manifeste E2E (surfaces.mjs) doit couvrir
// l'inventaire du redesign (design/UI-INVENTORY.md).
// - Pages de l'inventaire absentes du manifeste → ÉCHEC (exit 1)
// - Overlays/menus de l'inventaire pas encore automatisés → rapport (visible,
//   jamais silencieux), à réduire au fil du redesign.
//
// Les deux comptes sont LUS dans l'inventaire, jamais recopiés ici, et un
// compte nul est un échec. Ce garde a passé des semaines à féliciter : sa
// recherche d'overlays visait un format de cases à cocher que l'inventaire
// n'utilise plus, elle rendait zéro ligne, et zéro chose à vérifier se lisait
// comme rien à signaler. La liste des routes était écrite à la main juste à
// côté, dix entrées pour quinze pages, donc /chat, /crons, /review, /logs et
// /tray-panel n'étaient contrôlés par personne. Un garde qui ne trouve rien à
// vérifier doit crier.
import { readFileSync } from 'fs';
import { PAGES, SETTINGS_SECTIONS, OVERLAYS, ALL } from './surfaces.mjs';

const inventory = readFileSync(new URL('../design/UI-INVENTORY.md', import.meta.url), 'utf-8');

/** Les pages routées : première colonne du tableau Pages de l'inventaire. */
const inventoryRoutes = [...inventory.matchAll(/^\|\s*`(\/[^`]*)`\s*\|/gm)].map(m => m[1]);

/** Le nombre d'overlays que l'inventaire déclare dans son propre titre. */
const overlayHeading = inventory.match(/^##\s+Overlays and dialogs\s+\((\d+)\)/m);
const inventoryOverlayCount = overlayHeading ? Number(overlayHeading[1]) : 0;

// Rien lu veut dire que l'inventaire a changé de forme, pas que tout va bien.
if (inventoryRoutes.length === 0) {
  console.error('ÉCHEC — aucune page lue dans design/UI-INVENTORY.md.');
  console.error("  Le tableau Pages a changé de forme et ce garde ne vérifie plus rien.");
  console.error('  Attendu des lignes `| `/route` | Nom | Frame |`.');
  process.exit(1);
}
if (inventoryOverlayCount === 0) {
  console.error("ÉCHEC — aucun overlay compté dans design/UI-INVENTORY.md.");
  console.error("  Attendu un titre `## Overlays and dialogs (N)` avec N supérieur à zéro.");
  process.exit(1);
}

const covered = new Set(ALL.map(s => s.route));
const missingPages = inventoryRoutes.filter(route => !covered.has(route));

console.log(`Pages de l'inventaire : ${inventoryRoutes.length}`);
console.log(`Pages du manifeste E2E : ${PAGES.length} (+${SETTINGS_SECTIONS.length} sections settings)`);
console.log(`Overlays automatisés : ${OVERLAYS.length} / ${inventoryOverlayCount} déclarés dans l'inventaire`);
console.log('');

if (missingPages.length > 0) {
  console.error("ÉCHEC — pages de l'inventaire absentes du manifeste E2E :");
  for (const route of missingPages) console.error(`  - ${route}`);
  process.exit(1);
}

const notAutomated = inventoryOverlayCount - OVERLAYS.length;
if (notAutomated > 0) {
  console.log(`À automatiser au fil du redesign : ${notAutomated} surfaces d'overlay/menu.`);
  console.log("  Elles sont décrites sous « Overlays and dialogs » dans l'inventaire.");
}

console.log('\nCouverture pages : OK ✓');
