FROM docker.io/cloudflare/sandbox:0.12.9

# Base image ships node/bun but no Python — install it for `language: "python"`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Documents the ports this application uses (standard Docker convention)
EXPOSE 8080
