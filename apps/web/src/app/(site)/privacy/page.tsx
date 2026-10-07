import type { Metadata } from "next";
import { ProsePage } from "@/components/site/site-chrome";

export const metadata: Metadata = { title: "Privacy policy" };

const TOC = [
  { id: "summary", label: "In short" },
  { id: "google", label: "Google user data" },
  { id: "access", label: "What we access" },
  { id: "store", label: "What we store" },
  { id: "never", label: "What we never do" },
  { id: "ai", label: "AI processing" },
  { id: "images", label: "Images and links" },
  { id: "retention", label: "How long we keep data" },
  { id: "people", label: "Who can see your data" },
  { id: "processors", label: "Sub-processors" },
  { id: "controls", label: "Your controls" },
];

export default function PrivacyPage() {
  return (
    <ProsePage
      eyebrow="Privacy"
      title="Privacy policy"
      summary="Dearly Mail is a private, invite-only app. This page explains, in plain words, what it reads, what it keeps, and what it never does."
      updated="27 September 2026"
      toc={TOC}
    >
      <h2 id="summary">In short</h2>
      <ul>
        <li>
          Gmail access is <strong>read-only</strong>. We can&apos;t send, delete, label or change
          your mail.
        </li>
        <li>
          We only keep information about the <strong>automated mail you signed up for</strong> —
          newsletters, promotions, receipts and alerts. Personal mail is never stored.
        </li>
        <li>
          We don&apos;t keep email bodies. Emails open live from Gmail in a locked-down viewer.
        </li>
        <li>No ads, no selling data, and nobody reads your mail.</li>
        <li>Disconnect or delete your account at any time, and your data is deleted.</li>
      </ul>

      <h2 id="google">Google user data (Limited Use)</h2>
      <blockquote>
        The use of information received from Google Workspace scopes will adhere to the Google User
        Data Policy, including the Limited Use requirements.
      </blockquote>
      <blockquote>
        Dearly Mail&apos;s use and transfer of information received from Google APIs will
        adhere to the Google API Services User Data Policy, including the Limited Use requirements.
      </blockquote>
      <p>
        We do not use Google Workspace data to develop, improve or train non-personalized AI or
        machine-learning models. Data from your mailbox is only used to provide the features you see
        in the app, for you.
      </p>

      <h2 id="access">What we access</h2>
      <p>
        When you connect Gmail, you grant the <code>gmail.readonly</code> permission. We read
        message headers and content to decide whether an email is automated (a newsletter,
        promotion, receipt or alert) and, if so, to classify it, find deals, detect tracking and
        score its design. Personal emails may be processed briefly in memory to tell them apart;
        they are never stored.
      </p>
      <p>Signing in to the app itself only shares your name and email address with us.</p>

      <h2 id="store">What we store</h2>
      <p>For automated mail only:</p>
      <ul>
        <li>headers such as sender, subject and date;</li>
        <li>
          a short preview (the “snippet”) — except for security emails, where we keep only the
          subject, sender and time;
        </li>
        <li>a search index made from a short excerpt, so you can search;</li>
        <li>
          derived results: type, importance, deals, trust and tracking signals, fonts used, and the
          design score with its explanation;
        </li>
        <li>
          for about 30 days (14 for invited accounts), the design measurements behind a score, then
          a compact summary.
        </li>
      </ul>
      <p>
        Your Google access key is stored encrypted, with a separate key held by a small, separate
        service. We don&apos;t store email bodies or screenshots.
      </p>

      <h2 id="never">What we never do</h2>
      <ul>
        <li>Store personal mail, or send email from your mailbox.</li>
        <li>Change your mailbox in any way.</li>
        <li>Open unsubscribe, confirmation, sign-in or other links for you.</li>
        <li>Load tracking pixels or images that identify you.</li>
        <li>Render, screenshot or send security emails (codes, password resets) to AI.</li>
        <li>
          Share anything derived from your mail with other users, advertisers or data brokers.
        </li>
      </ul>

      <h2 id="ai">AI processing</h2>
      <p>
        Email content and screenshots are sent to Anthropic, PBC (USA) solely to generate your
        design review and classifications. Anthropic does not train on this data, deletes it within
        30 days (29 days for batch jobs), and may retain content flagged for safety review for up to
        2 years.
      </p>
      <p>
        AI contributes at most 14 of the 100 design points, and every AI result is labelled “AI
        review” in the app. AI spending is capped; when the cap is reached, AI reviews simply pause.
      </p>

      <h2 id="images">Images and links</h2>
      <p>
        To measure a design, our servers may load a sender&apos;s public images (never tracking
        pixels or images personalised to you). You can turn this off in Settings (“privacy mode”),
        and emails are then analysed with images off. Links from emails only open after a warning
        page that shows the real destination.
      </p>

      <h2 id="retention">How long we keep data</h2>
      <ul>
        <li>
          Email records: while your mailbox is connected, within your import window. Disconnecting
          deletes them.
        </li>
        <li>
          Detailed design measurements: 30 days (14 for invited accounts), then a small summary.
        </li>
        <li>
          Security audit log: 1 year. Error log: 30 days, error codes only — never email content.
        </li>
        <li>Database backups: the provider keeps a restore window of about 6 hours.</li>
        <li>Copies held by Anthropic: as described above.</li>
      </ul>

      <h2 id="people">Who can see your data</h2>
      <p>
        The person who runs this app is the only administrator. As the owner, they have technical
        access — the database owner credentials, and the ability to deploy code. So this is a
        commitment rather than a technical guarantee: they won&apos;t read friends&apos; data unless
        you explicitly choose to share it with them. Any emergency access is recorded in the audit
        log.
      </p>

      <h2 id="processors">Sub-processors</h2>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>What for</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Vercel</td>
            <td>Hosting the app and the separate email viewer</td>
          </tr>
          <tr>
            <td>Neon</td>
            <td>The database</td>
          </tr>
          <tr>
            <td>Inngest</td>
            <td>Scheduling background work (IDs only — no email content)</td>
          </tr>
          <tr>
            <td>Google</td>
            <td>Sign-in and Gmail access</td>
          </tr>
          <tr>
            <td>Anthropic</td>
            <td>AI design reviews and classification</td>
          </tr>
        </tbody>
      </table>

      <h2 id="controls">Your controls</h2>
      <ul>
        <li>
          <strong>Disconnect</strong> a mailbox in Settings → Mailboxes: access is revoked and its
          data deleted.
        </li>
        <li>
          <strong>Delete your account</strong> in Settings → Data &amp; account.
        </li>
        <li>
          <strong>This is personal</strong> on any email deletes it and stops storing mail from that
          sender.
        </li>
        <li>
          <strong>Privacy mode</strong> turns off image loading for analysis.
        </li>
        <li>
          <strong>Export</strong> (JSON/CSV) is coming soon.
        </li>
      </ul>
      <p>
        You can also remove the app&apos;s access from your Google Account at any time, under
        Security → Third-party connections.
      </p>
    </ProsePage>
  );
}
