# Pageturner: how changes are made

Mélissa previews every change before it goes live. Follow this workflow strictly.

1. Make ALL changes in `preview/` only:
   - Frontend: `preview/index.html`
   - Worker (Gemini proxy): `preview/proxy/worker.js`
   Never edit the root `index.html` or `proxy/` directly.
2. Commit and push to `main`. This updates only the preview:
   - Preview app: https://melissaozturk24.github.io/pageturner/preview/ (orange "PREVIEW" badge, uses the preview Worker)
   - Preview Worker: https://pageturner-proxy-preview.melissaozturk24.workers.dev (auto-deployed by `.github/workflows/deploy-preview-worker.yml`)
   GitHub Pages takes about 1 minute to update. Give Mélissa the preview link and stop.
3. Only when Mélissa says to deploy: run `scripts/promote.sh`, commit, push to `main`. The live Worker redeploys via `.github/workflows/deploy-worker.yml`.

Notes: preview and live share the same browser storage (same origin), so saved books and history are shared between them.
