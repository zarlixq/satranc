import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zarlı Satranç",
  description: "Zar destekli satranç",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Çentikli ekranlarda safe-area değerleri bununla gelir.
  viewportFit: "cover",
  themeColor: "#161512",
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
