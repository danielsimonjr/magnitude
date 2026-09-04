---
"@magnitudedev/cli": patch
---

Security hardening: the local Magnitude service now requires a per-user bearer token for RPC and shutdown, the inference proxy rejects cross-site origins, the desktop app blocks window-open/navigation escapes and sandboxes the renderer, the shell safety classifier closes command-substitution and wrapper bypasses, agent file tools resolve symlinks and refuse protected Magnitude paths, web fetch blocks private-network targets, embedded ripgrep downloads are SHA-256 pinned, custom endpoints require HTTPS off loopback, and vulnerable transitive dependencies are overridden.
