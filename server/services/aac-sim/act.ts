/**
 * act.ts — A PRESS BECOMES A REAL CLIENT MESSAGE (harness design ④).
 *
 * Law ④: BYPASS THE PIXELS, NEVER THE SERVER. Every action the simulated child
 * takes leaves here as the SAME `ClientMessage` the shipped client would send,
 * built from the same rules (`pressIntentFor`) the real board classifies with.
 * There is no sim-only channel into the coordinator.
 *
 * Some presses are LOCAL — a page link, board Back/Forward, opening the builder
 * — and change only what is on screen. Those return no message and say so, which
 * matters for the count: a local press still costs the child a press, and the
 * harness must record it as one (law ⑥).
 */

import type { BoardButton } from "@shared/schema";
import { pressIntentFor } from "@shared/aac/press-intent";
import type { ClientMessage } from "../dual-agent/live-relay.js";
import type { SimClientModel } from "./client-model.js";
import type { ProjectedCell } from "./project.js";

export interface ActResult {
  /** What to send up, or null when the press was purely local. */
  message: ClientMessage | null;
  /** One line for the transcript, saying what the press DID. */
  note: string;
  /** True when the press changed only the local surface (page nav, back, …). */
  local: boolean;
}

const nothing = (note: string): ActResult => ({ message: null, note, local: true });

/**
 * Press a BOARD cell.
 *
 * The intent classification is the board's own, so a link navigates, an exit
 * exits, a launcher launches and everything else is an utterance — exactly as
 * the child's device would decide it.
 */
export function pressBoardButton(model: SimClientModel, button: BoardButton): ActResult {
  // `canNavigateToBoard` is false: the AI dynamic path wires no board loader,
  // so a `toBoardId` link falls through, precisely as it does on the device.
  const intent = pressIntentFor(button, { canNavigateToBoard: false });

  switch (intent.kind) {
    case "navigate-page":
      model.navigate({ type: "to", pageId: intent.pageId });
      return nothing(`opened page ${intent.pageId}`);
    case "page-back":
      model.navigate({ type: "back" });
      return nothing("went back a page");
    case "page-home":
      model.navigate({ type: "home" });
      return nothing("went to the first page");

    case "exit": {
      // THE DIRECTIVE TRAVELS WITH THE PRESS. Home-board buttons carry a tag in
      // `action.text` ([FEELINGS], [HELP], …) and it is the ONLY thing telling
      // the agents what the child meant. Sending an empty instruction — which
      // this did — leaves them a bare "they left the board" to improvise from,
      // and in live runs they improvised into the social trainer over and over.
      const instruction = intent.instruction;

      // Two tags the real client NEVER forwards: it opens the surface itself
      // (home.tsx ~:1952). Forwarding them would both fail to open anything and
      // tell the AI a lie about what the child did.
      if (instruction.includes("[CONSTRUCTION BOARD]")) {
        model.setBuilderOpen(true);
        return { message: null, note: "opened the sentence builder", local: true };
      }
      if (instruction.includes("[APPS BOARD]")) {
        // The apps overlay is not modelled yet — say so rather than pretend the
        // press did nothing.
        return { message: null, note: "opened the apps page (not modelled by the harness)", local: true };
      }

      return {
        message: { type: "board_exit", label: button.label, instruction } as ClientMessage,
        note: `left the board via "${button.label}"${instruction ? ` (${instruction})` : ""}`,
        local: false,
      };
    }

    case "open-app":
      return {
        message: { type: "request_app_open", appId: intent.appId, appData: intent.appData } as unknown as ClientMessage,
        note: `asked to open the ${intent.appId} app`,
        local: false,
      };

    case "open-board":
      return {
        message: { type: "request_board_open", boardKey: intent.boardKey } as unknown as ClientMessage,
        note: `asked for the ${intent.boardKey} board`,
        local: false,
      };

    case "open-website":
      // The device opens the in-frame browser locally; nothing goes up.
      return nothing(`opened the browser at ${intent.url}`);

    case "home-action":
      // A confirmed home action is out of scope for a text driver — it actuates
      // by SPEAKING into the room, which a headless run cannot model honestly.
      return nothing(`pressed the home action ${intent.actionId} (not actuated in a sim run)`);

    case "navigate-board":
      return nothing("board-to-board link (no loader on this path)");

    case "speak":
    default: {
      // THE UTTERANCE PATH. `buttons` carries the label the way the real client
      // does, `sentences` the fuller text behind it, and `board` the client's
      // own board — the server reads all three.
      const label = button.label;
      // `intent.text` is already `spokenText || label`; it only earns a place in
      // `sentences` when it says something the label does not.
      const spoken = intent.kind === "speak" ? intent.text : label;
      return {
        message: {
          type: "button_press",
          buttons: [label],
          ...(spoken && spoken !== label ? { sentences: { [label]: spoken } } : {}),
          board: model.boardForPress() ?? undefined,
        } as ClientMessage,
        note: `said "${label}"`,
        local: false,
      };
    }
  }
}

/** Press a context-strip button. Structurally an utterance, like a board one. */
export function pressContextButton(
  model: SimClientModel,
  button: { label: string; sentence?: string },
): ActResult {
  return {
    message: {
      type: "button_press",
      buttons: [button.label],
      sentences: button.sentence ? { [button.label]: button.sentence } : undefined,
      board: model.boardForPress() ?? undefined,
    } as ClientMessage,
    note: `said "${button.label}" from the side strip`,
    local: false,
  };
}

/**
 * Press a quick-action slot. Several are local-only, and the ones that ARE
 * messages are not all utterances — More is a request to the Board Manager,
 * Guess is a mode change.
 */
export function pressQuickAction(
  model: SimClientModel,
  id: string,
  label: string,
): ActResult {
  switch (id) {
    case "yes":
    case "no":
      return {
        message: {
          type: "button_press",
          buttons: [label],
          board: model.boardForPress() ?? undefined,
        } as ClientMessage,
        note: `answered "${label}"`,
        local: false,
      };

    case "more":
      // Not an utterance: a direct ask for more options, which the real client
      // sends as the literal "[MORE]" button token. It must produce no speech.
      return {
        message: {
          type: "button_press",
          buttons: ["[MORE]"],
          board: model.boardForPress() ?? undefined,
        } as ClientMessage,
        note: "asked for more options",
        local: false,
      };

    case "guess":
      return model.status().guessing
        ? { message: { type: "exit_guessing" } as ClientMessage, note: "left the word finder", local: false }
        : { message: { type: "guessing_enter" } as ClientMessage, note: "opened the word finder", local: false };

    case "speak":
      model.setBuilderOpen(!model.status().builderOpen);
      return {
        message: {
          type: model.status().builderOpen ? "builder_open" : "builder_close",
        } as ClientMessage,
        note: model.status().builderOpen ? "opened the sentence builder" : "closed the sentence builder",
        local: false,
      };

    case "boardback":
      return nothing(model.goBack() ? "stepped back to the previous board" : "pressed Back, but it was dimmed");
    case "boardforward":
      return nothing(model.goForward() ? "stepped forward a board" : "pressed Forward, but there was nothing ahead");

    case "boardpause": {
      const next = !model.status().paused;
      model.setPaused(next);
      return {
        message: { type: "set_paused", paused: next } as unknown as ClientMessage,
        note: next ? "held the board still" : "let the board move again",
        local: false,
      };
    }

    case "home":
    case "back":
      model.navigate({ type: "home" });
      return nothing("went back to the main board");

    case "exit": {
      // `app_dismissed` requires the app's id — the server uses it to decide
      // what it is tearing down. Without one there is nothing to dismiss.
      const appId = model.status().activeApp;
      if (!appId) return nothing("pressed Exit with no app open");
      return {
        message: { type: "app_dismissed", appId } as ClientMessage,
        note: `closed the ${appId} app`,
        local: false,
      };
    }

    default:
      return nothing(`pressed ${id}, which does nothing here`);
  }
}

/**
 * Answer a binary-choice overlay. The escape option ("maybe" / "neither") is a
 * real answer and is sent as one — a child refusing both is information, and
 * swallowing it would make every overlay look answered.
 */
export function pressOverlayOption(model: SimClientModel, label: string): ActResult {
  model.clearBinaryChoice();
  return {
    message: {
      type: "button_press",
      buttons: [label],
      board: model.boardForPress() ?? undefined,
    } as ClientMessage,
    note: `answered the question with "${label}"`,
    local: false,
  };
}

/**
 * Route a projected cell back to the right press. The child names a NUMBER; the
 * harness must land on the same button the number was printed for, whichever
 * surface it came from (law ③).
 */
export function pressCell(
  model: SimClientModel,
  cell: ProjectedCell,
  resolve: {
    boardButton: (index: number) => BoardButton | null;
    contextButton: (index: number) => { label: string; sentence?: string } | null;
    quickAction: (index: number) => { id: string; label: string } | null;
    overlayOption: (index: number) => string | null;
  },
  indexWithinSurface: number,
): ActResult {
  switch (cell.where) {
    case "board": {
      const b = resolve.boardButton(indexWithinSurface);
      if (!b) return nothing("pressed an empty cell");
      return pressBoardButton(model, b);
    }
    case "context": {
      const c = resolve.contextButton(indexWithinSurface);
      return c ? pressContextButton(model, c) : nothing("pressed a side button that is gone");
    }
    case "quick": {
      const q = resolve.quickAction(indexWithinSurface);
      return q ? pressQuickAction(model, q.id, q.label) : nothing("pressed a control that is gone");
    }
    case "overlay": {
      const o = resolve.overlayOption(indexWithinSurface);
      return o ? pressOverlayOption(model, o) : nothing("pressed an option that is gone");
    }
    // Builder surfaces (tab / chip / control) are routed by the runner's
    // `actBuilder`, not here — this helper only knows the board screen.
    default:
      return nothing(`pressed a ${cell.where}, which the board surface does not have`);
  }
}
