from __future__ import annotations

import hashlib
import html
import logging
import os

import fortnite_api

from bot.db import get_seen_news_ids, mark_news_seen

logger = logging.getLogger(__name__)

MAX_NEWS = 5
MAX_SHOP_ITEMS = 6


async def fetch_news_digest(chat_id: int) -> tuple[str, str | None] | None:
    api_key = os.getenv("FORTNITE_API_KEY")
    if not api_key:
        return ("<b>Fortnite News</b>\n\nAPI-ключ не настроен. Попросите админа задать FORTNITE_API_KEY.", None)

    client = fortnite_api.Client(api_key=api_key, default_language=fortnite_api.GameLanguage.RUSSIAN)

    try:
        news_br = await client.fetch_news_br()
        shop = await client.fetch_shop()
    except Exception:
        logger.warning("Failed to fetch Fortnite news/shop", exc_info=True)
        return ("<b>Fortnite News</b>\n\nНе удалось получить данные. Попробуйте позже.", None)

    seen = await get_seen_news_ids(chat_id)
    new_ids: list[str] = []
    sections: list[str] = []
    image_url: str | None = None

    # BR news (motds)
    if news_br.motds:
        news_lines: list[str] = []
        news_count = 0
        for motd in news_br.motds:
            if motd.hidden or motd.id in seen:
                continue
            new_ids.append(motd.id)
            news_lines.append(f"<b>{html.escape(motd.title)}</b>")
            if motd.body:
                news_lines.append(html.escape(motd.body))
            news_lines.append("")
            if image_url is None and motd.image:
                image_url = motd.image
            news_count += 1
            if news_count >= MAX_NEWS:
                break
        if news_lines:
            sections.append("\n".join(news_lines).rstrip())

    # Shop
    if shop.entries:
        shop_hash = f"shop:{hashlib.md5(shop.hash.encode()).hexdigest()[:12]}" if shop.hash else None
        if shop_hash and shop_hash not in seen:
            shop_lines: list[str] = []
            count = 0
            for entry in shop.entries:
                if count >= MAX_SHOP_ITEMS:
                    break
                # Get the name from the first BR cosmetic in the entry
                name: str | None = None
                if entry.br:
                    name = entry.br[0].name
                if not name:
                    continue
                price = f"{entry.final_price:,}".replace(",", " ")
                shop_lines.append(f"{html.escape(name)} — {price} V-Bucks")
                count += 1
            if shop_lines:
                sections.append("<b>Магазин предметов</b>\n" + "\n".join(shop_lines))
            if shop_hash:
                new_ids.append(shop_hash)

    if not new_ids:
        return None

    text = "<b>Fortnite News</b>\n\n" + "\n\n".join(sections)
    await mark_news_seen(chat_id, new_ids)
    return (text, image_url)
