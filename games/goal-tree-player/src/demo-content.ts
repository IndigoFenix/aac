// Built-in demo content: the flagship "picnic" game from the v2 plan. Its
// layout comes from the shared map projector (no hand-authored geometry).
// Once platform wiring exists, the player will receive certified games from
// the platform instead; this file then only serves standalone/dev runs.

import type { GoalTreeGame } from "@shared/goal-tree/types";

export function demoGame(): GoalTreeGame {
  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: {
      title: "Picnic Quest",
      description: "Cross the river and get to the picnic.",
      locale: "en",
      theme: "forest picnic",
      aiCompanion: {
        name: "Dot",
        persona: "Warm and playful. Cheers in short, simple sentences.",
      },
    },
    entities: [
      { id: "picnic_blanket", kind: "marker", label: "Picnic", iconRef: "🧺" },
      { id: "broken_bridge", kind: "obstacle", label: "Broken bridge", iconRef: "🌉" },
      { id: "gate", kind: "obstacle", label: "Gate", iconRef: "🚧" },
      { id: "squirrel", kind: "character", label: "Squirrel", iconRef: "🐿️" },
      { id: "log", kind: "item", label: "Log", iconRef: "🪵" },
      { id: "acorn", kind: "item", label: "Acorn", iconRef: "🌰" },
    ],
    root: {
      type: "reach",
      id: "picnic",
      outro: "We made it to the picnic!",
      markerEntityId: "picnic_blanket",
      zoneHint: "sunny riverbank",
      via: [
        {
          type: "overcome",
          id: "bridge_out",
          obstacleEntityId: "broken_bridge",
          prompt: "The bridge is out! We need three logs to fix it.",
          key: {
            type: "collect",
            id: "gather_logs",
            intro: "Let's find three logs.",
            outro: "Three logs! That's enough to fix the bridge.",
            itemEntityIds: ["log"],
            count: 3,
            distractorEntityIds: ["acorn"],
            zoneHint: "log forest",
            placements: [
              { count: 2 },
              {
                count: 1,
                via: [
                  {
                    type: "overcome",
                    id: "log_gate",
                    obstacleEntityId: "gate",
                    prompt: "The gate is locked. The squirrel knows the way!",
                    key: {
                      type: "choose",
                      id: "match_key",
                      posedByEntityId: "squirrel",
                      prompt: "Which one is a log?",
                      options: [
                        { entityId: "log", correct: true },
                        { entityId: "acorn", feedback: "That is an acorn." },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}
