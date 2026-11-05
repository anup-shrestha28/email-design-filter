/**
 * Gallery badges and times: the verdict is a word and an icon in its own colour, never a number (it
 * comes from the design checklist, not the score); a time whose zone the server didn't know is rendered hidden (identically on server and
 * client) and then shown in the browser's own zone, never UTC first.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VerdictBadge } from "@/components/gallery/verdict-badge";
import { ClockProvider } from "@/components/providers/clock";
import { Time } from "@/components/ui/time";
import { render } from "../support/render";

describe("VerdictBadge", () => {
  it("shows the verdict word in its own colour, never a score", async () => {
    const good = await render(<VerdictBadge verdict="good" />);
    const el = good.container.querySelector("[data-verdict]")!;
    expect(el.getAttribute("data-verdict")).toBe("good");
    expect(el.textContent).toBe("Good");
    expect(el.className).toContain("bg-success");
    const ok = await render(<VerdictBadge verdict="ok" />);
    expect(ok.container.textContent).toBe("Okay");
    expect(ok.container.querySelector("[data-verdict]")!.className).toContain(
      "bg-band-needs-work-soft",
    );
    const bad = await render(<VerdictBadge verdict="bad" />);
    expect(bad.container.textContent).toBe("Bad");
    expect(bad.container.querySelector("[data-verdict]")!.className).toContain("bg-danger");
    const unscored = await render(<VerdictBadge verdict="unscored" />);
    expect(unscored.container.textContent).toBe("Not checked yet");
    const large = await render(<VerdictBadge verdict="bad" size="lg" />);
    expect(large.container.textContent).toBe("Bad design");
  });
});

describe("Time before the device has reported its zone", () => {
  const clock = (zoneKnown: boolean) => ({
    serverNow: Date.parse("2026-09-28T12:00:00Z"),
    locale: "en-US",
    timeZone: "UTC",
    zoneKnown,
  });
  it("renders hidden on the server (and so in the hydration pass) when the zone is unknown", () => {
    const html = renderToString(
      <ClockProvider value={clock(false)}>
        <Time iso="2026-09-28T09:15:00Z" variant="list" />
      </ClockProvider>,
    );
    expect(html).toMatch(/class="invisible"/);
    expect(html).not.toMatch(/title=/);
    const known = renderToString(
      <ClockProvider value={clock(true)}>
        <Time iso="2026-09-28T09:15:00Z" variant="list" />
      </ClockProvider>,
    );
    expect(known).not.toContain("invisible");
  });
  it("shows the time in the browser's zone once on the client", async () => {
    const r = await render(
      <ClockProvider value={clock(false)}>
        <Time iso="2026-09-28T09:15:00Z" variant="full" />
      </ClockProvider>,
    );
    const t = r.container.querySelector("time")!;
    expect(t.className).not.toContain("invisible");
    const expected = new Intl.DateTimeFormat("en-US", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date("2026-09-28T09:15:00Z"));
    expect(t.textContent).toContain(expected);
  });
});
