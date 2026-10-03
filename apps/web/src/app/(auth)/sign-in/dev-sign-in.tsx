"use client";
import { FlaskConical } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { signIn } from "@/lib/auth-client";

/** Development-only email/password sign-in (EDF_DEV_LOGIN=1, never in production). */
export function DevSignIn({ next = "/gallery" }: { next?: string }) {
  const id = useId();
  const [email, setEmail] = useState("demo@edf.local");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        const r = await signIn.email({ email, password });
        if (r.error) {
          setError("That email and password didn't match a development account.");
          setPending(false);
          return;
        }
        window.location.assign(next);
      }}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-warning">
        <FlaskConical className="size-3.5" aria-hidden />
        Development sign-in
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input
          id={`${id}-email`}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-password`}>Password</Label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          required
        />
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" loading={pending}>
        Sign in
      </Button>
    </form>
  );
}
