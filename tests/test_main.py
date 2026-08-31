from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_dotenv_is_loaded_before_bot_modules(tmp_path: Path):
    database_url = "postgresql://postgres:postgres@localhost:5432/fortnite_test"
    (tmp_path / ".env").write_text(f"DATABASE_URL={database_url}\nFORTNITE_API_KEY=dotenv-key\n")
    env = os.environ.copy()
    env.pop("DATABASE_URL", None)
    env.pop("FORTNITE_API_KEY", None)
    repo_root = Path(__file__).parents[1]
    env["PYTHONPATH"] = str(repo_root)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import bot.__main__; from bot import db, fortnite; print(db.DATABASE_URL); print(fortnite.API_KEY)",
        ],
        cwd=tmp_path,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.splitlines() == [database_url, "dotenv-key"]
