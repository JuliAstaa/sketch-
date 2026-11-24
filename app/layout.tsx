import type { Metadata } from "next";
import { caveat, plexMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bingkai Sketsa",
  description:
    "Ubah fotomu jadi seperti lukisan yang belum selesai diwarnai — tepi sketsa pensil, warna di tengah. Diproses di perangkatmu.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      className={`${caveat.variable} ${plexMono.variable} antialiased`}
    >
      <body>{children}</body>
    </html>
  );
}
