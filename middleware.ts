export { default } from "next-auth/middleware";

// Gate every route except the login page, the NextAuth handler, static
// assets, and (optionally) the page-image endpoint. Anyone hitting the
// app without a valid session cookie gets redirected to /login.
export const config = {
  matcher: [
    /*
     * Match every path EXCEPT:
     *   - /login                (public sign-in page)
     *   - /api/auth/*           (NextAuth's own routes)
     *   - /_next/*              (Next.js static / build assets)
     *   - /favicon.ico, /assets, etc.
     */
    "/((?!login|api/auth|_next/static|_next/image|favicon\\.ico|assets).*)",
  ],
};
