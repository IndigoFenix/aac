import { BoardIR, ButtonIR, PageIR } from '@/types/board-ir';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateBoard(board: BoardIR): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic board validation
  if (!board.name || board.name.trim().length === 0) {
    errors.push("Board must have a name");
  }

  if (!board.grid || board.grid.rows < 1 || board.grid.cols < 1) {
    errors.push("Board must have valid grid dimensions");
  }

  if (board.grid.rows > 25 || board.grid.cols > 25) {
    errors.push("Grid dimensions cannot exceed 25x25");
  }

  if (!board.pages || board.pages.length === 0) {
    errors.push("Board must have at least one page");
  }

  // Page validation
  board.pages.forEach((page, pageIndex) => {
    const pageErrors = validatePage(page, board.grid, pageIndex);
    errors.push(...pageErrors.errors);
    warnings.push(...pageErrors.warnings);
  });

  // Cross-page navigation validation
  const navigationErrors = validateNavigation(board);
  errors.push(...navigationErrors);

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

function validatePage(page: PageIR, gridSize: { rows: number; cols: number }, pageIndex: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!page.name || page.name.trim().length === 0) {
    errors.push(`Page ${pageIndex + 1} must have a name`);
  }

  if (!page.buttons) {
    errors.push(`Page ${pageIndex + 1} buttons array is missing`);
    return { isValid: false, errors, warnings };
  }

  // Button validation
  const occupiedPositions = new Set<string>();
  
  page.buttons.forEach((button, buttonIndex) => {
    const buttonErrors = validateButton(button, gridSize, pageIndex, buttonIndex);
    errors.push(...buttonErrors.errors);
    warnings.push(...buttonErrors.warnings);

    // Check for position conflicts
    const positionKey = `${button.row}-${button.col}`;
    if (occupiedPositions.has(positionKey)) {
      errors.push(`Page ${pageIndex + 1}: Multiple buttons at position (${button.row}, ${button.col})`);
    } else {
      occupiedPositions.add(positionKey);
    }
  });

  // Check for empty pages
  if (page.buttons.length === 0) {
    warnings.push(`Page ${pageIndex + 1} has no buttons`);
  }

  return { isValid: errors.length === 0, errors, warnings };
}

function validateButton(button: ButtonIR, gridSize: { rows: number; cols: number }, pageIndex: number, buttonIndex: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!button.id || button.id.trim().length === 0) {
    errors.push(`Page ${pageIndex + 1}, Button ${buttonIndex + 1}: Button must have an ID`);
  }

  if (!button.label || button.label.trim().length === 0) {
    errors.push(`Page ${pageIndex + 1}, Button ${buttonIndex + 1}: Button must have a label`);
  }

  if (button.label && button.label.length > 50) {
    warnings.push(`Page ${pageIndex + 1}, Button "${button.label}": Label is very long and may not display properly`);
  }

  // Position validation
  if (button.row < 0 || button.row >= gridSize.rows) {
    errors.push(`Page ${pageIndex + 1}, Button "${button.label}": Row ${button.row} is outside grid bounds (0-${gridSize.rows - 1})`);
  }

  if (button.col < 0 || button.col >= gridSize.cols) {
    errors.push(`Page ${pageIndex + 1}, Button "${button.label}": Column ${button.col} is outside grid bounds (0-${gridSize.cols - 1})`);
  }

  // Color validation
  if (button.color && !isValidColor(button.color)) {
    warnings.push(`Page ${pageIndex + 1}, Button "${button.label}": Color "${button.color}" may not be valid`);
  }

  // Action validation
  if (button.action) {
    const actionErrors = validateAction(button.action, pageIndex, button.label);
    errors.push(...actionErrors);
  }

  // Spoken text validation
  if (button.spokenText && button.spokenText.length > 200) {
    warnings.push(`Page ${pageIndex + 1}, Button "${button.label}": Spoken text is very long`);
  }

  return { isValid: errors.length === 0, errors, warnings };
}

function validateAction(action: ButtonIR['action'], pageIndex: number, buttonLabel: string): string[] {
  const errors: string[] = [];

  if (!action) return errors;

  switch (action.type) {
    case 'speak':
      if (!action.text || action.text.trim().length === 0) {
        errors.push(`Page ${pageIndex + 1}, Button "${buttonLabel}": Speak action must have text`);
      }
      break;
    
    case 'navigate':
      if (!action.toPageId || action.toPageId.trim().length === 0) {
        errors.push(`Page ${pageIndex + 1}, Button "${buttonLabel}": Navigate action must have target page ID`);
      }
      break;
    
    case 'link':
      if (!action.toBoardId || action.toBoardId.trim().length === 0) {
        errors.push(`Page ${pageIndex + 1}, Button "${buttonLabel}": Link action must have target board ID`);
      }
      break;
    
    case 'back':
      // No additional validation needed for back action
      break;
    
    default:
      errors.push(`Page ${pageIndex + 1}, Button "${buttonLabel}": Unknown action type`);
  }

  return errors;
}

function validateNavigation(board: BoardIR): string[] {
  const errors: string[] = [];
  const pageIds = new Set(board.pages.map(p => p.id));

  board.pages.forEach((page, pageIndex) => {
    page.buttons.forEach(button => {
      if (button.action && button.action.type === 'navigate') {
        if (!pageIds.has(button.action.toPageId)) {
          errors.push(`Page ${pageIndex + 1}, Button "${button.label}": References non-existent page "${button.action.toPageId}"`);
        }
      }
    });
  });

  return errors;
}

function isValidColor(color: string): boolean {
  // Basic color validation - checks for hex colors and common CSS color names
  const hexPattern = /^#([0-9A-F]{3}){1,2}$/i;
  const cssColors = ['red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'cyan', 'black', 'white', 'gray', 'grey'];
  
  return hexPattern.test(color) || cssColors.includes(color.toLowerCase());
}
