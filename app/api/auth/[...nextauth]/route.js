import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";

export const authOptions = {
  // debug only when explicitly requested — suppresses full-token logs that expose credentials
  debug: false,


  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/calendar.events",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),

    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
      // "common" supports both work/school and personal Microsoft accounts.
      // If your Azure app "Supported account types" is set to single-tenant,
      // change this to your actual tenant ID from the Azure portal.
      tenantId: process.env.AZURE_AD_TENANT_ID || "common",
      authorization: {
        params: {
          scope:
            "openid profile email offline_access " +
            "https://graph.microsoft.com/Calendars.Read " +
            "https://graph.microsoft.com/Calendars.ReadWrite",
          // select_account avoids the stale-state cookie issue on repeated logins
          prompt: "select_account",
          // response_type must be "code" for PKCE/confidential client flows
          response_type: "code",
        },
      },
    }),
  ],

  callbacks: {
    // ── JWT: store ONLY the minimum needed — large tokens overflow the 4KB cookie ──
    async jwt({ token, account }) {
      if (account) {
        // Only store what the app actually uses.
        // DO NOT store: id_token, profile, expires_at, or any large object.
        token.provider    = account.provider;
        token.accessToken = account.access_token;
        // Strip fields NextAuth injects automatically — they add ~300-400 bytes each
        // and push the cookie past the 4096-byte browser limit causing reload loops.
        delete token.name;
        delete token.picture;
        delete token.sub;
      }
      // Strip JWT metadata fields on every call (they're re-added each time)
      delete token.iat;
      delete token.exp;
      delete token.jti;
      return token;
    },

    // ── Session: expose only what the frontend and API routes need ──────────────
    async session({ session, token }) {
      session.provider    = token.provider;    // "google" | "azure-ad"
      session.accessToken = token.accessToken; // used by /api/events
      // DO NOT spread the full token — it duplicates data and inflates the cookie
      return session;
    },
  },

  events: {
    async signIn({ user, account }) {
      console.log(
        `[NextAuth] ✓ signIn: ${user?.email} via ${account?.provider}`
      );
    },
    async signOut() {
      console.log("[NextAuth] signOut");
    },
  },

  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60, // 1 day — shorter = smaller token
  },

  pages: {
    signIn: "/",
    error: "/",
  },

  secret: process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
