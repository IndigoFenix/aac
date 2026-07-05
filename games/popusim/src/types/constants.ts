/**
 * Calculator/Expression operators
 */
export const OP = {
	ADD: '+',
	SUBTRACT: '-',
	MULTIPLY: '*',
	DIVIDE: '/',
	PAREN_OPEN: '(',
	PAREN_CLOSE: ')',
	POS_NEG: '±',
	EXPONENT: '^',
	BACK: '<<',
	DELETE: '<',
	CLEAR: 'Clear',
	CLEAR_ALL: 'Clear All',
	EXIT: 'Cancel',
	GET_VAR: 'VAR',
	CONFIRM: '=',
} as const;

export type Operator = typeof OP[keyof typeof OP];

/**
 * Increment/Decrement mode constants
 */
export const INCDEC = {
	CURRENT: '',
	INC: 'inc',
	DEC: 'dec',
} as const;

export type IncDecMode = typeof INCDEC[keyof typeof INCDEC];

/**
 * Expression value types
 */
export const VALUE_TYPE = {
	PAREN: 'paren',
	OP: 'op',
	VAL: 'val',
	EXP: 'exp',
} as const;

export type ValueType = typeof VALUE_TYPE[keyof typeof VALUE_TYPE];

/**
 * Expression value subtypes
 */
export const VALUE_SUBTYPE = {
	TRACKER: 'tracker',
	NUM: 'num',
	RAND: 'rnd',
	ACT: 'act',
	AGE: 'age',
} as const;

export type ValueSubtype = typeof VALUE_SUBTYPE[keyof typeof VALUE_SUBTYPE];

/**
 * Variable array types (for variable scoping)
 */
export const VARARRAY = {
	vars: 'vars',
	privatevars: 'privatevars',
	inventoryvars: 'inventoryvars',
	customvars: 'customvars',
} as const;

export type VarArrayType = typeof VARARRAY[keyof typeof VARARRAY];

/**
 * History/Tracker types
 */
export const HIST_TYPE = {
	TRAIT: 1,
	RESOURCE: 2,
	METRIC: 3,
} as const;

export type HistType = typeof HIST_TYPE[keyof typeof HIST_TYPE];

/**
 * Key code mappings
 */
export const KEY_CODES: Record<number, string> = {
	8: 'backspace',
	46: 'delete',
	13: 'enter',
	27: 'escape',
	32: 'space',
	16: 'shift',
	37: 'left',
	38: 'up',
	39: 'right',
	40: 'down',
	188: ',',
	90: 'b1',    // z
	88: 'b2',    // x
	67: 'b3',    // c
	86: 'b4',    // v
	65: 'walk',  // a
	81: 'menu',  // q
	191: 'slash',
};

/**
 * Key status tracking - initialized from KEY_CODES
 */
export const KEY_STATUS: Record<string, boolean> = {};
for (const code in KEY_CODES) {
	KEY_STATUS[KEY_CODES[code]] = false;
}

/**
 * Mouse button status
 */
export const MOUSE_STATUS: Record<string, boolean> = {};

/**
 * Math constants
 */
export const FULL_CIRCLE = 2 * Math.PI;

/**
 * Root path for assets
 */
export const ROOT = "";

/**
 * Tile size multiplier
 */
export const TILE_MULT = 16;

/**
 * Feature flags
 */
export const BLOCK_HIGHER_LEVELS = false;
export const IS_ADVANCED = false;
