import type { Metadata } from "next";
import Link from "next/link";
import { Inter, Lora } from "next/font/google";
import ThemeToggle from "@/components/theme-toggle";
import HealthStrip from "@/components/health-strip";
import KeyboardShortcuts from "@/components/keyboard-shortcuts";
import WelcomeToast from "@/components/welcome-toast";
import "./globals.css";

const lora = Lora({ subsets: ["latin"], variable: "--font-lora" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Board Game Parlor",
  description:
    "A cozy catalog of the board games I own — rulebooks, photos, and a chat bar to ask anything about how they play.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon-192.png" />
        <meta name="theme-color" content="#f7f1e6" />
        <link rel="preconnect" href="http://localhost:8888" />
        <script
          dangerouslySetInnerHTML={{
            __html: `try { if (localStorage.getItem("parlor-theme") === "dark") { document.documentElement.classList.add("dark"); document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#171210"); } } catch (e) {}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }`,
          }}
        />
      </head>
      <body className={`${lora.variable} ${inter.variable} font-sans antialiased`}>
        <KeyboardShortcuts />
        <WelcomeToast />
        <header className="sticky top-0 z-30 border-b border-latte/50 bg-parchment/75 backdrop-blur dark:border-cocoa/30 dark:bg-nightcard/80">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link
              href="/"
              className="font-serif text-base tracking-wide text-espresso dark:text-parchment sm:text-xl"
            >
              Board Game Parlor
            </Link>
            <nav className="flex items-center gap-4 text-sm text-cocoa dark:text-latte">
              <Link href="/" className="transition-colors hover:text-terracotta dark:hover:text-amberglow">
                Home
              </Link>
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main className="bg-lampglow min-h-[calc(100vh-3.5rem)]">{children}</main>
        <footer className="border-t border-latte/50 bg-parchment/40 py-6 text-center text-sm text-cocoa backdrop-blur dark:border-cocoa/30 dark:bg-nightcard/60 dark:text-latte">
          <HealthStrip />
          <p className="mt-3">Brewed with care · self-hosted · a quiet shelf of games</p>
        </footer>
      </body>
    </html>
  );
}
