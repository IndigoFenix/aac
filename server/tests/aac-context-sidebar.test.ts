import { describe, it, expect } from "@jest/globals";
import {
  addContextButton,
  applyContextSymbolUpdate,
  CONTEXT_BUTTON_LIMIT,
  removeContextButton,
  type ContextButton,
} from "@shared/aac/context-sidebar";

const b = (label: string, extra: Partial<ContextButton> = {}): ContextButton => ({
  label,
  iconRef: "🔵",
  ...extra,
});

const labels = (l: ContextButton[]) => l.map((x) => x.label);

describe("addContextButton", () => {
  it("appends to the end", () => {
    expect(labels(addContextButton([b("dog")], b("grandma")))).toEqual(["dog", "grandma"]);
  });

  it("pushes the OLDEST out once full", () => {
    const full = [b("a"), b("b"), b("c"), b("d")];
    expect(full).toHaveLength(CONTEXT_BUTTON_LIMIT);
    expect(labels(addContextButton(full, b("e")))).toEqual(["b", "c", "d", "e"]);
  });

  it("honours a caller-supplied cap", () => {
    expect(labels(addContextButton([b("a"), b("b")], b("c"), 2))).toEqual(["b", "c"]);
  });

  it("does not mutate the list it was given", () => {
    const before = [b("a")];
    addContextButton(before, b("z"));
    expect(labels(before)).toEqual(["a"]);
  });
});

describe("removeContextButton", () => {
  it("removes by label, ignoring case", () => {
    expect(labels(removeContextButton([b("Dog"), b("cat")], "dog"))).toEqual(["cat"]);
  });

  it("ignores an empty label rather than clearing the strip", () => {
    const list = [b("dog")];
    expect(removeContextButton(list, "")).toBe(list);
  });

  it("is a no-op for a label that is not there", () => {
    expect(labels(removeContextButton([b("dog")], "hamster"))).toEqual(["dog"]);
  });
});

describe("applyContextSymbolUpdate", () => {
  it("attaches the generated symbol, matching case-insensitively", () => {
    // The regression this replaces: home.tsx compared byte-exact while the
    // provider compared lowercased, so a symbol landed on one strip only.
    const next = applyContextSymbolUpdate([b("Dog"), b("cat")], {
      buttonLabel: "dog",
      symbolPath: "/s/dog.svg",
    });
    expect(next[0].symbolPath).toBe("/s/dog.svg");
    expect(next[1].symbolPath).toBeUndefined();
  });

  it("leaves the strip alone when nothing matches", () => {
    const next = applyContextSymbolUpdate([b("dog")], { buttonLabel: "fox", symbolPath: "/s/fox.svg" });
    expect(next[0].symbolPath).toBeUndefined();
  });
});
