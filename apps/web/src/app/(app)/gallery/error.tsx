"use client";
import { RouteError } from "@/components/page/route-error";

export default function GalleryError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} title="The designs didn't load" home={false} />;
}
