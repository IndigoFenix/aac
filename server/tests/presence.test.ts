// Tests local person-presence transitions in room-registry. The cross-instance
// aggregation (presence.ts) layers on top via the fanout bus; here we use the
// in-memory bus (publish is a no-op) so the announce hooks don't throw and we
// can assert the local online/offline edge detection that drives them.
import type { WebSocket } from "ws";
import { initBus, stopBus } from "../services/realtime/bus-factory";
import {
  registerPersonSocket,
  removeSocket,
  isPersonOnline,
  localOnlinePersonIds,
  socketsForPerson,
} from "../services/realtime/room-registry";

// A bare object is enough — room-registry only stashes ad-hoc props on the socket.
const fakeSocket = () => ({}) as unknown as WebSocket;

describe("room-registry person presence", () => {
  beforeAll(async () => {
    await initBus(); // memory bus; announce* calls getBus() internally
  });
  afterAll(async () => {
    await stopBus();
  });

  it("reports a person offline until a socket represents them", () => {
    expect(isPersonOnline("p-absent")).toBe(false);
  });

  it("comes online on first socket and stays online across extra sockets", () => {
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    registerPersonSocket("p-multi", s1);
    expect(isPersonOnline("p-multi")).toBe(true);
    expect(localOnlinePersonIds()).toContain("p-multi");

    registerPersonSocket("p-multi", s2);
    expect(socketsForPerson("p-multi")).toHaveLength(2);

    // Dropping one socket keeps the person online (still has the other).
    removeSocket(s1);
    expect(isPersonOnline("p-multi")).toBe(true);

    // Dropping the last socket takes them offline.
    removeSocket(s2);
    expect(isPersonOnline("p-multi")).toBe(false);
    expect(localOnlinePersonIds()).not.toContain("p-multi");
  });

  it("supports one socket fronting several persons (e.g. a user + a student)", () => {
    const s = fakeSocket();
    registerPersonSocket("user-person", s);
    registerPersonSocket("student-person", s);
    expect(isPersonOnline("user-person")).toBe(true);
    expect(isPersonOnline("student-person")).toBe(true);

    // Closing that single socket clears every person it represented.
    removeSocket(s);
    expect(isPersonOnline("user-person")).toBe(false);
    expect(isPersonOnline("student-person")).toBe(false);
  });
});
