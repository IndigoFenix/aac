// client-shared/src/builder/deps.tsx
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// The context that carries `BuilderRenderDeps` down to the leaves. A host wraps
// its whole builder tree ONCE:
//
//   <BuilderDepsProvider value={{ t, rtl: isRTL, GlyphComponent: Glyph, resolveIconPath }}>
//     …sidebar / band / grid…
//   </BuilderDepsProvider>
//
// There is deliberately no default value: a leaf rendered outside the provider
// is a wiring bug, and failing loudly at mount is far cheaper than a board that
// silently shows raw translation keys to a child.

import { createContext, useContext, type ReactNode } from "react";
import type { BuilderRenderDeps } from "./types";

const BuilderDepsContext = createContext<BuilderRenderDeps | null>(null);

export function BuilderDepsProvider(props: { value: BuilderRenderDeps; children: ReactNode }) {
  return (
    <BuilderDepsContext.Provider value={props.value}>{props.children}</BuilderDepsContext.Provider>
  );
}

/** The host's injected behavior. Throws when a leaf is mounted outside the
 *  provider — see the header for why that is the right failure. */
export function useBuilderDeps(): BuilderRenderDeps {
  const deps = useContext(BuilderDepsContext);
  if (!deps) {
    throw new Error(
      "useBuilderDeps: no BuilderDepsProvider above this builder component. " +
        "Wrap the builder tree in <BuilderDepsProvider value={…}>.",
    );
  }
  return deps;
}
