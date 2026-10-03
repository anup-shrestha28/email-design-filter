"use client";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function GoBack() {
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      size="lg"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push("/inbox");
      }}
    >
      <ArrowLeft aria-hidden />
      Go back
    </Button>
  );
}
