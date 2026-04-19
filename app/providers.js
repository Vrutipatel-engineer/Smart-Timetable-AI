"use client";

import { SessionProvider } from "next-auth/react";

export default function Providers({ children }) {
  return (
    <SessionProvider
      // Re-fetch session whenever the window regains focus (catches post-OAuth redirects)
      refetchOnWindowFocus={true}
      // Poll every 5 minutes to keep session fresh
      refetchInterval={5 * 60}
    >
      {children}
    </SessionProvider>
  );
}