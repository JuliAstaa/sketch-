import { Caveat, IBM_Plex_Mono } from "next/font/google";

export const caveat = Caveat({
  weight: ["500", "600"],
  subsets: ["latin", "latin-ext"],
  variable: "--font-caveat",
});

export const plexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin", "latin-ext"],
  variable: "--font-plex-mono",
});
