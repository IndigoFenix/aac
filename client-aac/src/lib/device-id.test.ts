// client-aac/src/lib/device-id.test.ts
//
// Guards the precedence between the two copies of the device id. These run in
// jest's `node` environment (no jsdom) because chooseDeviceId is pure — the
// durable copy, the localStorage copy and the generator are all passed in.

import { chooseDeviceId } from "./device-id";

describe("chooseDeviceId", () => {
  const generate = () => "generated-id";

  it("prefers the durable copy and backfills a localStorage copy that drifted", () => {
    // The local id churned (profile reset issued a new one). The durable id is
    // the one the server already has a registration for, so it wins and the
    // local copy is corrected rather than the other way round.
    expect(chooseDeviceId("durable-id", "stale-local-id", generate)).toEqual({
      id: "durable-id",
      writeLocal: true,
      writeDurable: false,
    });
  });

  it("writes nothing when both copies already agree", () => {
    expect(chooseDeviceId("durable-id", "durable-id", generate)).toEqual({
      id: "durable-id",
      writeLocal: false,
      writeDurable: false,
    });
  });

  it("promotes a local-only id into the durable store", () => {
    // The pre-upgrade install: the server knows this id, so keep it and seed
    // the durable copy from it instead of minting a second identity.
    expect(chooseDeviceId(null, "existing-local-id", generate)).toEqual({
      id: "existing-local-id",
      writeLocal: false,
      writeDurable: true,
    });
  });

  it("generates and writes both copies for a genuinely new install", () => {
    expect(chooseDeviceId(null, null, generate)).toEqual({
      id: "generated-id",
      writeLocal: true,
      writeDurable: true,
    });
  });

  it("returns the generated value itself, not a re-generated one", () => {
    // Guards against calling generate() more than once — the id that gets
    // written must be the id that gets returned.
    let calls = 0;
    const counting = () => `id-${++calls}`;
    expect(chooseDeviceId(null, null, counting).id).toBe("id-1");
    expect(calls).toBe(1);
  });
});
