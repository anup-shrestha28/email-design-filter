/**
 * The client half of Settings → Time zone: the picker offers "Automatic (this device)" for the
 * default value and a separate UTC, and TimeZoneSync only asks for a fresh render when dates follow
 * the device (a saved zone would otherwise refresh the page forever, since it never matches).
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/settings", () => ({ updateSettings: async () => ({ ok: true }) }));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("nuqs/adapters/next/app", () => ({ NuqsAdapter: ({ children }: { children: React.ReactNode }) => children }));

const { AppProviders } = await import("@/components/providers/app-providers");
const { Preferences, timeZoneOptions } = await import("@/components/settings/preferences");
const { render } = await import("../support/render");

const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
const elsewhere = here === "Antarctica/Troll" ? "Pacific/Chatham" : "Antarctica/Troll";
const saved = here === "Asia/Tokyo" ? "America/Lima" : "Asia/Tokyo";

async function settle(ms = 450) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function clearCookie() {
  document.cookie = "edf-tz=; path=/; max-age=0";
}

afterEach(clearCookie);

describe("timeZoneOptions", () => {
  it("labels the default as Automatic and offers UTC once, as Etc/UTC", () => {
    const opts = timeZoneOptions("UTC");
    expect(opts[0]).toEqual({ value: "UTC", label: "Automatic (this device)" });
    expect(opts.filter((o) => o.label === "UTC")).toEqual([{ value: "Etc/UTC", label: "UTC" }]);
    expect(opts.filter((o) => o.value === "UTC")).toHaveLength(1);
    expect(timeZoneOptions("Asia/Tokyo").some((o) => o.value === "Asia/Tokyo")).toBe(true);
    expect(timeZoneOptions("Etc/UTC").filter((o) => o.value === "Etc/UTC")).toHaveLength(1);
  });

  it("shows Automatic for a user who never chose a zone", async () => {
    const r = await render(
      <Preferences
        role="owner"
        settings={{ timezone: "UTC", loadImagesForAnalysis: true, linkCheckOptIn: false, backfillWindowDays: 90, aiProcessingConsentAt: null }}
      />,
    );
    const trigger = r.container.querySelector('[aria-label="Time zone"]');
    expect(trigger?.textContent).toContain("Automatic (this device)");
  });
});

describe("TimeZoneSync", () => {
  const clock = (timeZone: string) => ({ serverNow: Date.now(), locale: "en-US", timeZone });

  it("with a saved zone, records the device's zone but doesn't refresh", async () => {
    const r = await render(
      <AppProviders clock={clock(saved)} deviceTimeZone={elsewhere}>
        <p>page</p>
      </AppProviders>,
    );
    await settle();
    expect(document.cookie).toContain(`edf-tz=${encodeURIComponent(here)}`);
    expect(r.router.calls).not.toContain("refresh");
  });

  it("while dates follow the device, refreshes once the device's zone is recorded", async () => {
    const r = await render(
      <AppProviders clock={clock(elsewhere)} deviceTimeZone={elsewhere}>
        <p>page</p>
      </AppProviders>,
    );
    await settle();
    expect(document.cookie).toContain(`edf-tz=${encodeURIComponent(here)}`);
    expect(r.router.calls).toContain("refresh");
  });

  it("without a device zone (sign-in pages), the clock's zone is the device's", async () => {
    const r = await render(
      <AppProviders clock={clock(elsewhere)}>
        <p>page</p>
      </AppProviders>,
    );
    await settle();
    expect(r.router.calls).toContain("refresh");
  });
});
