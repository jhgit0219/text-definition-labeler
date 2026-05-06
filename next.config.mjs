/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Page renders can be served from the public/ folder during dev.
  // For production on Vercel, switch PAGE_IMAGES_BASE_URL to a Vercel Blob
  // or external CDN URL — keeps the deployment bundle small.
};
export default nextConfig;
