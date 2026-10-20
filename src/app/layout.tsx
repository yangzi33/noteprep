import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import { SiteNav } from "@/components/site-nav";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable} font-sans`}>
      <body className="min-h-screen">
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
