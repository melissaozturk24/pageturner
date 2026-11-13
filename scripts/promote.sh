#!/usr/bin/env bash
# Copy the approved preview over the live app. Run from the repo root, then commit and push to main.
set -euo pipefail
cp preview/index.html index.html
cp preview/proxy/worker.js proxy/worker.js
echo "Promoted preview/ to live. Review 'git diff', then commit and push."
