"use client";
import { Search, X } from "lucide-react";
import type { ComponentProps, Ref } from "react";
import { cn } from "@/lib/cn";
import { inputClass } from "./input";
import { Kbd } from "./kbd";

interface SearchFieldProps extends Omit<ComponentProps<"input">, "onChange" | "value" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Keyboard hint shown while empty, e.g. "/". */
  hint?: string;
  inputRef?: Ref<HTMLInputElement>;
  pending?: boolean;
}

export function SearchField({
  value,
  onValueChange,
  hint,
  className,
  inputRef,
  pending = false,
  "aria-label": ariaLabel = "Search",
  ...props
}: SearchFieldProps) {
  return (
    <div className={cn("relative flex items-center", className)}>
      <Search
        className={cn(
          "pointer-events-none absolute left-2.5 size-4 text-subtle-foreground",
          pending && "animate-pulse text-accent",
        )}
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        className={cn(inputClass, "pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden")}
        {...props}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onValueChange("")}
          className="absolute right-1.5 flex size-5 items-center justify-center rounded-sm text-subtle-foreground hover:bg-surface-muted hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : hint ? (
        <Kbd className="pointer-events-none absolute right-2">{hint}</Kbd>
      ) : null}
    </div>
  );
}
