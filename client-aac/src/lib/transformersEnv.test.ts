// Serialization guard around transformers.js's mutable env globals.
//
// The bug this exists to prevent is a race, so the tests are mostly about
// interleaving: two overlapping loads must each see THEIR OWN flags at the
// moment they read them, not whichever load set them last.

import { withTransformersEnv } from "./transformersEnv";

function makeEnv() {
  return {
    allowLocalModels: false,
    allowRemoteModels: true,
    localModelPath: "/original/",
    backends: { onnx: { wasm: {} } },
  };
}

/** A deferred, so a test can hold one load open while another starts. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("withTransformersEnv", () => {
  it("applies the requested flags for the duration of the callback", async () => {
    const env = makeEnv();
    const seen: any = {};

    await withTransformersEnv(env, { allowLocal: true, allowRemote: false, localModelPath: "/models/" }, async () => {
      seen.allowLocalModels = env.allowLocalModels;
      seen.allowRemoteModels = env.allowRemoteModels;
      seen.localModelPath = env.localModelPath;
    });

    expect(seen).toEqual({ allowLocalModels: true, allowRemoteModels: false, localModelPath: "/models/" });
  });

  it("restores the previous flags afterwards", async () => {
    const env = makeEnv();
    await withTransformersEnv(env, { allowLocal: true, allowRemote: false, localModelPath: "/models/" }, async () => {});
    expect(env.allowLocalModels).toBe(false);
    expect(env.allowRemoteModels).toBe(true);
    expect(env.localModelPath).toBe("/original/");
  });

  it("restores the flags even when the load throws", async () => {
    const env = makeEnv();
    await expect(
      withTransformersEnv(env, { allowLocal: true, allowRemote: false }, async () => {
        throw new Error("corrupt weights");
      }),
    ).rejects.toThrow("corrupt weights");

    expect(env.allowLocalModels).toBe(false);
    expect(env.allowRemoteModels).toBe(true);
  });

  it("serializes overlapping loads so neither sees the other's flags", async () => {
    // This is the actual field scenario: Kokoro preloads at startup with local
    // weights while wavlm loads lazily from the CDN (or vice versa). Before the
    // guard, the second call's assignment landed inside the first call's await
    // and the first model resolved its fetch against the wrong flags.
    const env = makeEnv();
    const gate = deferred();
    const localSaw: boolean[] = [];
    const remoteSaw: boolean[] = [];

    const first = withTransformersEnv(env, { allowLocal: true, allowRemote: false }, async () => {
      localSaw.push(env.allowLocalModels);
      await gate.promise;                 // hold the first load open
      localSaw.push(env.allowLocalModels); // still true, despite the second call
    });

    const second = withTransformersEnv(env, { allowLocal: false, allowRemote: true }, async () => {
      remoteSaw.push(env.allowLocalModels);
    });

    gate.resolve();
    await Promise.all([first, second]);

    expect(localSaw).toEqual([true, true]);  // first load never lost its flags
    expect(remoteSaw).toEqual([false]);      // second load got its own
  });

  it("keeps running later loads after one rejects", async () => {
    const env = makeEnv();
    await expect(
      withTransformersEnv(env, { allowLocal: true, allowRemote: false }, async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");

    // A wedged chain would make this hang rather than resolve.
    await expect(
      withTransformersEnv(env, { allowLocal: false, allowRemote: true }, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("still runs the load when there is no env object", async () => {
    // Older/mocked transformers builds expose no env; the load must proceed
    // rather than crash on property assignment.
    await expect(
      withTransformersEnv(undefined, { allowLocal: true, allowRemote: false }, async () => "ran"),
    ).resolves.toBe("ran");
  });
});
