/** @type {import('next').NextConfig} */
export default {
  // better-sqlite3 is a native module. Next must not try to bundle it.
  serverExternalPackages: ['better-sqlite3'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'image.tmdb.org' }],
  },
};
