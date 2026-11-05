/**
 * What the team says to each other over tea. Every line is a pair: the first
 * person speaks, the second answers. Lines never name a customer, a supplier
 * or an amount, and never claim work was done: the work is in the team log.
 *
 * Placeholders: {a} the speaker, {b} the one answering, {drink} what {b} drinks,
 * {city}, {festival}, {day} ("tomorrow" or "on Thursday"), {span} ("a month"), {feel}.
 */
export type Topic =
  | "morning"
  | "lunch"
  | "afternoon"
  | "evening"
  | "late"
  | "monday"
  | "friday"
  | "month-end"
  | "festival-soon"
  | "festival-today"
  | "birthday"
  | "anniversary"
  | "rain"
  | "storm"
  | "hot"
  | "clear"
  | "cloudy"
  | "fog"
  | "cool";

export type Exchange = readonly [string, string];

export const PHRASES: Record<Topic, readonly Exchange[]> = {
  morning: [
    ["Morning, {b}. {drink}?", "Please. It's going to be one of those days."],
    ["Good morning, {b}.", "Morning, {a}. You're in early."],
    ["Morning. Did you get a seat on the bus?", "Standing all the way. Tea first, then the world."],
  ],
  lunch: [
    ["Lunch, {b}?", "Give me ten minutes. I'll meet you by the kettle."],
    ["What did you bring today?", "Lemon rice. There's enough for two."],
    ["Is the canteen open?", "Only the dosa counter. That's enough for me."],
  ],
  afternoon: [
    ["Afternoon slump, {b}?", "A {drink} will fix it."],
    ["Biscuits are in the top drawer.", "You are a good colleague, {a}."],
  ],
  evening: [
    ["Still here, {b}?", "Nearly done. You go ahead."],
    ["Leaving soon?", "After one more cup. The traffic can wait."],
  ],
  late: [
    ["Quiet at this hour.", "The best time to think, {a}."],
    ["Go home, {b}.", "Soon. The night watchman makes good chai."],
  ],
  monday: [
    ["How was the weekend, {b}?", "Too short, as always."],
    ["Monday again.", "And the kettle still works. Small mercies."],
  ],
  friday: [
    ["Any plans for the weekend, {b}?", "Family lunch, and a long nap."],
    ["Nearly the weekend.", "I can hear it from here, {a}."],
  ],
  "month-end": [
    ["Last working day of the month.", "Then it's a long one. I'll make the tea."],
    ["Month end, {b}.", "I know. I've hidden the good biscuits."],
  ],
  "festival-soon": [
    ["{festival} {day}. Going home, {b}?", "Yes, the whole family will be there."],
    ["Have you done your {festival} shopping?", "Not yet. The markets will be packed."],
    ["{festival} is {day}.", "Already? This year has flown, {a}."],
  ],
  "festival-today": [
    ["Happy {festival}, {b}.", "And to you, {a}. There are sweets by the kettle."],
    ["Happy {festival}!", "Same to you. Leaving early tonight?"],
  ],
  birthday: [
    ["Happy birthday, {b}!", "Thank you, {a}. There's cake in the pantry."],
    ["Many happy returns, {b}.", "Thank you. Don't ask me how old."],
  ],
  anniversary: [
    ["It's been {span} since you joined, {b}.", "Has it? It feels like last week."],
    ["{span} with us today, {b}.", "And I still can't find the stapler."],
  ],
  rain: [
    ["Raining in {city}. Did you bring an umbrella, {b}?", "Never. I'll wait it out with a {drink}."],
    ["Listen to that rain.", "Perfect weather for pakoras, {a}."],
  ],
  storm: [
    ["Thunder over {city}. Stay in for a bit, {b}.", "No argument from me."],
    ["What a storm.", "I hope the power holds, {a}."],
  ],
  hot: [
    ["It's {feel} out there in {city}.", "Then I'm not moving from under this fan."],
    ["Too hot for {drink}, {b}?", "It's never too hot for {drink}."],
  ],
  clear: [
    ["Lovely day in {city}.", "Shame to spend it indoors, {a}."],
    ["Clear skies today, {b}.", "Good. My washing might actually dry."],
  ],
  cloudy: [
    ["Grey skies over {city} today.", "Good weather for staying in, {a}."],
    ["Looks like it might rain.", "It's been looking like that all week."],
  ],
  fog: [
    ["Foggy this morning in {city}.", "My train crawled all the way."],
    ["Can you see across the road?", "Barely, {a}."],
  ],
  cool: [
    ["Cool in {city} today, {b}.", "Finally. I've brought my shawl out."],
    ["Chilly this morning.", "Weather for a hot {drink}, {a}."],
  ],
};

/** Fills a line's placeholders; a missing value leaves the placeholder's word out. */
export function fill(line: string, values: Partial<Record<"a" | "b" | "drink" | "city" | "festival" | "day" | "span" | "feel", string>>): string {
  const out = line.replace(/\{(\w+)\}/g, (_, k: string) => values[k as keyof typeof values] ?? "");
  const tidy = out.replace(/\s+([,.?!])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
}
