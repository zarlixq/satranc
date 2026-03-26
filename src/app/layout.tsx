import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zarlı Satranç",
  description: "Zar destekli satranç",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}