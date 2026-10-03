import type { Metadata } from "next";
import { KeyCombo } from "@/components/ui/kbd";
import { ProsePage } from "@/components/site/site-chrome";

export const metadata: Metadata = { title: "Help" };

const SHORTCUTS: Array<[string, string]> = [
  ["⌘ K", "Search or jump anywhere"],
  ["g t", "Today"],
  ["g i", "Inbox"],
  ["g s", "Senders"],
  ["g n", "Insights"],
  ["j k", "Next / previous email"],
  ["↵", "Open the email"],
  ["e", "Mark done"],
  ["p", "Pin"],
  ["x", "Select for bulk actions"],
  ["/", "Search the inbox"],
  ["?", "Show all shortcuts"],
];

export default function HelpPage() {
  return (
    <ProsePage
      eyebrow="Help"
      title="Help & answers"
      summary="Quick answers about your data, the Design Score and getting around."
      toc={[
        { id: "disconnect", label: "Disconnect & delete data" },
        { id: "provisional", label: "What “Provisional” means" },
        { id: "labels", label: "Other labels" },
        { id: "google-warning", label: "The Google warning" },
        { id: "triage", label: "Done, Pin and Personal" },
        { id: "shortcuts", label: "Keyboard shortcuts" },
      ]}
    >
      <h2 id="disconnect">How do I disconnect Gmail and delete my data?</h2>
      <ol>
        <li>
          Open <strong>Settings → Mailboxes</strong>.
        </li>
        <li>
          Choose <strong>Disconnect</strong> next to the mailbox and confirm. We revoke our Google
          access immediately and delete everything stored from that mailbox.
        </li>
        <li>
          To remove everything, go to <strong>Settings → Data &amp; account</strong> and choose{" "}
          <strong>Delete my account</strong>.
        </li>
      </ol>
      <p>
        For your safety, these steps may ask you to sign in again if you signed in more than 10
        minutes ago. You can also remove access from your Google Account under Security →
        Third-party connections. Your Gmail is never changed either way.
      </p>

      <h2 id="provisional">What does “Provisional” mean?</h2>
      <p>
        A provisional score is our best estimate, but not yet firm: either we couldn&apos;t measure
        enough of the design (low confidence), or the AI review hasn&apos;t arrived and the score
        sits right next to a band edge. Provisional scores are shown with a dashed outline and stay
        out of the “Good design” and “Bad design” filters. They usually firm up within a day.
      </p>

      <h2 id="labels">What do the other labels mean?</h2>
      <ul>
        <li>
          <strong>Not analysed</strong> — only the email&apos;s code has been checked so far. Open
          it and choose Analyze for a full score.
        </li>
        <li>
          <strong>Plain text</strong> — there&apos;s no design to score.
        </li>
        <li>
          <strong>Skipped</strong> — security emails (codes, password resets) are never rendered or
          scored.
        </li>
        <li>
          <strong>Capped</strong> — a show-stopper, like unreadable contrast, limits the score. The
          raw score is shown alongside.
        </li>
        <li>
          <strong>From template</strong> — scored from a matching email by the same sender that we
          rendered.
        </li>
        <li>
          <strong>AI review pending</strong> — the measured part is final; up to 14 AI points are
          still to come.
        </li>
      </ul>

      <h2 id="google-warning">Why does Google say the app isn&apos;t verified?</h2>
      <p>
        Verification is for public apps and needs a paid yearly security audit. This app is private
        and invite-only, so it isn&apos;t verified. When connecting, click <strong>Advanced</strong>
        , then <strong>Go to … (unsafe)</strong> — but only if the address shown is this app&apos;s
        address.
      </p>

      <h2 id="triage">What do Done, Pin and “This is personal” do?</h2>
      <ul>
        <li>
          <strong>Done</strong> clears an email from “Needs attention”. It&apos;s only in this app;
          Gmail isn&apos;t changed.
        </li>
        <li>
          <strong>Pin</strong> keeps an email at the top of the inbox.
        </li>
        <li>
          <strong>This is personal</strong> deletes the email and every stored email from that
          sender, and stops storing their mail.
        </li>
        <li>
          <strong>Mute</strong> (on Senders) hides a sender&apos;s mail everywhere in the app.
        </li>
      </ul>

      <h2 id="shortcuts">Keyboard shortcuts</h2>
      <table>
        <thead>
          <tr>
            <th>Keys</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map(([k, label]) => (
            <tr key={k}>
              <td>
                <KeyCombo keys={k} />
              </td>
              <td>{label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ProsePage>
  );
}
