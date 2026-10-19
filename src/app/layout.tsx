import type { Metadata } from "next";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "noteprep",
  description: "Lesson preparation for independent math tutors",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="font-sans">
      <body className="min-h-screen">
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
