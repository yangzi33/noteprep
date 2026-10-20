import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import Link from "next/link";
import { AppHeader } from "@/components/app/app-header";
import { Logo } from "@/components/app/logo";
import { WorkspaceNav } from "@/components/app/workspace-nav";
import { getRequestUser } from "@/lib/server/auth/require-user";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const lora = Lora({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-lora",
  display: "swap",
});

export const metadata: Metadata = {
  title: "noteprep",
  description: "Lesson preparation for independent math tutors",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getRequestUser();
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable} font-sans`}>
      <body className="min-h-screen bg-background">
        {user ? (
          <>
            <AppHeader email={user.email} />
            <div className="md:grid md:grid-cols-[208px_1fr]">
              <aside className="border-b border-sidebar-border bg-sidebar md:border-r md:border-b-0">
                <WorkspaceNav />
              </aside>
              <div className="min-w-0">{children}</div>
            </div>
          </>
        ) : (
          <>
            <header className="flex min-h-[72px] items-center border-b bg-card px-4 md:min-h-20 md:px-8">
              <Link href="/" className="rounded-control focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none">
                <Logo />
              </Link>
              <Link href="/login" className="ml-auto inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline">
                Sign in
              </Link>
            </header>
            {children}
          </>
        )}
      </body>
    </html>
  );
}
