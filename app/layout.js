import { Inter } from "next/font/google";
import "./globals.css";
import Providers from "./providers"; // 👈 add this

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "SmartScheduler — AI-Powered Calendar",
  description: "Intelligent scheduling assistant",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}