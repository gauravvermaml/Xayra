/**
 * Home screen's launch greeting (app/index.tsx) — a warm, personal touch
 * shown briefly every time the app opens, then faded out in favor of the
 * screen's normal persistent subtitle (see this app's own "Quiet Corner"
 * decluttering history — a permanent greeting banner would work against
 * that, a brief one doesn't).
 */
export function getTimeBasedGreeting(firstName: string | null): string {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return firstName ? `${timeOfDay}, ${firstName}. What's on your mind…` : `${timeOfDay}. What's on your mind…`;
}
