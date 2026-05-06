"use client";

import { signIn } from "next-auth/react";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Login form. Uses useSearchParams() to read ?callbackUrl=, which forces
 * Next.js to bail out of static prerendering. We wrap this in a Suspense
 * boundary at the page level so the build can render a fallback HTML shell
 * statically and hydrate the params on the client.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") || "/review";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await signIn("credentials", {
      username,
      password,
      redirect: false,
      callbackUrl,
    });
    setBusy(false);
    if (res?.error) {
      setError("Invalid username or password.");
    } else if (res?.ok) {
      router.push(callbackUrl);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Text Definition Labeler</CardTitle>
        <p className="text-xs text-muted-foreground">
          Sign in with the shared admin credentials provided by your team.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoFocus
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-muted/30">
      <Suspense
        fallback={
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Text Definition Labeler</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-32 animate-pulse bg-muted/50" />
            </CardContent>
          </Card>
        }
      >
        <LoginForm />
      </Suspense>
    </main>
  );
}
