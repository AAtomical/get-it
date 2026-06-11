import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import CodexHealthBanner from "@/components/CodexHealthBanner";
import ThemeProvider from "@/components/ThemeProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Get It.",
  description:
    "Drop in any tagged PDF. Get It.'s agents pick the concepts that benefit from a picture and render them in 3D, animation, formulas, graphs, or live sources right next to the text — and back-reflect your mastery onto a knowledge graph.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col overflow-hidden bg-[var(--surface-canvas)] text-[var(--ink-900)]">
        <CodexHealthBanner />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
