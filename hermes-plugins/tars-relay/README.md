# tars-relay, a Hermes plugin

Tars writes to its user through the Telegram bot of his own Hermes, and gets back what he answers. The plugin
runs inside Hermes, on the server where Hermes runs, never in Tars.

- **Out.** Tars calls `POST /send` on the Hermes dashboard. The text goes, as written and in plain text, to the
  one Telegram user named in the plugin's settings on the server. Tars cannot name anybody else.
- **Back.** A message from that user in his private chat with the bot is kept for Tars, and never reaches
  Hermes's model, when it replies to a message the relay sent (same chat, same message id) or starts with
  `@project`. Tars reads them with `GET /replies` and deletes what it took with `POST /ack`. Every other message
  goes to Hermes as usual.
- **The model's copy.** Hermes's model gets a read-only copy of what Tars sent, attached once to the user's next
  turn in that same private chat and marked as Tars's, so that he can ask Hermes about it. The model can neither
  act on it nor answer it for him: an answer reaches Tars only when he replies on Telegram himself.

Why a plugin rather than the model: whoever relays the user's words decides where they go. A model can be talked
into "answering" in his name, by a PR title or an error message written for that. The plugin only moves real
Telegram messages from him.

## Install on the Hermes server

Install it together with the Tars release that reads it, and once Tars keeps the dashboard token in
`~/.tars-private` (SECURITY.md, section 5). Before that, a message of yours that starts with `@word` would be kept
for a Tars that does not read it yet: it waits a week, then it is deleted.

From a checkout of this repository, at the tag of that release:

```bash
scp -r hermes-plugins/tars-relay <server>:~/.hermes/plugins/tars-relay
ssh <server>
hermes plugins validate ~/.hermes/plugins/tars-relay      # Hermes's own checks: manifest, hooks, security scan
hermes plugins enable tars-relay
```

Then, in `~/.hermes/config.yaml`, your Telegram user id (the one in `TELEGRAM_ALLOWED_USERS`):

```yaml
plugins:
  entries:
    tars-relay:
      settings:
        user_id: 123456789
```

Restart both the gateway and the dashboard: each loads its half of the plugin when it starts. Then, from the Mac,
through the tunnel Tars already uses:

```bash
curl -s -H "X-Hermes-Session-Token: $TOKEN" http://127.0.0.1:9119/api/plugins/tars-relay/status
# {"plugin": "tars-relay", "version": "1.0.0", "configured": true, "sends_last_hour": 0, "waiting_replies": 0}
```

`"configured": false` means the user id is missing or is not a positive number: nothing is sent or kept then.

To remove it: `hermes plugins disable tars-relay`, restart both, and delete `~/.hermes/plugins/tars-relay`. Its
store is `~/.hermes/plugin-data/tars-relay/relay.db`.

## Routes

Under `/api/plugins/tars-relay/` on the dashboard, behind its session token like every dashboard route.

| Route | Body | Answer |
|---|---|---|
| `GET /status` | | `configured`, `sends_last_hour`, `waiting_replies` |
| `POST /send` | `{text, kind, ref?, project?}`: `kind` is `question`, `report` or `sentry`; `ref` up to 200 printable characters, no spaces; `project` one word | `{message_id}`. 400 for a request it refuses, 503 with no user id, 429 past 60 sends in an hour, 502 when Telegram does not take it |
| `GET /replies?after=N` | | `{replies: [...]}`, oldest first, from after `seq` N, at most 100: `seq`, `kind` (`reply` or `project`), `ref` and `project` (of the message replied to, or the `@project` name), `text`, the ids |
| `POST /ack` | `{through: N}` | `{deleted}`: every reply up to `seq` N |

A text longer than Telegram takes (4096 UTF-16 units, an emoji counts two) is refused, not cut.

## What it keeps

`relay.db` (SQLite: the gateway and the dashboard are two processes), in a folder only its owner can open, the
file `0600`:

- what was sent: chat, message id, kind, ref and project, for 30 days, so a late reply still reaches Tars. A reply
  to anything older goes to Hermes like any message;
- the text of what was sent, until the model has had its copy, or 7 days;
- the replies, until Tars takes them, or 7 days.

Deleted rows are overwritten (`secure_delete`), and the default rollback journal is used rather than a
write-ahead log, so a text once copied or taken is not left in the file.

## Limits

- Text only. A photo, a voice note or a sticker sent in reply to Tars goes to Hermes, as any message does.
- No acknowledgement in Telegram: a reply kept for Tars gets no answer from Hermes. Tars says when it has passed
  it on.
- Hermes merges the messages of one chat that arrive within a fraction of a second of each other, as Telegram does
  with a long text it splits in two. The merged message is kept or let through whole, on its first part: a reply
  to Tars followed at once by another message goes to Tars in full.

## Tests

- `python3 -m unittest discover -s tests`, from this folder: the rules, without Hermes, failure modes first. The
  repo's `npm test` runs them too (`__tests__/hermes-plugins/tars-relay.test.ts`), and fails without `python3`.
- End to end, Hermes's own gateway and dashboard run the plugin in a sandbox, with a fake Telegram and a fake model:
  sends, replies, the `@project` prefix, the model's copy, a stranger the allowlist lets through, a group, the store.
  That bench lives outside the repo, beside the design it proves.
