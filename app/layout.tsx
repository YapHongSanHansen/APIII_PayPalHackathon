import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "APIII Test Console",
  description: "APIs for AI agents: pay with PayPal, only for answers that keep the promise.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
