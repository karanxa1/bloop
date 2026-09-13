#!/bin/bash
# Generate bloop brand assets via Azure OpenAI gpt-image-2.5-flare
# Requires: AZURE_OPENAI_API_KEY (or source core/.dev.vars)
set -e
cd "$(dirname "$0")/.."
KEY="${AZURE_OPENAI_API_KEY:-$(grep '^AZURE_OPENAI_API_KEY' core/.dev.vars 2>/dev/null | cut -d= -f2- | tr -d '"')}"
ENDPOINT="https://callmissed-resource.cognitiveservices.azure.com/openai/deployments/gpt-image-2.5-flare/images/generations?api-version=2025-04-01-preview"
OUT="landing/assets"
mkdir -p "$OUT"

gen() { # name prompt size [extra]
  local name="$1" prompt="$2" size="$3" extra="$4"
  echo "=== generating $name ==="
  curl -s -m 300 -X POST "$ENDPOINT" -H "api-key: $KEY" -H "Content-Type: application/json" \
    -d "{\"prompt\":\"$prompt\",\"size\":\"$size\",\"quality\":\"high\",\"n\":1$extra}" \
    | python3 -c "
import json,sys,base64
d=json.load(sys.stdin)
if 'data' in d and d['data'] and d['data'][0].get('b64_json'):
    open('$OUT/$name','wb').write(base64.b64decode(d['data'][0]['b64_json']))
    print('$name saved')
else:
    print('$name FAILED:', str(d)[:400])
"
}

gen "hero.jpg" "long-exposure photograph looking up at lush green tree canopy against bright blue sky with puffy white clouds, strong vertical motion blur streaking upward, sunlight flaring through leaves, dreamy summer atmosphere, photorealistic, no text" "1536x1024"

gen "underwater.jpg" "underwater photograph of sunbeams penetrating green-tinted clear water, light rays and caustics, gentle motion blur, serene natural abstraction, photorealistic, no text" "1536x1024"

gen "tree.jpg" "long-exposure photograph of a single tall majestic tree against vivid blue sky, strong vertical motion blur, green foliage streaking upward, dramatic perspective, photorealistic, no text" "1024x1536"

gen "cta-bg.jpg" "extreme motion-blurred green foliage and sky, wide panoramic long-exposure, soft bokeh light, abstract green and blue tones, photorealistic, no text" "1536x1024"

gen "logo-blob.png" "minimalist logo mark: a single rounded organic blob shape resembling a small fruit or berry with a tiny sprout leaf on top, solid white fill, clean vector style, centered, isolated" "1024x1024" ",\"background\":\"transparent\""

echo "=== all done ==="
ls -la "$OUT"
