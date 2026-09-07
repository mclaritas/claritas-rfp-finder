# Claritas RFP Finder — GitHub Actions edition

This version solves the Vercel Chromium runtime problem by moving browser collection to GitHub Actions.

- GitHub Actions installs Playwright Chromium with all Linux dependencies.
- Collection runs every 3 hours and can also be run manually from Actions.
- The workflow writes `data/results.json`.
- GitHub Pages serves the dashboard as a bookmarkable site.
- Opening the dashboard or clicking "Reload latest data" always reads the newest collected JSON.
- Standalone `water` does not score; only meaningful environmental phrases do.

Setup:
1. Create/import this folder as a GitHub repository.
2. In repository Settings > Pages, set Source to GitHub Actions.
3. Run the `Refresh RFP data` workflow once.
4. GitHub Pages will provide the bookmarkable URL.
