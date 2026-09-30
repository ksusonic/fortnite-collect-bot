from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram.filters import CommandObject
from aiogram.types import MessageEntity

from bot.db import Session, get_fort_title, load_session, save_session
from bot.handlers import cmd_fortemoji
from bot.messages import build_cancelled_text, build_expired_text, build_gather_text


def make_message(status="administrator", valid_pack=True):
    ids = ["101", "102", "103", "104"]
    entities = [
        MessageEntity(type="custom_emoji", offset=offset, length=length, custom_emoji_id=emoji_id)
        for offset, length, emoji_id in zip([0, 2, 3, 5], [2, 1, 2, 2], ids, strict=True)
    ]
    return SimpleNamespace(
        from_user=SimpleNamespace(id=1),
        chat=SimpleNamespace(id=-100),
        reply_to_message=SimpleNamespace(text="🔡⭕🔡🔡", caption=None, entities=entities, caption_entities=None),
        reply=AsyncMock(),
        bot=SimpleNamespace(
            get_chat_member=AsyncMock(return_value=SimpleNamespace(status=status)),
            get_sticker_set=AsyncMock(
                return_value=SimpleNamespace(
                    stickers=[SimpleNamespace(custom_emoji_id=emoji_id) for emoji_id in (ids if valid_pack else [])]
                )
            ),
        ),
    )


async def test_title_survives_restart_and_all_gathering_states(tmp_db):
    message = make_message()
    await cmd_fortemoji(message, CommandObject(command="fortemoji"))
    title = await get_fort_title(-100)
    assert title == (
        '<tg-emoji emoji-id="101">🔡</tg-emoji><tg-emoji emoji-id="102">⭕</tg-emoji>'
        '<tg-emoji emoji-id="103">🔡</tg-emoji><tg-emoji emoji-id="104">🔡</tg-emoji>'
    )
    session = Session(chat_id=-100, message_id=1, initiator_id=1, initiator_name="Host", fort_title=title)
    await save_session(session)
    restored = await load_session(1)
    for builder in (build_gather_text, build_expired_text, build_cancelled_text):
        assert builder(restored).startswith(title + "\n")
    restored.go_players = {i: f"Player {i}" for i in range(5)}
    text = build_gather_text(restored)
    assert text.startswith(title + "\n")
    assert text.index("Player 3") < text.index("Резерв") < text.index("Player 4")
    await cmd_fortemoji(message, CommandObject(command="fortemoji", args="off"))
    assert await get_fort_title(-100) is None


@pytest.mark.parametrize("status,valid_pack", [("member", True), ("administrator", False)])
async def test_rejects_non_admin_or_wrong_pack(tmp_db, status, valid_pack):
    message = make_message(status=status, valid_pack=valid_pack)
    await cmd_fortemoji(message, CommandObject(command="fortemoji"))
    assert await get_fort_title(-100) is None
