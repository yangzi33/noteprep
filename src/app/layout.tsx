import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import { AppHeader } from "@/components/app/app-header";
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
  applicationName: "NotePrep",
  title: { default: "NotePrep", template: "%s · NotePrep" },
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
          // Signed-out pages render their own PublicHeader (landing page, /login).
          children
        )}
      </body>
    </html>
  );
}
