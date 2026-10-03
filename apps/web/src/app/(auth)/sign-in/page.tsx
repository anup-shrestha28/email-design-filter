import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { GoogleSignInButton } from "@/components/site/google-button";
import { LinkButton } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { afterSignIn, EXPIRED_PARAM } from "@/lib/sign-in-next";
import { DevSignIn } from "./dev-sign-in";

export const metadata: Metadata = { title: "Sign in" };

const SESSION_COOKIES = ["edf.session_token", "__Secure-edf.session_token"];

/** Sign-in never touches the database (FREE-TIER.md §8.4): the session check is cookie presence only. */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ reauth?: string; next?: string | string[]; [EXPIRED_PARAM]?: string }>;
}) {
  const [jar, sp] = await Promise.all([cookies(), searchParams]);
  const { reauth, next } = sp;
  const destination = reauth === "connect" ? "/connect" : afterSignIn(next);
  // A cookie the app just found invalid (requireUser adds ?expired=1) isn't a session.
  const maybeSignedIn = SESSION_COOKIES.some((c) => jar.has(c)) && sp[EXPIRED_PARAM] === undefined;
  const devLogin = process.env.NODE_ENV !== "production" && process.env.EDF_DEV_LOGIN === "1";

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-overlay sm:p-8">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-foreground">
          <LockKeyhole className="size-5" aria-hidden />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-foreground">Sign in</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Email Design Filter is invite-only. Use the Google account your invite was sent to.
        </p>

        {reauth ? (
          <p
            role="status"
            className="mt-4 rounded-lg bg-info-soft px-3 py-2.5 text-[0.8125rem] leading-relaxed text-foreground"
          >
            For your safety, please sign in again to{" "}
            {reauth === "connect" ? "connect Gmail" : "continue"}.
          </p>
        ) : null}

        {maybeSignedIn && !reauth ? (
          <LinkButton href={destination} variant="primary" size="lg" className="mt-6 w-full">
            Continue to your designs
            <ArrowRight aria-hidden />
          </LinkButton>
        ) : null}

        <div className="mt-6">
          <GoogleSignInButton callbackURL={destination} />
        </div>
        <p className="mt-3 text-center text-xs leading-relaxed text-subtle-foreground">
          Signing in only shares your name and email address. Gmail access is a separate step you
          choose later.
        </p>

        {devLogin ? (
          <>
            <Separator className="my-6" />
            <DevSignIn next={destination} />
          </>
        ) : null}
      </div>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        No invite yet? Ask the person who runs this app to add your address.
      </p>
    </div>
  );
}
