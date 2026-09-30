# Tars landing site

The one-page site for Tars: what it is, and a button that downloads the latest
macOS build from this repository's GitHub releases.

## Run it

```bash
cd landing
npm install
npm run dev        # http://localhost:3000
```

## What it is made of

- **Pages.** One page (`src/app/page.tsx`), its 404 (`src/app/not-found.tsx`), the privacy policy and the terms (`src/app/privacy/`, `src/app/terms/`), `robots.txt` and `sitemap.xml` (`src/app/robots.ts`, `src/app/sitemap.ts`), and the picture link previews show (`src/app/opengraph-image.png`).
- **The privacy policy and the terms.** `src/content/privacy.md` and `src/content/terms.md` are Cooper Labs's documents, word for word, and the pages show them through `src/lib/markdown.tsx`, which reads only the markdown they use. A new version of either replaces its file, with its new date on its second line.
- **Design.** The design is `design/landing.pen` at the repository root: the page, the 404, the privacy and terms pages, and the preview picture. Draw a change there first.
- **Fonts.** Roboto Condensed, Roboto Mono and Instrument Serif are self-hosted through `next/font`, so the page makes no request to Google.
- **The picture under the hero.** `src/assets/dashboard.png` is a capture of the real app: a sandbox Tars running four real Claude Code sessions on one project. The model's answers were scripted for the capture.
- **`/api/download`** resolves the latest release of `JeanBrasse/Tars` at request time and redirects to its macOS dmg, or to the releases page.
- **The download counter.** `/api/stats` and the counter under the hero read GitHub's own `download_count` for the `.dmg` of every release (`src/lib/downloads.ts`), cached an hour by the server. The zip and `latest-mac.yml` are left out: installed apps fetch them to update. Nothing about a download is stored, and the counter stays hidden when GitHub does not answer.
- **Analytics.** `@vercel/analytics`, cookieless, active only once the site runs on Vercel.

## Deploy

Not deployed yet. On Vercel, it needs a project with Root Directory `landing/` and production branch `main`. The absolute URLs (the preview picture, `robots.txt`, the sitemap) come from `src/lib/site.ts`: the `VERCEL_PROJECT_PRODUCTION_URL` that Vercel provides, or localhost. Once the domain is known it can be written there.
