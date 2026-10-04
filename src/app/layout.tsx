import type { Metadata } from "next";
import type { ReactNode } from "react";
import PrivateAnalytics from "@/mini-app/analytics";
export const metadata: Metadata = {
  title: "Fortnite Collect",
  description: "Fortnite squad gatherings",
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        {children}
        <PrivateAnalytics />
      </body>
    </html>
  );
}
