import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "noteprep",
  description: "Lesson preparation for independent math tutors",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
