"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Wrap the authed-section layout so client-side hooks like signIn/signOut
 * have access to the session. Server pages don't need this — they use
 * getServerSession from next-auth.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
