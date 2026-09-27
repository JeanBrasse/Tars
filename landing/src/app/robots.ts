import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// /api/ is the download counter and its stats: a crawler following the
// download link counted as a download.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
