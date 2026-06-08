// Verifies the BoardManager tool schema is trimmed per-invocation —
// legacy `sentence`/`fallback` fields are no longer declared on any
// tool, and guessing-mode fields (`kind`/`dimension`/`value`/`poles`)
// only appear when `guessingActive` is true. This is a MALFORMED-rate
// fix: Gemini Flash struggles with fat alternative-branch schemas, so
// the per-invocation surface should be as narrow as possible.

import {
  buildBoardManagerToolDeclarations,
  type BoardManagerToolConfig,
} from "../services/dual-agent/tool-declarations-board-manager";

function getButtonProps(
  decls: ReturnType<typeof buildBoardManagerToolDeclarations>,
  toolName: string,
): Record<string, any> {
  const fd = decls[0].functionDeclarations!.find(d => d.name === toolName)!;
  const params = fd.parametersJsonSchema as any;
  // rebuild_board: buttons[].items.properties
  // add_board_button: button.properties
  // add_context_button: button.properties
  // show_binary_choice: option1.properties (and option2)
  if (toolName === "rebuild_board") {
    return params.properties.buttons.items.properties;
  }
  if (toolName === "add_board_button") {
    return params.properties.button.properties;
  }
  if (toolName === "add_context_button") {
    return params.properties.button.properties;
  }
  if (toolName === "show_binary_choice") {
    return params.properties.option1.properties;
  }
  throw new Error(`No mapping for ${toolName}`);
}

const baseConfig: BoardManagerToolConfig = {
  availableBoards: [],
  hasLoadedBoard: false,
};

describe("BoardManager schema trim", () => {
  test("legacy sentence/fallback fields are NEVER declared on any tool", () => {
    const decls = buildBoardManagerToolDeclarations({
      ...baseConfig,
      guessingActive: true, // even in maximally-permissive mode
    });
    for (const toolName of ["rebuild_board", "add_board_button", "add_context_button", "show_binary_choice"]) {
      const props = getButtonProps(decls, toolName);
      expect(props).not.toHaveProperty("sentence");
      expect(props).not.toHaveProperty("fallback");
    }
  });

  test("guessing-mode fields excluded by default (guessingActive=false)", () => {
    const decls = buildBoardManagerToolDeclarations({
      ...baseConfig,
      guessingActive: false,
    });
    for (const toolName of ["rebuild_board", "add_board_button"]) {
      const props = getButtonProps(decls, toolName);
      expect(props).not.toHaveProperty("kind");
      expect(props).not.toHaveProperty("dimension");
      expect(props).not.toHaveProperty("value");
      expect(props).not.toHaveProperty("poles");
    }
  });

  test("guessing-mode fields included when guessingActive=true", () => {
    const decls = buildBoardManagerToolDeclarations({
      ...baseConfig,
      guessingActive: true,
    });
    for (const toolName of ["rebuild_board", "add_board_button"]) {
      const props = getButtonProps(decls, toolName);
      expect(props).toHaveProperty("kind");
      expect(props).toHaveProperty("dimension");
      expect(props).toHaveProperty("value");
      expect(props).toHaveProperty("poles");
    }
  });

  test("META button_type only on rebuild_board / add_board_button (not sidebar or binary)", () => {
    const decls = buildBoardManagerToolDeclarations({
      ...baseConfig,
      guessingActive: false,
    });
    expect(getButtonProps(decls, "rebuild_board")).toHaveProperty("button_type");
    expect(getButtonProps(decls, "add_board_button")).toHaveProperty("button_type");
    expect(getButtonProps(decls, "add_context_button")).not.toHaveProperty("button_type");
    expect(getButtonProps(decls, "show_binary_choice")).not.toHaveProperty("button_type");
  });

  test("guessing fields stay off binary-choice + sidebar even when guessing active", () => {
    const decls = buildBoardManagerToolDeclarations({
      ...baseConfig,
      guessingActive: true,
    });
    for (const toolName of ["add_context_button", "show_binary_choice"]) {
      const props = getButtonProps(decls, toolName);
      expect(props).not.toHaveProperty("kind");
      expect(props).not.toHaveProperty("poles");
    }
  });

  test("core fields (speech, glyph, label) always present on every button shape", () => {
    const decls = buildBoardManagerToolDeclarations({
      ...baseConfig,
      guessingActive: false,
    });
    for (const toolName of ["rebuild_board", "add_board_button", "add_context_button", "show_binary_choice"]) {
      const props = getButtonProps(decls, toolName);
      expect(props).toHaveProperty("speech");
      expect(props).toHaveProperty("glyph");
      expect(props).toHaveProperty("label");
    }
  });

  test("no_change tool is always declared (universal fallback)", () => {
    const decls = buildBoardManagerToolDeclarations(baseConfig);
    const names = decls[0].functionDeclarations!.map(d => d.name);
    expect(names).toContain("no_change");
  });
});
