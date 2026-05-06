import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

/**
 * Single shared admin login. The username/password come from env vars
 * (ADMIN_USERNAME / ADMIN_PASSWORD) so they never reach the browser bundle.
 *
 * The credentials are checked here on the server, then NextAuth signs a
 * JWT and stores it as an HttpOnly cookie. Subsequent requests are
 * authenticated by the cookie alone — no session or DB write needed.
 *
 * To add real per-user auth later, swap CredentialsProvider's authorize()
 * to look up a `users` table and verify a bcrypt-hashed password.
 */
export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Admin",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const u = process.env.ADMIN_USERNAME;
        const p = process.env.ADMIN_PASSWORD;
        if (!u || !p) {
          throw new Error("ADMIN_USERNAME / ADMIN_PASSWORD not configured on the server");
        }
        if (
          credentials?.username === u &&
          credentials?.password === p
        ) {
          return { id: "admin", name: u };
        }
        return null;
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  secret: process.env.NEXTAUTH_SECRET,
};
