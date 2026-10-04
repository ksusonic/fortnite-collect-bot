"use client";
import { Analytics } from "@vercel/analytics/next";
import { analyticsEvent } from "./analytics-privacy";

export default function PrivateAnalytics() {
  return <Analytics beforeSend={analyticsEvent} />;
}
