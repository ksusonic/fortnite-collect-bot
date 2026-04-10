from __future__ import annotations

import hashlib
import html
import logging
import os

import fortnite_api

from bot.db import get_seen_news_ids, mark_news_seen

logger = logging.getLogger(__name__)

MAX_SHOP_ITEMS = 10


def _entry_image_url(entry: fortnite_api.ShopEntry) -> str | None:
    """Extract the best available image URL from a shop entry."""
    if entry.new_display_asset and entry.new_display_asset.render_images:
        return entry.new_display_asset.render_images[0].image.url
    if entry.br:
        imgs = entry.br[0].images
        if imgs:
            if imgs.featured:
                return imgs.featured.url
            if imgs.icon:
                return imgs.icon.url
    return None


async def fetch_news_digest(chat_id: int) -> tuple[str, list[str]] | None:
    api_key = os.getenv("FORTNITE_API_KEY")
    if not api_key:
        return ("<b>Магазин предметов</b>\n\nAPI-ключ не настроен. Попросите админа задать FORTNITE_API_KEY.", [])

    try:
        async with fortnite_api.Client(api_key=api_key, default_language=fortnite_api.GameLanguage.RUSSIAN) as client:
            shop = await client.fetch_shop()
    except Exception:
        logger.warning("Failed to fetch Fortnite shop", exc_info=True)
        return ("<b>Магазин предметов</b>\n\nНе удалось получить данные. Попробуйте позже.", [])

    if not shop.entries:
        return None

    seen = await get_seen_news_ids(chat_id)
    shop_hash = f"shop:{hashlib.md5(shop.hash.encode()).hexdigest()[:12]}" if shop.hash else None
    if shop_hash and shop_hash in seen:
        return None

    shop_lines: list[str] = []
    image_urls: list[str] = []
    count = 0
    for entry in shop.entries:
        if count >= MAX_SHOP_ITEMS:
            break
        name: str | None = None
        if entry.br:
            name = entry.br[0].name
        if not name:
            continue
        price = f"{entry.final_price:,}".replace(",", " ")
        shop_lines.append(f"{html.escape(name)} — {price} V-Bucks")
        img = _entry_image_url(entry)
        if img:
            image_urls.append(img)
        count += 1

    if not shop_lines:
        return None

    text = "<b>Магазин предметов</b>\n" + "\n".join(shop_lines)
    if shop_hash:
        await mark_news_seen(chat_id, [shop_hash])
    return (text, image_urls)
