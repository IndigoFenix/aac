// The home board swaps its Build-sentence slot for the "Practice friend"
// social-trainer entry when the app is enabled (and leaves it untouched
// otherwise). Pure builder — runs in the standard jest environment.

import { buildDefaultHomeBoard } from "../services/dual-agent/default-home-board";

function buttons(board: ReturnType<typeof buildDefaultHomeBoard>) {
  return (board as any).pages[0].buttons as Array<any>;
}

describe("buildDefaultHomeBoard — Practice friend swap", () => {
  test("disabled: keeps the Build-sentence button, no practice button", () => {
    const b = buttons(buildDefaultHomeBoard("en", false));
    expect(b.some((x) => x.id === "home_construct")).toBe(true);
    expect(b.some((x) => x.id === "home_practice_friend")).toBe(false);
    expect(b.some((x) => x.buttonType === "practice_friend")).toBe(false);
  });

  test("enabled: replaces Build-sentence with Practice friend in the same slot", () => {
    const off = buttons(buildDefaultHomeBoard("en", false));
    const on = buttons(buildDefaultHomeBoard("en", true));
    expect(on.some((x) => x.id === "home_construct")).toBe(false);

    const practice = on.find((x) => x.id === "home_practice_friend");
    expect(practice).toBeTruthy();
    expect(practice.buttonType).toBe("practice_friend");
    expect(practice.action).toEqual({ type: "exit", text: "[PRACTICE FRIEND]" });

    // Occupies the exact grid cell the Build-sentence button used to.
    const construct = off.find((x) => x.id === "home_construct");
    expect(practice.row).toBe(construct.row);
    expect(practice.col).toBe(construct.col);

    // Same button count — a swap, not an addition.
    expect(on.length).toBe(off.length);
  });

  test("defaults to disabled when the flag is omitted", () => {
    const b = buttons(buildDefaultHomeBoard("en"));
    expect(b.some((x) => x.id === "home_practice_friend")).toBe(false);
  });

  test("localizes the practice button label (he)", () => {
    const practice = buttons(buildDefaultHomeBoard("he", true)).find((x) => x.id === "home_practice_friend");
    expect(practice.label).toBe("חבר לתרגול");
  });
});
