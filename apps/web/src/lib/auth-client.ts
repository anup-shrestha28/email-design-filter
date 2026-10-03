"use client";
/** Better Auth browser client (sign-in, sign-out). Session refetch-on-focus is off (FREE-TIER.md §8.4). */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  sessionOptions: { refetchOnWindowFocus: false },
});

export const { signIn, signOut, signUp, useSession } = authClient;
