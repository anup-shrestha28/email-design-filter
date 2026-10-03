"use client";
import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/hooks/use-theme";

export function Toaster() {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      closeButton
      visibleToasts={4}
      offset={16}
      mobileOffset={{ bottom: 80 }}
      toastOptions={{
        classNames: { title: "text-[0.8125rem] font-medium", description: "text-xs" },
      }}
    />
  );
}
