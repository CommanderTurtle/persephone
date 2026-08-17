# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14
ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-slim-bookworm AS wheel-builder

ARG BUN_VERSION
ARG OMP_VERSION
ARG OMP_COMMIT

ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version

WORKDIR /src

# The source tree is used only in this build stage. The runtime image receives
# the two Python wheels and the built dashboard, never an oh-my-pi checkout.
RUN test -n "${OMP_COMMIT}" \
    && curl -fsSL "https://github.com/can1357/oh-my-pi/archive/${OMP_COMMIT}.tar.gz" \
       | tar -xz --strip-components=1 \
    && test "$(python -c 'import json; print(json.load(open("packages/coding-agent/package.json"))["version"])')" = "${OMP_VERSION}"

RUN bun install --filter robomp-web \
    && bun --cwd=python/robomp/web run build \
    && mkdir -p python/robomp/src/static \
    && cp -a python/robomp/web/dist/. python/robomp/src/static/

RUN python -m pip install --upgrade build pip \
    && python -m pip wheel --wheel-dir /wheels ./python/omp-rpc \
    && python -m pip wheel --wheel-dir /wheels \
       "fastapi>=0.112" "uvicorn[standard]>=0.30" "httpx>=0.27" \
       "pydantic>=2.6" "pydantic-settings>=2.2" "python-dotenv>=1.0" "click>=8.1" \
    && python -m pip wheel --no-deps --wheel-dir /wheels ./python/robomp

FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

ARG BUN_VERSION
ARG OMP_VERSION

ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    OTEL_SDK_DISABLED=true \
    DO_NOT_TRACK=1 \
    HOME=/srv/agent-home \
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash build-essential ca-certificates curl git jq openssh-client \
       fd-find pkg-config libssl-dev ripgrep sqlite3 tini unzip xz-utils \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version \
    && bun install --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \
    && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -s /opt/bun/bin/bunx /usr/local/bin/bunx \
    && ln -s /opt/bun/bin/omp /usr/local/bin/omp \
    && omp --version

# Keep Rust project validation available without baking a toolchain into the
# image. rustup installs the repo-requested toolchain lazily into /data/cache.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && HOME=/root CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && rustup --version

COPY --from=wheel-builder /wheels /wheels
RUN python -m pip install --no-index --find-links=/wheels robomp \
    && rm -rf /wheels

RUN mkdir -p \
      /srv/agent-home-stage/.agent \
      /srv/agent-home-stage/.omp/agent \
      /srv/agent-home/.agent \
      /srv/agent-home/.omp/agent \
    && printf '[install]\nbackend = "copyfile"\n' > /srv/agent-home/.bunfig.toml

COPY entrypoint.sh /usr/local/bin/persephone-robomp-entrypoint
COPY scheduled_audit.py /usr/local/libexec/persephone-scheduled-audit
RUN chmod 0755 \
      /usr/local/bin/persephone-robomp-entrypoint \
      /usr/local/libexec/persephone-scheduled-audit

WORKDIR /app
VOLUME ["/data"]
EXPOSE 8080 8081
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/persephone-robomp-entrypoint"]
CMD ["python", "-m", "robomp", "serve"]
