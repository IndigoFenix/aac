import { LLMProvider } from "./llmProvider";
import { OpenAIProvider } from "./providers/openai";
import { ParsedBoardData, GeneratedBoardUpdate, GeneratedButtonSpec } from "./types";
import { symbolService } from "./symbolService";

/**
 * Board Generation Service - Business Logic Layer
 * 
 * Uses minimal LLM providers for API calls.
 * All AAC-specific logic lives here, not in providers.
 */
export class BoardGenerationService {
  private provider: LLMProvider;

  constructor(providerType: "openai" = "openai") {
    this.provider = this.createProvider(providerType);
    console.log(`BoardGenerationService initialized with ${this.provider.name}`);
  }

  setProvider(providerType: "openai"): void {
    this.provider = this.createProvider(providerType);
    console.log(`Switched to ${this.provider.name}`);
  }

  getCurrentProvider(): string {
    return this.provider.name;
  }

  /**
   * Main entry point for board generation
   */
  async runBoardGeneration(
    prompt: string,
    requestedGridSize?: { rows: number; cols: number },
    userId?: string,
    promptId?: string,
    context?: {
      boardContext?: ParsedBoardData | null;
      currentPageId?: string | null;
    }
  ): Promise<ParsedBoardData> {
    const existingBoard = context?.boardContext ?? null;
    const existingCurrentPageId = context?.currentPageId ?? null;

    // UPDATE MODE
    if (existingBoard && existingBoard.pages?.length && existingCurrentPageId) {
      const updated = await this.updateBoard(
        prompt,
        existingBoard,
        existingCurrentPageId
      );
      return updated;
    }

    // CREATION MODE
    const board = await this.generateBoard(prompt, requestedGridSize);
    return board;
  }

  /**
   * Generate a new board
   */
  private async generateBoard(
    prompt: string,
    gridSize?: { rows: number; cols: number }
  ): Promise<ParsedBoardData> {
    try {
      const grid = gridSize || { rows: 3, cols: 3 };

      // Use minimal provider to make LLM call
      const response = await this.provider.complete({
        messages: [
          { role: "system", content: this.getSystemPrompt() },
          { role: "user", content: this.getBoardGenerationPrompt(prompt, grid) }
        ],
        responseFormat: { type: "json_object" },
        temperature: this.getTemperature(),
        maxTokens: 2048,
        stopSequences: ["...", ". . ."]
      });

      // Parse and process response (business logic)
      const aiResponse = JSON.parse(response.content);
      this.sanitizeResponse(aiResponse);
      
      return await this.processAIResponse(aiResponse, grid);

    } catch (error) {
      console.error("Board generation failed:", error);
      return this.createFallbackBoard(prompt, gridSize);
    }
  }

  /**
   * Update an existing board
   */
  private async updateBoard(
    prompt: string,
    currentBoard: ParsedBoardData,
    currentPageId: string
  ): Promise<ParsedBoardData> {
    try {
      const context = this.buildMinimalContext(currentBoard, currentPageId);

      // Define response schema for updates
      const responseSchema = {
        type: "object",
        properties: {
          summary: { type: "string" },
          newPages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" }
              },
              required: ["id", "name"]
            }
          },
          newButtons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", maxLength: 30 },
                spokenText: { type: "string", maxLength: 100 },
                color: { type: "string" },
                iconRef: { type: "string" },
                row: { type: "integer" },
                col: { type: "integer" },
                pageId: { type: "string" },
                selfClosing: { type: "boolean" },
                linkPageId: { type: "string" }
              },
              required: ["label", "pageId"]
            }
          },
          deletedPageIds: {
            type: "array",
            items: { type: "string" }
          },
          deletedButtonIds: {
            type: "array",
            items: { type: "string" }
          },
          editedButtons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string", maxLength: 30 },
                spokenText: { type: "string", maxLength: 100 },
                color: { type: "string" },
                iconRef: { type: "string" },
                row: { type: "integer" },
                col: { type: "integer" },
                pageId: { type: "string" },
                selfClosing: { type: "boolean" },
                linkPageId: { type: "string" }
              },
              required: ["id"]
            }
          }
        },
        required: ["summary", "newPages", "newButtons"]
      };

      // Use minimal provider to make LLM call
      const response = await this.provider.complete({
        messages: [
          { role: "system", content: this.getUpdateSystemPrompt() },
          { role: "user", content: this.getBoardUpdatePrompt(prompt, context) }
        ],
        responseFormat: { 
          type: "json_object",
          schema: responseSchema 
        },
        temperature: this.getTemperature(),
        maxTokens: 2048,
        stopSequences: ["...", ". . ."]
      });

      console.log("Update response:", response.content);

      // Parse and process response (business logic)
      const update: GeneratedBoardUpdate = JSON.parse(response.content);
      this.sanitizeUpdate(update);

      return await this.applyUpdate(currentBoard, currentPageId, update);

    } catch (error) {
      console.error("Update failed:", error);
      return currentBoard;
    }
  }

  // ============================================
  // Business Logic - Prompts
  // ============================================

  private getSystemPrompt(): string {
    return `You are an AAC board designer. Create communication boards with useful buttons.

For each button provide:
- label (1-3 words max)
- spokenText (natural phrase to speak, max 8 words)
- color (hex code)
- iconRef (FontAwesome class)
- category (needs/emotions/people/activities/objects)
- row, col (0-indexed, optional)

Color guide: needs=#3B82F6, emotions=#F59E0B, people=#EC4899, activities=#EAB308, objects=#6B7280, yes/no=#059669/#DC2626

Return JSON: {"boardName": "name", "gridSize": {"rows": 3, "cols": 3}, "buttons": [...]}`;
  }

  private getUpdateSystemPrompt(): string {
    return `AAC board designer for updates.

RULES:
- By default, ONLY ADD new pages/buttons (never delete or edit)
- ONLY delete or edit if explicitly requested by the user
- Keep spokenText SHORT (max 8 words)
- Label must be 1-3 words

RESPONSE FORMAT:
{
  "summary": "Brief description",
  "newPages": [
    {"id": "emotions-page", "name": "Emotions"}
  ],
  "newButtons": [
    {
      "label": "Happy",
      "spokenText": "I am happy",
      "pageId": "current-page-id",
      "selfClosing": true
    }
  ],
  "deletedPageIds": ["page-id-to-delete"],  // ONLY if user asks to delete
  "deletedButtonIds": ["btn-id-to-delete"], // ONLY if user asks to delete
  "editedButtons": [                        // ONLY if user asks to edit
    {
      "id": "btn-id",
      "label": "New Label",
      "spokenText": "New text"
    }
  ]
}

DELETION (only when explicitly requested):
- deletedPageIds: Array of page IDs to remove
- deletedButtonIds: Array of button IDs to remove
- Deleting a page deletes all its buttons

EDITING (only when explicitly requested):
- editedButtons: Array of button changes
- Include "id" (required) and fields to change
- Can change label, text, color, position, page, link

NAVIGATION:
- Set "linkPageId" to make a button link to another page
- Use any page ID (existing or newly created)

POSITIONING:
- Set row/col (0-indexed) or leave blank for auto-positioning`;
  }

  private getBoardGenerationPrompt(prompt: string, grid: { rows: number; cols: number }): string {
    return `Create board for: "${prompt}"
Grid: ${grid.rows}x${grid.cols}`;
  }

  private getBoardUpdatePrompt(prompt: string, context: any): string {
    return `Update request: "${prompt}"

Context: ${JSON.stringify(context)}`;
  }

  // ============================================
  // Business Logic - Provider-specific settings
  // ============================================

  private getTemperature(): number {
    return 0.3;
  }

  // ============================================
  // Business Logic - Sanitization
  // ============================================

  private sanitizeResponse(aiResponse: any): void {
    if (!aiResponse.buttons || !Array.isArray(aiResponse.buttons)) return;

    for (const button of aiResponse.buttons) {
      // Just enforce length limits (OpenAI doesn't have repetition issues)
      if (button.label && button.label.length > 30) {
        button.label = button.label.substring(0, 30);
      }
      if (button.spokenText && button.spokenText.length > 100) {
        button.spokenText = button.spokenText.substring(0, 100);
      }
    }
  }

  private sanitizeUpdate(update: GeneratedBoardUpdate): void {
    // Sanitize new buttons
    for (const button of update.newButtons) {
      if (button.label && button.label.length > 30) {
        button.label = button.label.substring(0, 30);
      }
      if (button.spokenText && button.spokenText.length > 100) {
        button.spokenText = button.spokenText.substring(0, 100);
      }
    }
    
    // Sanitize edited buttons
    if (update.editedButtons) {
      for (const button of update.editedButtons) {
        if (button.label && button.label.length > 30) {
          button.label = button.label.substring(0, 30);
        }
        if (button.spokenText && button.spokenText.length > 100) {
          button.spokenText = button.spokenText.substring(0, 100);
        }
      }
    }
  }

  // ============================================
  // Business Logic - Context Building
  // ============================================

  private buildMinimalContext(board: ParsedBoardData, pageId: string) {
    const page = board.pages.find(p => p.id === pageId);
    
    return {
      boardName: board.name,
      gridSize: board.grid,
      currentPageId: pageId,
      currentPage: {
        name: page?.name || "Unknown",
        buttonCount: page?.buttons.length || 0,
        buttons: page?.buttons.map(b => ({
          id: b.id,
          label: b.label,
          row: b.row,
          col: b.col
        })) || []
      },
      allPages: board.pages.map(p => ({
        id: p.id,
        name: p.name,
        buttonCount: p.buttons.length,
        buttons: p.buttons.map(b => ({
          id: b.id,
          label: b.label,
          row: b.row,
          col: b.col
        }))
      }))
    };
  }

  // ============================================
  // Business Logic - Symbol Enhancement
  // ============================================

  private async batchEnhanceWithSymbols(buttons: any[]): Promise<void> {
    const symbolMap = new Map<string, any>();

    for (const label of buttons.map(b => b.label)) {
      try {
        const symbols = await symbolService.searchSymbols(label, 1);
        if (symbols.length > 0) {
          symbolMap.set(label, symbols[0]);
        }
      } catch (error) {
        // Silent fail
      }
    }

    for (const button of buttons) {
      const symbol = symbolMap.get(button.label);
      if (symbol) {
        button.symbolPath = `/api/symbols/svg/${symbol.filename}`;
      }
    }
  }

  // ============================================
  // Business Logic - Board Processing
  // ============================================

  private async processAIResponse(
    aiResponse: any,
    gridSize: { rows: number; cols: number }
  ): Promise<ParsedBoardData> {
    const aiButtons = (aiResponse.buttons || []).slice(0, gridSize.rows * gridSize.cols);
    await this.batchEnhanceWithSymbols(aiButtons);

    const buttons = [];
    const occupiedPositions = new Set<string>();
    let buttonId = 1;

    for (const aiButton of aiButtons) {
      const { row, col } = this.findPosition(
        aiButton.row,
        aiButton.col,
        gridSize,
        occupiedPositions
      );

      buttons.push({
        id: `btn-${buttonId++}`,
        row,
        col,
        label: aiButton.label,
        spokenText: aiButton.spokenText || aiButton.label,
        color: aiButton.color || "#6B7280",
        iconRef: aiButton.iconRef || "fas fa-comment",
        symbolPath: aiButton.symbolPath,
        action: { type: "speak", text: aiButton.spokenText || aiButton.label }
      });
    }

    return {
      name: aiResponse.boardName || "Generated Board",
      grid: gridSize,
      pages: [{
        id: "page-1",
        name: "Main Page",
        buttons,
        layout: gridSize
      }]
    };
  }

  private async applyUpdate(
    currentBoard: ParsedBoardData,
    currentPageId: string,
    update: GeneratedBoardUpdate
  ): Promise<ParsedBoardData> {
    let newPages = [...currentBoard.pages];
    
    // Step 1: Delete pages (if requested)
    if (update.deletedPageIds && update.deletedPageIds.length > 0) {
      newPages = newPages.filter(p => !update.deletedPageIds!.includes(p.id));
    }
    
    // Step 2: Delete buttons (if requested)
    if (update.deletedButtonIds && update.deletedButtonIds.length > 0) {
      for (const page of newPages) {
        page.buttons = page.buttons.filter(b => !update.deletedButtonIds!.includes(b.id));
      }
    }
    
    // Step 3: Edit buttons (if requested)
    if (update.editedButtons && update.editedButtons.length > 0) {
      for (const edit of update.editedButtons) {
        // Find the button across all pages
        for (const page of newPages) {
          const buttonIndex = page.buttons.findIndex(b => b.id === edit.id);
          if (buttonIndex !== -1) {
            const button = page.buttons[buttonIndex];
            
            // If moving to a different page, remove from current page
            if (edit.pageId && edit.pageId !== page.id) {
              page.buttons.splice(buttonIndex, 1);
              
              // Find target page and add there (will be processed below)
              const targetPage = newPages.find(p => p.id === edit.pageId);
              if (targetPage) {
                // Update button properties
                const updatedButton = { ...button };
                if (edit.label !== undefined) updatedButton.label = edit.label;
                if (edit.spokenText !== undefined) updatedButton.spokenText = edit.spokenText;
                if (edit.color !== undefined) updatedButton.color = edit.color;
                if (edit.iconRef !== undefined) updatedButton.iconRef = edit.iconRef;
                if (edit.selfClosing !== undefined) updatedButton.selfClosing = edit.selfClosing;
                
                // Handle position
                const occupiedPositions = new Set(
                  targetPage.buttons.map(b => `${b.row},${b.col}`)
                );
                const { row, col } = this.findPosition(
                  edit.row,
                  edit.col,
                  currentBoard.grid,
                  occupiedPositions
                );
                updatedButton.row = row;
                updatedButton.col = col;
                
                // Handle action
                if (edit.linkPageId !== undefined) {
                  updatedButton.action = { type: "link", toPageId: edit.linkPageId };
                }
                
                targetPage.buttons.push(updatedButton);
              }
            } else {
              // Edit in place
              if (edit.label !== undefined) button.label = edit.label;
              if (edit.spokenText !== undefined) button.spokenText = edit.spokenText;
              if (edit.color !== undefined) button.color = edit.color;
              if (edit.iconRef !== undefined) button.iconRef = edit.iconRef;
              if (edit.selfClosing !== undefined) button.selfClosing = edit.selfClosing;
              
              // Update position if specified
              if (edit.row !== undefined || edit.col !== undefined) {
                const occupiedPositions = new Set(
                  page.buttons
                    .filter(b => b.id !== button.id)
                    .map(b => `${b.row},${b.col}`)
                );
                const { row, col } = this.findPosition(
                  edit.row ?? button.row,
                  edit.col ?? button.col,
                  currentBoard.grid,
                  occupiedPositions
                );
                button.row = row;
                button.col = col;
              }
              
              // Update action if link changed
              if (edit.linkPageId !== undefined) {
                button.action = { type: "link", toPageId: edit.linkPageId };
              } else if (edit.spokenText !== undefined && !edit.linkPageId) {
                // If changed spoken text and not a link, update speak action
                button.action = { type: "speak", text: edit.spokenText };
              }
            }
            break;
          }
        }
      }
    }
    
    // Step 4: Create new pages (empty for now)
    for (const pageSpec of update.newPages) {
      // Check if page already exists
      if (!newPages.find(p => p.id === pageSpec.id)) {
        newPages.push({
          id: pageSpec.id,
          name: pageSpec.name,
          buttons: [],
          layout: currentBoard.grid
        });
      }
    }
    
    // Step 5: Add all new buttons to their respective pages
    for (const buttonSpec of update.newButtons) {
      const targetPage = newPages.find(p => p.id === buttonSpec.pageId);
      
      if (!targetPage) {
        console.warn(`Page ${buttonSpec.pageId} not found, skipping button ${buttonSpec.label}`);
        continue;
      }
      
      // Enhance with symbols
      await this.batchEnhanceWithSymbols([buttonSpec]);
      
      // Find position
      const occupiedPositions = new Set(
        targetPage.buttons.map(b => `${b.row},${b.col}`)
      );
      
      const { row, col } = this.findPosition(
        buttonSpec.row,
        buttonSpec.col,
        currentBoard.grid,
        occupiedPositions
      );
      
      // Determine action
      const action = buttonSpec.linkPageId
        ? { type: "link", toPageId: buttonSpec.linkPageId }
        : { type: "speak", text: buttonSpec.spokenText || buttonSpec.label };
      
      // Add button to page
      targetPage.buttons.push({
        id: `btn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        row,
        col,
        label: buttonSpec.label,
        spokenText: buttonSpec.spokenText || buttonSpec.label,
        color: buttonSpec.color || "#6B7280",
        iconRef: buttonSpec.iconRef || "fas fa-comment",
        symbolPath: (buttonSpec as any).symbolPath,
        selfClosing: buttonSpec.selfClosing,
        action
      });
    }
    
    return { ...currentBoard, pages: newPages };
  }

  // ============================================
  // Business Logic - Positioning
  // ============================================

  private findPosition(
    requestedRow: number | undefined,
    requestedCol: number | undefined,
    grid: { rows: number; cols: number },
    occupiedPositions: Set<string>
  ): { row: number; col: number } {
    // If position specified and valid, try to use it
    if (requestedRow !== undefined && requestedCol !== undefined) {
      const row = Math.max(0, Math.min(requestedRow, grid.rows - 1));
      const col = Math.max(0, Math.min(requestedCol, grid.cols - 1));
      
      if (!occupiedPositions.has(`${row},${col}`)) {
        occupiedPositions.add(`${row},${col}`);
        return { row, col };
      }
    }

    // Find next available position
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        if (!occupiedPositions.has(`${row},${col}`)) {
          occupiedPositions.add(`${row},${col}`);
          return { row, col };
        }
      }
    }

    // Grid full - return 0,0
    return { row: 0, col: 0 };
  }

  // ============================================
  // Business Logic - Fallback
  // ============================================

  private createFallbackBoard(prompt: string, gridSize?: { rows: number; cols: number }): ParsedBoardData {
    const grid = gridSize || { rows: 3, cols: 3 };
    
    return {
      name: "Communication Board",
      grid,
      pages: [{
        id: "page-1",
        name: "Main Page",
        buttons: [
          { id: "btn-1", row: 0, col: 0, label: "Yes", spokenText: "Yes", color: "#10B981", iconRef: "fas fa-check", action: { type: "speak", text: "Yes" } },
          { id: "btn-2", row: 0, col: 1, label: "No", spokenText: "No", color: "#EF4444", iconRef: "fas fa-times", action: { type: "speak", text: "No" } },
          { id: "btn-3", row: 0, col: 2, label: "Help", spokenText: "I need help", color: "#EAB308", iconRef: "fas fa-question", action: { type: "speak", text: "I need help" } }
        ],
        layout: grid
      }]
    };
  }

  // ============================================
  // Provider Factory
  // ============================================

  private createProvider(type: "openai"): LLMProvider {
    return new OpenAIProvider();
  }
}

// Export singleton with OpenAI default
export const boardGenerator = new BoardGenerationService("openai");

// Legacy compatibility
export const geminiGenerator = boardGenerator;