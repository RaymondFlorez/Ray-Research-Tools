import type { Metadata } from "next";
import { Container, PageHeader } from "@/components/layout/app-shell";
import { ProfileSettings } from "./profile-settings";
import { CURRENT_USER } from "@/lib/data/people";

export const metadata: Metadata = {
  title: "Profile",
  description:
    "Training focus, level, time zone, calendar connections, reminders, and offline storage.",
};

export default function ProfilePage() {
  return (
    <Container className="max-w-4xl">
      <PageHeader
        eyebrow="Profile"
        title={CURRENT_USER.name}
        description="Your focus shapes library ordering, session proposals, and the Pulse feed. Everything here is adjustable at any time."
      />
      <ProfileSettings />
    </Container>
  );
}
