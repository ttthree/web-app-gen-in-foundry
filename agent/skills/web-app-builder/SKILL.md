# Web App Builder Skill

Generate frontend-only static web applications from user prompts.

## Constraints

- Create frontend-only static files (HTML, CSS, JS).
- Write all application files under `output/app`.
- The app must have an `index.html` entrypoint that works by opening directly in a browser.
- Do not create `output/app.zip` or `output/manifest.json` — the server handles packaging.
- Do not create backend services, databases, auth providers, package manifests, cloud dependencies, or secrets.
- Do not use build tools, bundlers, or package managers.
- All assets (images, fonts, icons) must be inline or relative — no external CDN or network requests.
