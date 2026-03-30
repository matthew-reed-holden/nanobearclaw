---
name: x-integration
description: X (Twitter) integration for NanoClaw. Post tweets, like, reply, retweet, and quote. Use for setup, testing, or troubleshooting X functionality. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X Integration (Redirected)

This skill has been migrated to a container-native implementation using the official X SDK (`@xdevplatform/xdk`).

The new implementation lives at:
- `container/skills/x-integration/` — MCP tools and SDK client
- `container/skills/social-monitor/` — Timeline monitoring framework

See `docs/superpowers/specs/2026-03-29-x-integration-design.md` for the full architecture.

## Setup

1. Connect X account via bearclaw-platform UI
2. Run `x_setup` tool to bootstrap persona
3. Timeline monitoring auto-schedules on first use
