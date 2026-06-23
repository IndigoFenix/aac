// Unit tests for group-chat addressee resolution (priority stack).
import { resolveAddressee, resolveRosterName } from "../services/dual-agent/addressee";

const roster = () =>
  new Map<string, string>([
    ["pB", "Bob"],
    ["pC", "Carol"],
  ]);

const base = {
  me: "pA",
  roster: roster(),
  focus: null as string | null,
  floorAwaiting: null as string | null,
  buttonAddressee: undefined as string | undefined,
};

describe("resolveAddressee", () => {
  it("defaults to ROOM when there is no signal", () => {
    expect(resolveAddressee({ ...base })).toBe("ROOM");
  });

  it("uses an explicit face-focus first (strongest signal)", () => {
    expect(resolveAddressee({ ...base, focus: "pB" })).toBe("pB");
  });

  it("focus wins over a conflicting button tag", () => {
    expect(resolveAddressee({ ...base, focus: "pC", buttonAddressee: "Bob" })).toBe("pC");
  });

  it("falls back to the Board-Manager button tag (peer name → id)", () => {
    expect(resolveAddressee({ ...base, buttonAddressee: "Bob" })).toBe("pB");
    expect(resolveAddressee({ ...base, buttonAddressee: "bob" })).toBe("pB"); // case-insensitive
  });

  it("button tag beats adjacency", () => {
    expect(resolveAddressee({ ...base, buttonAddressee: "Carol", floorAwaiting: "pB" })).toBe("pC");
  });

  it("falls back to adjacency (a peer awaiting a response)", () => {
    expect(resolveAddressee({ ...base, floorAwaiting: "pB" })).toBe("pB");
  });

  it("ignores signals that point at unknown peers / self / ROOM", () => {
    expect(resolveAddressee({ ...base, focus: "ghost" })).toBe("ROOM");
    expect(resolveAddressee({ ...base, focus: "pA" })).toBe("ROOM"); // self
    expect(resolveAddressee({ ...base, buttonAddressee: "ROOM" })).toBe("ROOM");
    expect(resolveAddressee({ ...base, buttonAddressee: "Nobody" })).toBe("ROOM");
    expect(resolveAddressee({ ...base, floorAwaiting: "ghost" })).toBe("ROOM");
  });
});

describe("resolveRosterName", () => {
  it("matches a name case-insensitively", () => {
    expect(resolveRosterName(roster(), "carol")).toBe("pC");
  });
  it("returns null for no match", () => {
    expect(resolveRosterName(roster(), "Dave")).toBeNull();
  });
  it("returns null on an ambiguous name (two peers share it)", () => {
    const dup = new Map([
      ["s1", "Sam"],
      ["s2", "Sam"],
    ]);
    expect(resolveRosterName(dup, "Sam")).toBeNull();
  });
});
