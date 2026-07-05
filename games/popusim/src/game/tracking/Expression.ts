/**
 * Expression - Mathematical expression evaluator for events and metrics
 * ExpressionValue - Individual value in an expression (number, tracker, operator, etc.)
 */

import { OP, VALUE_TYPE, VALUE_SUBTYPE, INCDEC } from '../../types/constants';
import type { Operator, IncDecMode } from '../../types/constants';
import type { TrackerCalc } from './Tracker';

// Forward references
interface WorldLike {
	age: number;
	global_actions_kv: Record<string, ActionLike>;
	system: SystemLike;
}

interface SystemLike {
	rand: { get(): number };
}

interface SiteLike {
	key: string;
	actions_kv: Record<string, ActionLike>;
}

interface ActionLike {
	key: string;
	global: boolean;
	actual_value: number;
}

interface HistoryLike {
	getDayVal(day: number, incdec?: IncDecMode): number;
	current: number;
	current_inc: number;
	current_dec: number;
}

interface TrackerLike {
	getHist(site: SiteLike | null): HistoryLike | null;
}

/**
 * Expression - Parses and evaluates mathematical expressions
 */
export class Expression {
	world: WorldLike;
	values: ExpressionValue[];
	parsed: ExpressionValue[];

	constructor(world: WorldLike, values: ExpressionValue[] = []) {
		this.world = world;
		this.values = [...values];
		this.parsed = this.parse();
	}

	validate(): void {
		let paren_depth = 0;
		for (const value of this.values) {
			if (value.type === VALUE_TYPE.PAREN) {
				if (value.value === OP.PAREN_OPEN) paren_depth++;
				else if (value.value === OP.PAREN_CLOSE) paren_depth--;
			}
		}

		if (paren_depth > 0) {
			for (let i = 0; i < paren_depth; i++) {
				this.values.push(new ExpressionValue(this.world, VALUE_TYPE.PAREN, null, OP.PAREN_CLOSE));
			}
		} else if (paren_depth < 0) {
			for (let i = 0; i > paren_depth; i--) {
				this.values.unshift(new ExpressionValue(this.world, VALUE_TYPE.PAREN, null, OP.PAREN_OPEN));
			}
		}
	}

	parse(): ExpressionValue[] {
		this.validate();
		let parsed: ExpressionValue[] = [];

		for (let i = 0; i < this.values.length; i++) {
			const value = this.values[i];
			if (value.type === VALUE_TYPE.PAREN && value.value === OP.PAREN_OPEN) {
				i++;
				const subvalues: ExpressionValue[] = [];
				while (true) {
					const subvalue = this.values[i];
					if (subvalue === undefined || subvalue.value === OP.PAREN_CLOSE) {
						parsed.push(new ExpressionValue(this.world, VALUE_TYPE.EXP, null, subvalues));
						break;
					} else {
						subvalues.push(subvalue);
					}
					i++;
				}
			} else {
				parsed.push(value);
			}
		}

		// Deal with addition/subtraction (lowest precedence)
		parsed = this.splitter(parsed, [OP.ADD, OP.SUBTRACT]);
		// Deal with multiplication/division
		parsed = this.splitter(parsed, [OP.MULTIPLY, OP.DIVIDE]);
		// Deal with exponents (highest precedence)
		parsed = this.splitter(parsed, [OP.EXPONENT]);

		return parsed;
	}

	splitter(values: ExpressionValue[], by: Operator[]): ExpressionValue[] {
		const newvalues: ExpressionValue[] = [];
		let currentvalues: ExpressionValue[] = [];

		for (const value of values) {
			if (value.type === VALUE_TYPE.OP && by.indexOf(value.value as Operator) !== -1) {
				newvalues.push(new ExpressionValue(this.world, VALUE_TYPE.EXP, null, currentvalues));
				newvalues.push(value);
				currentvalues = [];
			} else {
				currentvalues.push(value);
			}
		}

		if (newvalues.length > 0) {
			newvalues.push(new ExpressionValue(this.world, VALUE_TYPE.EXP, null, currentvalues));
			return newvalues;
		}
		return values;
	}

	evaluate(site: SiteLike | null, day?: number): number {
		return this.evaluateValues(this.parsed, site, day);
	}

	evaluateValues(values: ExpressionValue[], site: SiteLike | null, day?: number): number {
		let current = 0;
		let op: Operator = OP.ADD;

		for (const value of values) {
			let v: number | null = null;

			switch (value.type) {
				case VALUE_TYPE.EXP:
					v = this.evaluateValues(value.value as ExpressionValue[], site, day);
					break;

				case VALUE_TYPE.VAL:
					if (value.subtype === VALUE_SUBTYPE.TRACKER) {
						const trackerCalc = value.value as TrackerCalc;
						const incdec = (trackerCalc.incdec || INCDEC.CURRENT) as IncDecMode;
						const since_start = trackerCalc.neg_offset < 0;
						const offset = -trackerCalc.neg_offset;
						const calc = trackerCalc.calc;

						if (day === undefined && offset === 0 && !calc) {
							// Gets the value based on the moment, including dynamic adjustments
							v = value.getCurrentValue(site, incdec);
						} else if (offset === 0) {
							if (day === undefined) day = this.world.age + 1;
							v = value.getDayValue(site, incdec, day);
						} else if (!calc) {
							if (day === undefined) day = this.world.age + 1;
							v = value.getDayValue(site, incdec, since_start ? 0 : day + offset);
						} else {
							if (day === undefined) day = this.world.age;
							let day1: number, day2: number;
							if (since_start) {
								day1 = 0;
								day2 = day;
							} else if (offset < 0) {
								day1 = day + offset;
								day2 = day;
							} else {
								day1 = day;
								day2 = day + offset;
							}

							let total = value.getCurrentValue(site, incdec);
							const days = day2 - day1 + 1;
							for (let j = 0; j < days; j++) {
								total += value.getDayValue(site, incdec, day1 + j);
							}

							switch (calc) {
								case 'sum':
									v = total;
									break;
								case 'avg':
									v = total / days;
									break;
							}
						}
					} else {
						if (day === undefined) {
							v = value.getCurrentValue(site, INCDEC.CURRENT);
						} else {
							v = value.getDayValue(site, INCDEC.CURRENT, day);
						}
					}
					break;

				case VALUE_TYPE.OP:
					op = value.value as Operator;
					break;
			}

			if (v !== null) {
				switch (op) {
					case OP.ADD:
						current += v;
						break;
					case OP.SUBTRACT:
						current -= v;
						break;
					case OP.MULTIPLY:
						current *= v;
						break;
					case OP.DIVIDE:
						current /= v;
						break;
					case OP.EXPONENT:
						current = Math.pow(current, v);
						break;
				}
			}
		}

		return current;
	}
}

/**
 * ExpressionValue - Individual value/operator in an expression
 */
export class ExpressionValue {
	world: WorldLike;
	type: string;
	subtype: string | null;
	value: unknown;

	constructor(world: WorldLike, type: string, subtype: string | null, value: unknown) {
		this.world = world;
		this.type = type;
		this.subtype = subtype;
		this.value = value;
	}

	getString(): string {
		if (this.subtype === VALUE_SUBTYPE.TRACKER) {
			return (this.value as TrackerCalc).getName();
		}
		return String(this.value);
	}

	/**
	 * Get value for a specific day (used by metrics)
	 */
	getDayValue(site: SiteLike | null, incdec: IncDecMode, day: number): number {
		switch (this.subtype) {
			case VALUE_SUBTYPE.NUM:
				return this.value as number;
			case VALUE_SUBTYPE.TRACKER: {
				const trackerCalc = this.value as TrackerCalc;
				const hist = trackerCalc.tracker.getHist(site);
				return hist ? hist.getDayVal(day, incdec) : 0;
			}
			case VALUE_SUBTYPE.AGE:
				return day;
			default:
				console.error('Invalid expression value subtype for getting a day value', this.subtype);
				return 0;
		}
	}

	/**
	 * Get current value dynamically (used by events)
	 */
	getCurrentValue(site: SiteLike | null, incdec: IncDecMode): number {
		switch (this.subtype) {
			case VALUE_SUBTYPE.NUM:
				return this.value as number;
			case VALUE_SUBTYPE.TRACKER: {
				const trackerCalc = this.value as TrackerCalc;
				const hist = trackerCalc.tracker.getHist(site);
				if (!hist) return 0;
				switch (incdec) {
					case INCDEC.CURRENT:
						return hist.current;
					case INCDEC.INC:
						return hist.current_inc;
					case INCDEC.DEC:
						return hist.current_dec;
				}
				return 0;
			}
			case VALUE_SUBTYPE.AGE:
				return this.world.age;
			case VALUE_SUBTYPE.ACT: {
				const actionRef = this.value as ActionLike;
				if (actionRef.global) {
					const action = this.world.global_actions_kv[actionRef.key];
					return action?.actual_value || 0;
				} else if (site) {
					const action = site.actions_kv[actionRef.key];
					return action?.actual_value || 0;
				}
				return 0;
			}
			case VALUE_SUBTYPE.RAND:
				return this.world.system.rand.get() * parseFloat(String(this.value));
			default:
				console.error('Invalid expression value subtype for getting a current value', this.subtype);
				return 0;
		}
	}
}

export default Expression;
