"""CLI entrypoint; no polling."""

import bot.config  # noqa: F401
from bot.cli import main

if __name__ == "__main__":
    main()
