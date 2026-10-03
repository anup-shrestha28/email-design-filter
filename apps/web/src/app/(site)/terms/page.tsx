import type { Metadata } from "next";
import { ProsePage } from "@/components/site/site-chrome";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <ProsePage
      eyebrow="Terms"
      title="Terms of use"
      summary="Short and plain, because this is a small personal app shared with friends."
      updated="27 September 2026"
    >
      <h2>The service</h2>
      <p>
        Email Design Filter is a private, invite-only, non-commercial app. It connects to Gmail with
        read-only access to organise automated mail and score email designs. There are no payments,
        ads or affiliate links.
      </p>
      <h2>Your account</h2>
      <ul>
        <li>Use the app only with your own Google account, the one you were invited with.</li>
        <li>
          Don&apos;t try to access other people&apos;s data, overload the service, or get around its
          limits.
        </li>
        <li>
          You can stop using the app at any time by disconnecting your mailbox or deleting your
          account.
        </li>
      </ul>
      <h2>Design scores are opinions backed by measurements</h2>
      <p>
        Scores come from documented checks and a bounded AI review. They are informational, and
        email apps can display emails differently from our renderer. Don&apos;t rely on a score for
        anything important.
      </p>
      <h2>No warranty</h2>
      <p>
        The app is provided as is, without warranties. It runs on free service tiers and may slow
        down, pause features, or be unavailable. We&apos;ll try to keep your data safe, but we
        can&apos;t promise the service is error-free.
      </p>
      <h2>Changes and ending the service</h2>
      <p>
        These terms may change; the date above will show when. Access may be removed, for example if
        the app shuts down — in that case stored data is deleted.
      </p>
      <h2>Privacy</h2>
      <p>
        How your data is handled is described in the <a href="/privacy">privacy policy</a>.
      </p>
    </ProsePage>
  );
}
