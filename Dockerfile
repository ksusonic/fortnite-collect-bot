FROM python:3.14-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY CHANGELOG.md ./
COPY bot/ bot/

CMD ["uv", "run", "--no-sync", "python", "-m", "bot"]
