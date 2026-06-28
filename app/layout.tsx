import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import CodexHealthBanner from "@/components/CodexHealthBanner";
import ThemeProvider from "@/components/ThemeProvider";
import { loadSettings } from "@/lib/settings-store";

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
  const theme = loadSettings().theme;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased${theme === "dark" ? " dark" : ""}`}
    >
      <body className="h-full flex flex-col overflow-hidden bg-[var(--surface-canvas)] text-[var(--ink-900)]">
        <script
          dangerouslySetInnerHTML={{
            __html: `
try {
  var t = ${JSON.stringify(theme ?? null)};
  if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
} catch(e) {}
`,
          }}
        />
        <CodexHealthBanner />
        <ThemeProvider initialTheme={theme}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
