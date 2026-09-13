FROM docker.io/cloudflare/sandbox:0.12.9

# Base image ships node/bun but no Python — install it for `language: "python"`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Unprivileged user that runs every /run snippet and /workspace/exec command
# (the sandbox control plane itself stays root). npm -g installs go to $HOME;
# pip falls back to --user installs automatically.
RUN useradd -m -u 10001 -s /bin/bash bloop \
    && mkdir -p /home/bloop/.npm-global /workspace \
    && chown -R bloop:bloop /home/bloop

# Documents the ports this application uses (standard Docker convention)
EXPOSE 8080
