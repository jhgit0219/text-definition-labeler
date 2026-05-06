import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Text Definition Labeler",
  description: "Validate and correct OCR-extracted text/definition pairs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
