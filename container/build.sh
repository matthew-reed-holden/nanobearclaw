#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Build from project root so the Dockerfile can COPY host dist/ (PaaS mode files)
cd "$SCRIPT_DIR/.."

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Compile host TypeScript before building — PaaS mode files in dist/ are COPY'd into the image
npm run build

${CONTAINER_RUNTIME} build -f container/Dockerfile -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with (standard mode):"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i --entrypoint /app/entrypoint.sh ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with (PaaS mode):"
echo "  ${CONTAINER_RUNTIME} run -p 18789:18789 -e MANAGEMENT_TOKEN=secret ${IMAGE_NAME}:${TAG}"
