"use client";
import { useDateContext } from "@/components/providers/clock";

/** "Good morning, Alex" in the reader's own time zone (hydration-safe). */
export function Greeting({ firstName }: { firstName: string }) {
  const c = useDateContext();
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: c.timeZone,
    }).format(c.now),
  );
  const part =
    hour < 5
      ? "Good evening"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
  return (
    <>
      {part}, {firstName}
    </>
  );
}
