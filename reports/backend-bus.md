# Bus d'agents v1

Branche `feat/agent-bus`, sept commits, 19 fichiers, pas de PR.

**Les cinq commits demandés, dans l'ordre.** (1) Le contrat visible: types, canaux du
preload, miroir `src/types/electron.d.ts`, cinq appels et trois abonnements. (2) Le modèle
et le journal `~/.dorothy/bus.json`, écriture atomique. (3) `agent-watch` généralisé: une
seule file, pas une deuxième à côté, et ses 18 assertions passent toujours. (4) `room_post`
et `room_read` dans `mcp-orchestrator`, bornes côté serveur, `send_message` intact.
(5) Les états de livraison et le refus structuré.

**Vérifié dans l'application**, build empaqueté de la branche, bac à sable `~/Tars-sandbox`
sur le port 31499, projet `tars-hermes` uniquement. Ton app n'a pas été redémarrée.

- deux agents se répondent, rotation appliquée: `self_reply`, `not_your_turn`, et un
  marqueur de silence refusé sans rien coûter au fil;
- intervention humaine au milieu: l'ancre passe en `superseded`, ses deux livraisons en
  attente tombent en `dropped/thread_replaced`, aucun PTY tué, aucun `lastKilledSessionId`;
- Stop: trois livraisons en `dropped/thread_stopped`;
- un membre ajouté puis retiré (6, 2, 3, 2), l'ancre en vol fermée avec `members_changed`;
- refus bruyants: 403 sans identité, 403 sur la salle globale, 401 sans jeton;
- journal relu sur disque: 4 fils, 15 messages, 23 livraisons, dont 6 `delivered` vraiment
  écrites dans un terminal.

**Un défaut trouvé par ce passage, corrigé au 7e commit.** `currentRound` n'avance que
lorsqu'un agent déjà entendu reparle, et la garde refusait exactement ce message. Le tour
restait donc bloqué à 1, `MAX_ROUNDS` était du code mort, et dans une salle de moins de dix
agents, c'est-à-dire toutes, un fil n'atteignait jamais `bounded`: il refusait tout le monde
sans état que l'interface puisse montrer. Un tour se gagne maintenant en étant nommé depuis
son propre dernier message. Après correction, le passage donne 1, 2, 3 puis `bounded` seul.

**Limite assumée.** Le HOME du bac à sable n'est pas connecté, et le `/login` est à toi. Les
messages d'agents sont donc passés par la porte même de `room_post`, avec leur identité et
toutes les bornes du serveur, mais le texte est de moi: aucun agent n'a rédigé sa réponse.

Checks: tsc main 0, tsc renderer 0, lint 0 erreur (140 avertissements préexistants dans
`src/`), 1508 tests sur 103 fichiers. Changelog dans la 1.6.19, SPECS et OPERATIONS à jour.
