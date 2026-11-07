# syntax=docker/dockerfile:1.7
# motionex: bare motion-graphics tools for AI agents in one image.
# Base images are pinned by digest. To update one:
#   docker buildx imagetools inspect <image:tag>   (take the top-level Digest), then rebuild and run the docker tests.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1.1@sha256:11a44711684c0b9f754c047dcd64235b8b52deab251bd0e0a86f22faa160749c
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0

FROM ${FFMPEG_IMAGE} AS ffmpeg
FROM ${UV_IMAGE} AS uv

# ---- python: uv-managed CPython 3.12 + a venv with piper-tts (hash-checked) ----
FROM ${NODE_IMAGE} AS py
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
COPY py/requirements.txt /tmp/requirements.txt
RUN uv python install 3.12 \
 && uv venv /opt/venv --python 3.12 \
 && uv pip install --python /opt/venv/bin/python --require-hashes --no-deps -r /tmp/requirements.txt \
 && find /opt/python -path '*/lib/python3.12/*' -type d \
      \( -name test -o -name tests -o -name idlelib -o -name tkinter -o -name turtledemo -o -name ensurepip \) \
      -prune -exec rm -rf {} +

# ---- node deps: production modules only, pruned to linux-x64 ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY vendor/mucavex/scripts/prune-modules.sh /tmp/prune-modules.sh
RUN sh /tmp/prune-modules.sh node_modules

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Chromium headless-shell libraries (Playwright's debian12 list, without Xvfb and its CJK/Thai fonts) + fonts we ship.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libasound2 fontconfig libfontconfig1 libfreetype6 \
      libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Chromium headless shell matching the pinned playwright-core (its libraries are installed above).
RUN node node_modules/playwright-core/cli.js install --only-shell chromium \
 && rm -rf /tmp/* /root/.cache
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=py /opt/python /opt/python
COPY --from=py /opt/venv /opt/venv
# The app (filtered by .dockerignore): bin, src, tools, presets, lib, vendor, skill, voices, scripts, package.json.
COPY . /app
RUN printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>/fonts</dir><cachedir>/tmp/.cache/fontconfig</cachedir></fontconfig>\n' \
      > /etc/fonts/conf.d/99-motionex.conf \
 && fc-cache -f \
 && groupadd --gid 10001 motionex \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin motionex \
 && install -d -o 10001 -g 10001 /workspace /cache /cache/samples /scratch /fonts /extensions \
 && printf '#!/bin/sh\nexec node /app/bin/mx.mjs "$@"\n' > /usr/local/bin/mx && chmod 755 /usr/local/bin/mx
ENV NODE_ENV=production \
    MX_PORT=8095 MX_HOST=0.0.0.0 \
    MX_WORKSPACE=/workspace MX_SCRATCH_DIR=/scratch MX_EXTENSIONS_DIR=/extensions \
    MX_SAMPLE_CACHE_DIR=/cache/samples MX_VOICES_DIRS=/app/voices:/voices \
    MX_PYTHON=/opt/venv/bin/python MX_SECRETS_DIR=/run/secrets \
    FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe \
    HOME=/tmp/home XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1 LANG=C.UTF-8
USER 10001:10001
VOLUME ["/cache", "/scratch"]
EXPOSE 8095
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
    CMD ["node", "/app/bin/mx.mjs", "healthcheck"]
ENTRYPOINT ["node", "/app/bin/mx.mjs"]
CMD ["serve"]
