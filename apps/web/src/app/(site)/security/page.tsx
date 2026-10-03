import type { Metadata } from "next";
import { ProsePage } from "@/components/site/site-chrome";

export const metadata: Metadata = { title: "Security" };

export default function SecurityPage() {
  return (
    <ProsePage
      eyebrow="Security"
      title="How we protect your mail"
      summary="The main risks for an app like this are leaked access keys, one user seeing another's data, and harmful email content. Here is what we do about each — including the limits."
      updated="27 September 2026"
      toc={[
        { id: "access", label: "Access to Gmail" },
        { id: "viewing", label: "Viewing emails safely" },
        { id: "isolation", label: "Keeping users apart" },
        { id: "web", label: "Web protections" },
        { id: "ai", label: "AI safeguards" },
        { id: "limits", label: "Known limits" },
        { id: "report", label: "Reporting a problem" },
      ]}
    >
      <h2 id="access">Access to Gmail</h2>
      <ul>
        <li>
          Read-only permission only. Signing in and connecting Gmail are separate steps with
          separate Google projects.
        </li>
        <li>
          Gmail access keys are encrypted (AES-256-GCM) with a per-mailbox key, which is itself
          wrapped by a master key held only by a tiny, separate service.
        </li>
        <li>
          Keys never appear in logs, the browser or background-job payloads. Disconnecting revokes
          access with Google immediately.
        </li>
      </ul>
      <h2 id="viewing">Viewing emails safely</h2>
      <ul>
        <li>
          Emails are shown from a <strong>separate website</strong> that holds no secrets, inside a
          sandboxed frame with no scripts, no forms and no access to the app.
        </li>
        <li>
          Email HTML is cleaned first; images go through a proxy that blocks trackers and only
          allows common image formats.
        </li>
        <li>Viewer links are signed and expire after 5 minutes.</li>
        <li>
          Every link opens through a warning page that shows the real address (including look-alike
          characters) and flags click-tracking.
        </li>
        <li>Links in suspicious emails are disabled.</li>
      </ul>
      <h2 id="isolation">Keeping users apart</h2>
      <ul>
        <li>
          The database enforces row-level security: every query is tied to your account, and the
          app&apos;s database user can&apos;t bypass it.
        </li>
        <li>
          Rendering runs in throwaway micro-VMs with no network access and no secrets, one user at a
          time.
        </li>
      </ul>
      <h2 id="web">Web protections</h2>
      <ul>
        <li>
          A strict Content Security Policy with per-request nonces, HTTPS everywhere (HSTS), and
          frame protection.
        </li>
        <li>
          Every action checks your session and validates its input. Sensitive actions (disconnect,
          delete) require a recent sign-in.
        </li>
        <li>
          Public pages never touch the database; invite links are signed rather than looked up.
        </li>
      </ul>
      <h2 id="ai">AI safeguards</h2>
      <ul>
        <li>
          Email content is treated as untrusted data: the AI has no tools, must answer in a fixed
          format, and can influence at most 14 of 100 points.
        </li>
        <li>Emails that try to instruct the reviewer are flagged and their AI levels capped.</li>
        <li>Security emails are never sent to AI.</li>
      </ul>
      <h2 id="limits">Known limits</h2>
      <p>
        This is a personal app on free tiers. The master encryption key is a software key rather
        than a hardware security module — a deliberate, documented trade-off. Someone who fully
        controlled the hosting account could still misuse access, which is why the owner protects
        every account with hardware-key or passkey sign-in.
      </p>
      <h2 id="report">Reporting a problem</h2>
      <p>
        If you think you&apos;ve found a security issue, please tell the person who invited you
        directly and privately. Please don&apos;t test against other people&apos;s accounts.
      </p>
    </ProsePage>
  );
}
