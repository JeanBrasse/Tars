"""tars-relay, gateway half.

Two hooks. pre_gateway_dispatch keeps for Tars, and from the model, a message from Noah in his private chat that
replies to a message Tars sent through the relay or starts with "@project". pre_llm_call attaches to Noah's next
turn there a read-only copy of what Tars sent him. The rules are in relay_core.py; this file only reads Hermes's
event and session and answers its hooks.
"""
from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

log = logging.getLogger('tars-relay')


def _load_core():
    # By path, under one name for both halves: a plugin directory is not on sys.path, and the dashboard half loads
    # the same file.
    name = 'tars_relay_core'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().with_name('relay_core.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules[name] = module
    return sys.modules[name]


core = _load_core()
_stores = {}


def _store():
    """The store of the active Hermes profile, in its plugin-data folder, where Hermes keeps a plugin's state."""
    from hermes_constants import get_hermes_home
    directory = str(Path(get_hermes_home()) / 'plugin-data' / core.PLUGIN_ID)
    if directory not in _stores:
        _stores[directory] = core.Store(directory)
    return _stores[directory]


def _settings():
    from hermes_cli.config import load_config_readonly
    return core.settings_from_config(load_config_readonly())


def _message_of(event) -> dict:
    source = getattr(event, 'source', None)
    platform = getattr(source, 'platform', None)
    return {
        'platform': getattr(platform, 'value', platform),
        'chat_type': getattr(source, 'chat_type', None),
        'chat_id': getattr(source, 'chat_id', None),
        'user_id': getattr(source, 'user_id', None),
        'message_id': getattr(event, 'message_id', None),
        'reply_to_message_id': getattr(event, 'reply_to_message_id', None),
        'text': getattr(event, 'text', None),
    }


def on_gateway_dispatch(event=None, **_):
    try:
        store = _store()
        kept = core.decide(_message_of(event), _settings(), store)
        if kept is None:
            return None
        store.record_reply(kept)
    except Exception:
        # The message goes on to Hermes rather than nowhere: Hermes answers it, so Noah sees it did not reach Tars.
        log.exception('tars-relay: could not keep a message for Tars; it goes on to Hermes')
        return None
    log.info('tars-relay: kept a %s for Tars (message %s)', kept['kind'], kept['message_id'])
    return {'action': 'skip', 'reason': 'tars-relay: kept for Tars'}


def on_llm_call(**_):
    # Who this turn is with comes from the session the gateway binds for the turn, never from the hook's arguments:
    # a turn with no bound session (the CLI, cron, a webhook) gets no copy.
    try:
        from gateway.session_context import get_session_env
        turn = {
            'platform': get_session_env('HERMES_SESSION_PLATFORM', ''),
            'chat_type': get_session_env('HERMES_SESSION_CHAT_TYPE', ''),
            'chat_id': get_session_env('HERMES_SESSION_CHAT_ID', ''),
            'user_id': get_session_env('HERMES_SESSION_USER_ID', ''),
        }
        block = core.copy_for_turn(turn, _settings(), _store())
    except Exception:
        log.exception('tars-relay: no copy of Tars\'s messages for this turn')
        return None
    return {'context': block} if block else None


def register(ctx):
    ctx.register_hook('pre_gateway_dispatch', on_gateway_dispatch)
    ctx.register_hook('pre_llm_call', on_llm_call)
