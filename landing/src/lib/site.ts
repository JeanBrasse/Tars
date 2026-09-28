/**
 * The site's own address, for the few places that need it whole: robots.txt
 * and the sitemap. On Vercel that is the production domain it sets at build
 * time; anywhere else, the local dev server. Next's own social image URLs fall
 * back the same way (lib/metadata/resolvers/resolve-url.js).
 */
export const SITE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'http://localhost:3000';
