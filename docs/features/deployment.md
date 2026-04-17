# Deployment

The project has two deploy targets: the static site (GitHub Pages) and the Worker API (Cloudflare Workers), each with CI gates and automated triggers.

## Site Deployment

```mermaid
flowchart TD
    A{Trigger} --> B

    A1[Push to main] --> A
    A2[Bot workflow completes:<br/>add-member, update-member,<br/>refresh-letterboxd,<br/>refresh-spotify] --> A
    A3[Manual dispatch] --> A

    B{Direct push?}
    B -->|Yes| C[Run test suite<br/>unit + e2e]
    B -->|No, bot-driven| D[Skip tests]

    C -->|Pass| E[Build site]
    D --> E

    E --> F[nue build]
    F --> G[Copy index.html to 404.html<br/>SPA fallback routing]
    G --> H[Upload .dist/ artifact]
    H --> I[Deploy to GitHub Pages]

    style I fill:#0a0,color:#fff
```

### Concurrency

Deploy uses concurrency group `pages` with `cancel-in-progress: false`. Multiple triggers queue rather than cancel each other.

### SPA Routing

GitHub Pages serves `404.html` for unknown paths. Since `404.html` is a copy of `index.html`, the client-side SPA router handles deep links like `/events` or `/edit`.

## Worker Deployment

```mermaid
flowchart TD
    A{Trigger} --> B[Run test suite]

    A1[Push to main<br/>worker/** changed] --> A
    A2[Push to staging<br/>worker/** changed] --> A
    A3[Manual dispatch] --> A

    B -->|Pass| C{Branch?}
    C -->|main| D[wrangler deploy<br/>Production: join.jxnfilm.club]
    C -->|staging| E[wrangler deploy --env staging<br/>Staging: join-staging.jxnfilm.club]

    style D fill:#0a0,color:#fff
    style E fill:#f90,color:#fff
```

### Environments

| Environment | Domain | KV Namespaces |
|-------------|--------|---------------|
| Production | `join.jxnfilm.club` | Prod MEMBERS_KV + ATTENDANCE_KV |
| Staging | `join-staging.jxnfilm.club` | Staging MEMBERS_KV + ATTENDANCE_KV |

## CI: Build Check + Test

- **Build check** (`build-check.yml`): runs on PRs. Parallel site build (`npm run build`) + worker dry-run (`wrangler deploy --dry-run`).
- **Test** (`test.yml`): unit tests (`npm test`) + e2e tests (Playwright Chromium). Reusable workflow called by deploy pipelines. On failure: uploads `playwright-report/` artifact (7-day retention).

## Timing

The user-facing message "The public site rebuilds in ~30 seconds" reflects the approximate pipeline: GitHub Action dispatch -> workflow pickup -> build -> deploy.

## Key Files

| File | Role |
|------|------|
| `.github/workflows/deploy-site.yml` | Site build + deploy |
| `.github/workflows/deploy-worker.yml` | Worker deploy (prod/staging) |
| `.github/workflows/build-check.yml` | PR validation |
| `.github/workflows/test.yml` | Reusable test workflow |
