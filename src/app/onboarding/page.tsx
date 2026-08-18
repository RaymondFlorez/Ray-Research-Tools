import type { Metadata } from "next";
import { OnboardingFlow } from "./onboarding-flow";

export const metadata: Metadata = {
  title: "Begin",
  description:
    "Learn the Alpha Movement system and set the training focus that shapes your programming, library, and feed.",
};

export default function OnboardingPage() {
  return <OnboardingFlow />;
}
