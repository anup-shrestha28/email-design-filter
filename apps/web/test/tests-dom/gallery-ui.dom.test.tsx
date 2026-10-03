/**
 * Gallery badges and times: the verdict and its score always agree (never "Okay · 98") and share one
 * colour; a time whose zone the server didn't know is rendered hidden (identically on server and
 * client) and then shown in the browser's own zone, never UTC first.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VerdictBadge } from "@/components/gallery/verdict-badge";
import { ClockProvider } from "@/components/providers/clock";
import { Time } from "@/components/ui/time";
import { render } from "../support/render";

describe("VerdictBadge", () => {
  it("prints the score inside the verdict's pill when it agrees with the word", async () => {
    const r = await render(<VerdictBadge verdict="good" score={92} />);
    const el = r.container.querySelector("[data-verdict]")!;
    expect(el.getAttribute("data-verdict")).toBe("good");
    expect(el.textContent).toBe("Good·, score 92 out of 100");
    expect(el.className).toContain("bg-success");
  });
  it("never shows 'Okay · 98' or a high number next to Bad", async () => {
    const ok = await render(<VerdictBadge verdict="ok" score={98} />);
    expect(ok.container.textContent).toBe("Okay");
    const ok2 = await render(<VerdictBadge verdict="ok" score={71} />);
    expect(ok2.container.textContent).toContain("71");
    expect(ok2.container.querySelector("[data-verdict]")!.className).toContain(
      "bg-band-needs-work-soft",
    );
    const bad = await render(<VerdictBadge verdict="bad" score={88} />);
    expect(bad.container.textContent).toBe("Bad");
    const unscored = await render(<VerdictBadge verdict="unscored" score={40} />);
    expect(unscored.container.textContent).toBe("Not scored yet");
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
