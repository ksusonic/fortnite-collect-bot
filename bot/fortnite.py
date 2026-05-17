from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass

import aiohttp
import fortnite_api
from fortnite_api import StatsImageType, TimeWindow
from fortnite_api.errors import Forbidden, FortniteAPIException, NotFound, RateLimited

logger = logging.getLogger(__name__)

API_KEY = os.getenv("FORTNITE_API_KEY", "")
STATS_TTL_SEC = int(os.getenv("FORTNITE_STATS_TTL_SEC", "600"))
REQUEST_TIMEOUT = int(os.getenv("FORTNITE_REQUEST_TIMEOUT", "15"))


class FortniteError(Exception):
    pass


class EpicNameNotFound(FortniteError):
    pass


class StatsPrivate(FortniteError):
    pass


class FortniteUnavailable(FortniteError):
    pass


class StatsEmpty(FortniteError):
    """Epic account exists but has 0 matches in the requested time window."""

    def __init__(self, *, epic_account_id: str, epic_name: str) -> None:
        super().__init__(f"no stats for {epic_name} in current season")
        self.epic_account_id = epic_account_id
        self.epic_name = epic_name


@dataclass(frozen=True)
class ModeStats:
    matches: int
    wins: int
    kills: int
    kd: float
    win_rate: float
    minutes_played: int


@dataclass(frozen=True)
class PlayerStats:
    epic_account_id: str
    epic_name: str
    overall: ModeStats
    solo: ModeStats | None
    duo: ModeStats | None
    squad: ModeStats | None
    fetched_at: float
    image_url: str | None = None


_client: fortnite_api.Client | None = None
_client_lock = asyncio.Lock()
_stats_cache: dict[tuple[str, bool], tuple[float, PlayerStats]] = {}
# Cache locks are keyed either by (account_id, with_image) tuple
# (for account_id lookups) or by the string "name:<lower>" (for name lookups,
# which are not cached but still coalesced).
_stats_locks: dict[tuple[str, bool] | str, asyncio.Lock] = {}


def is_configured() -> bool:
    return bool(API_KEY)


async def _get_client() -> fortnite_api.Client:
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            _client = fortnite_api.Client(api_key=API_KEY, session=aiohttp.ClientSession())
        return _client


async def close() -> None:
    global _client
    if _client is None:
        return
    try:
        await _client.http.close()
    except Exception:
        logger.warning("fortnite client close failed", exc_info=True)
    _client = None


def _to_mode(stats: fortnite_api.BrGameModeStats | None) -> ModeStats | None:
    if stats is None or stats.matches == 0:
        return None
    return ModeStats(
        matches=stats.matches,
        wins=stats.wins,
        kills=stats.kills,
        kd=stats.kd,
        win_rate=stats.win_rate,
        minutes_played=stats.minutes_played,
    )


def _to_player_stats(raw: fortnite_api.BrPlayerStats, *, with_image: bool) -> PlayerStats:
    inputs_all = raw.inputs and raw.inputs.all
    if inputs_all is None or inputs_all.overall is None or inputs_all.overall.matches == 0:
        raise StatsEmpty(epic_account_id=raw.user.id, epic_name=raw.user.name)
    overall = ModeStats(
        matches=inputs_all.overall.matches,
        wins=inputs_all.overall.wins,
        kills=inputs_all.overall.kills,
        kd=inputs_all.overall.kd,
        win_rate=inputs_all.overall.win_rate,
        minutes_played=inputs_all.overall.minutes_played,
    )
    image_url = raw.image.url if (with_image and raw.image is not None) else None
    return PlayerStats(
        epic_account_id=raw.user.id,
        epic_name=raw.user.name,
        overall=overall,
        solo=_to_mode(inputs_all.solo),
        duo=_to_mode(inputs_all.duo),
        squad=_to_mode(inputs_all.squad),
        fetched_at=time.time(),
        image_url=image_url,
    )


async def _call_sdk(
    *,
    name: str | None,
    account_id: str | None,
    with_image: bool,
) -> fortnite_api.BrPlayerStats:
    client = await _get_client()
    return await asyncio.wait_for(
        client.fetch_br_stats(
            name=name,
            account_id=account_id,
            time_window=TimeWindow.SEASON,
            image=StatsImageType.ALL if with_image else StatsImageType.NONE,
        ),
        timeout=REQUEST_TIMEOUT,
    )


async def fetch_stats(
    *,
    name: str | None = None,
    account_id: str | None = None,
    with_image: bool = False,
) -> PlayerStats:
    if (name is None) == (account_id is None):
        raise ValueError("fetch_stats requires exactly one of name or account_id")

    cache_key: tuple[str, bool] | None = None
    if account_id is not None:
        cache_key = (account_id, with_image)
        cached = _stats_cache.get(cache_key)
        if cached and time.time() - cached[0] < STATS_TTL_SEC:
            return cached[1]

    lock_key: tuple[str, bool] | str = cache_key if cache_key is not None else f"name:{name.lower()}"
    lock = _stats_locks.setdefault(lock_key, asyncio.Lock())
    async with lock:
        if cache_key is not None:
            cached = _stats_cache.get(cache_key)
            if cached and time.time() - cached[0] < STATS_TTL_SEC:
                return cached[1]
        try:
            raw = await _call_sdk(name=name, account_id=account_id, with_image=with_image)
        except NotFound as exc:
            raise EpicNameNotFound(str(exc) or "epic account not found") from exc
        except Forbidden as exc:
            raise StatsPrivate(str(exc) or "stats are private") from exc
        except RateLimited as exc:
            logger.warning("fortnite api rate limited", exc_info=True)
            raise FortniteUnavailable("rate limited") from exc
        except TimeoutError as exc:
            logger.warning("fortnite api timeout", exc_info=True)
            raise FortniteUnavailable("timeout") from exc
        except aiohttp.ClientError as exc:
            logger.warning("fortnite api network error", exc_info=True)
            raise FortniteUnavailable("network error") from exc
        except FortniteAPIException as exc:
            logger.warning("fortnite api error", exc_info=True)
            raise FortniteUnavailable("api error") from exc
        except Exception as exc:
            logger.warning("fortnite api unexpected error", exc_info=True)
            raise FortniteUnavailable("unexpected error") from exc

        stats = _to_player_stats(raw, with_image=with_image)
        _stats_cache[(stats.epic_account_id, with_image)] = (time.time(), stats)
        return stats
