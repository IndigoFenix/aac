/**
 * Concrete schemas for every editable object type.
 *
 * The single source of truth for "what fields exist on object X" in the
 * editor. Sim classes parse JSON directly in their constructors via
 * `core/parse.ts`; these schemas describe the same JSON shape from the
 * editor's perspective so the editor can render and validate it. A
 * round-trip test guards drift between schema and sim parsing.
 */

import type { ObjectSchema, Section } from './types';
import { fields, group } from './types';

/* ----------------------------- helpers -------------------------------- */

function rowLabelKeyOrName(item: Record<string, unknown>): string {
	const name = typeof item.name === 'string' && item.name.trim() ? item.name : null;
	const key = typeof item.key === 'string' && item.key.trim() ? item.key : null;
	return name ?? key ?? '(unnamed)';
}

function rowLabelTransmitLike(item: Record<string, unknown>): string {
	const apply = arrayString(item.apply);
	const remove = arrayString(item.remove);
	const vector = arrayString(item.vector);
	let out = '';
	if (apply.length) out += '+' + apply.join('+');
	if (remove.length) out += ' -' + remove.join('-');
	if (vector.length) out += ' by ' + vector.join(',');
	return out.trim() || '(empty)';
}

function rowLabelImpact(item: Record<string, unknown>): string {
	const r = typeof item.resource === 'string' ? item.resource : '';
	const v = typeof item.value === 'number' ? item.value : Number(item.value ?? 0);
	const sign = v < 0 ? '' : '+';
	return `${r || '?'} ${sign}${v}`;
}

function rowLabelSeek(item: Record<string, unknown>): string {
	const has = arrayString(item.trait);
	const not = arrayString(item.not_trait);
	const m = item.mult ?? 1;
	let n = '';
	if (has.length) n += ' +' + has.join(' +');
	if (not.length) n += ' -' + not.join(' -');
	n += ' × ' + String(m);
	return n.trim();
}

function rowLabelEventValue(item: Record<string, unknown>): string {
	const op = typeof item.op === 'string' ? item.op : '+';
	const t = typeof item.type === 'string' ? item.type : 'number';
	switch (t) {
		case '(': return '(';
		case ')': return ')';
		case 'number': return `${op} ${item.value ?? 0}`;
		case 'random': return `${op} rand(0..${item.value ?? 0})`;
		case 'resource': return `${op} resource ${item.resource ?? ''}`;
		case 'action': return `${op} action ${item.action ?? ''}`;
		case 'trait': return `${op} pop(${item.trait ?? ''})`;
		case 'age': return `${op} day`;
		default: return op;
	}
}

function arrayString(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	if (typeof v === 'string' && v.length) return v.split(',').map(s => s.trim()).filter(Boolean);
	return [];
}

/* ------------------------ shared field fragments ---------------------- */

/** The five Modifier subtypes share the same field set. */
function modifierLayout(): Section {
	return fields(
		{ kind: 'refList', key: 'vector', list: 'vector', label: 'Modify Vector Type Effectiveness',
			help: 'Applies modifications when the vector has one of the selected vector types.' },
		{ kind: 'numberOrRef', key: 'mult', list: 'resource', default: 0, min: 0, label: 'Multiplier',
			help: 'Multiplies the effectiveness of the selected vectors.' },
		{ kind: 'refList', key: 'apply', list: 'trait', label: 'Apply Traits',
			help: 'Causes selected vectors to apply additional traits.' },
		{ kind: 'refList', key: 'remove', list: 'trait', label: 'Remove Traits',
			help: 'Causes selected vectors to remove additional traits.' },
	);
}

/* ----------------------------- schemas -------------------------------- */

export const seekSchema: ObjectSchema = {
	tag: 'seek',
	label: 'Seek',
	blank: () => ({ trait: [], not_trait: [], mult: 1 }),
	rowLabel: rowLabelSeek,
	layout: fields(
		{ kind: 'refList', key: 'trait', list: 'trait', label: 'Has Traits',
			help: 'Applies the multiplier if the target has one of the following traits.' },
		{ kind: 'refList', key: 'not_trait', list: 'trait', label: 'Lacks Traits',
			help: 'Applies the multiplier if the target lacks one of the following traits.' },
		{ kind: 'number', key: 'mult', default: 1, min: 0, label: 'Multiplier',
			help: 'Weight applied to populations with the selected traits.' },
	),
};

export const vectorSchema: ObjectSchema = {
	tag: 'vector',
	label: 'Vector Type',
	blank: () => ({ key: 'vector' }),
	rowLabel: rowLabelKeyOrName,
	layout: group('Vector', [
		fields(
			{ kind: 'string', key: 'key', default: 'vector', label: 'ID',
				help: 'The ID of the vector. Changing this after creation may break references to this object.' },
			{ kind: 'string', key: 'name', default: '', label: 'Name',
				help: 'Optional human-readable label for this vector type.' },
		),
		group('Seek', [
			fields({ kind: 'children', key: 'seek', label: 'Seek', itemTag: 'seek',
				help: 'Allows vectors of this type to seek out or avoid people with particular traits instead of moving randomly.' }),
		]),
	], true),
};

export const transmitSchema: ObjectSchema = {
	tag: 'transmit',
	label: 'Transmit',
	blank: () => ({ apply: [], remove: [], vector: [], value: 0, sd: 0, phase: '' }),
	rowLabel: rowLabelTransmitLike,
	layout: fields(
		{ kind: 'refList', key: 'apply', list: 'trait', label: 'Apply Traits',
			help: 'The transmitted vectors will apply these traits when they successfully contact a target.' },
		{ kind: 'refList', key: 'remove', list: 'trait', label: 'Remove Traits',
			help: 'The transmitted vectors will remove these traits when they successfully contact a target.' },
		{ kind: 'refList', key: 'vector', list: 'vector', label: 'Vector Types',
			help: 'The type or types of vector used to transmit the traits.' },
		{ kind: 'numberOrRef', key: 'value', list: 'resource', default: 0, min: 0, label: 'Amount',
			help: 'The average quantity of vectors released per person each day.' },
		{ kind: 'numberOrRef', key: 'sd', list: 'resource', default: 0, min: 0, label: 'Standard Deviation',
			help: 'Applies a standard deviation to the number of vectors each person releases per day.' },
		{ kind: 'bool', key: 'popmult', default: false, label: 'Broadcast',
			help: "Multiplies the 'Amount' by the site population." },
		{ kind: 'bool', key: 'precise', default: false, label: 'Precise',
			help: 'Multiple vectors will not be wasted randomly infecting the same individual.' },
		{ kind: 'number', key: 'ranged', default: 0, min: 0, max: 1, step: 0.05, label: 'Ranged',
			help: 'Fraction of released vectors exported along the site\'s routes to connected sites (0 = fully local). Exports arrive the next day.' },
		{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase',
			help: 'The phase this transmission occurs.' },
	),
};

export const progressSchema: ObjectSchema = {
	tag: 'progress',
	label: 'Progress',
	blank: () => ({ apply: [], remove: [], vector: [], value: 0, sd: 0, phase: '' }),
	rowLabel: rowLabelTransmitLike,
	layout: fields(
		{ kind: 'refList', key: 'apply', list: 'trait', label: 'Apply Traits',
			help: 'Traits this progression applies to the affected person.' },
		{ kind: 'refList', key: 'remove', list: 'trait', label: 'Remove Traits',
			help: 'Traits this progression removes from the affected person.' },
		{ kind: 'refList', key: 'vector', list: 'vector', label: 'Vector Type',
			help: 'The type of vector used to mediate the progression.' },
		{ kind: 'refList', key: 'require', list: 'trait', label: 'Requires Traits',
			help: 'Progression can take place only if the affected person has all of the following traits.' },
		{ kind: 'refList', key: 'forbid', list: 'trait', label: 'Forbidden Traits',
			help: 'Progression cannot take place if the affected person has any of the following traits.' },
		{ kind: 'numberOrRef', key: 'value', list: 'resource', default: 0, min: 0, label: 'Probability',
			help: 'The average probability that a person will advance to the next stage each day.' },
		{ kind: 'numberOrRef', key: 'sd', list: 'resource', default: 0, min: 0, label: 'Standard Deviation',
			help: 'Applies standard deviation to the progression speed.' },
		{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase',
			help: 'The phase this progression occurs.' },
	),
};

export const produceSchema: ObjectSchema = {
	tag: 'produce',
	label: 'Produce',
	blank: () => ({ resource: '', value: 0, sd: 0, vector: [], phase: '' }),
	rowLabel: rowLabelImpact,
	layout: fields(
		{ kind: 'ref', key: 'resource', list: 'resource', default: '', label: 'Resource',
			help: 'The resource that people with this trait produce.' },
		{ kind: 'numberOrRef', key: 'value', list: 'resource', default: 0, label: 'Value',
			help: 'The amount each person will produce per day.' },
		{ kind: 'numberOrRef', key: 'sd', list: 'resource', default: 0, min: 0, label: 'Standard Deviation' },
		{ kind: 'refList', key: 'vector', list: 'vector', label: 'Vector Types',
			help: 'Modifiers for these vector types apply to this production.' },
		{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase' },
	),
};

export const consumeSchema: ObjectSchema = {
	tag: 'consume',
	label: 'Consume',
	blank: () => ({ resource: '', value: 0, sd: 0, apply: [], remove: [], vector: [], phase: '' }),
	rowLabel: rowLabelImpact,
	layout: fields(
		{ kind: 'ref', key: 'resource', list: 'resource', default: '', label: 'Resource',
			help: 'The resource that people with this trait consume.' },
		{ kind: 'numberOrRef', key: 'value', list: 'resource', default: 0, label: 'Value',
			help: 'The amount each person will consume per day.' },
		{ kind: 'numberOrRef', key: 'sd', list: 'resource', default: 0, min: 0, label: 'Standard Deviation' },
		{ kind: 'refList', key: 'apply', list: 'trait', label: 'Apply Traits',
			help: 'Applies these traits when consuming resources.' },
		{ kind: 'refList', key: 'remove', list: 'trait', label: 'Remove Traits',
			help: 'Removes these traits when consuming resources.' },
		{ kind: 'refList', key: 'vector', list: 'vector', label: 'Vector Types' },
		{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase' },
	),
};

export const transmitModSchema: ObjectSchema = {
	tag: 'transmit_mod',
	label: 'Transmit Mod',
	blank: () => ({ vector: [], mult: 0, apply: [], remove: [] }),
	rowLabel: (i) => `× ${i.mult ?? '?'} on ${arrayString(i.vector).join(',') || '(any)'}`,
	layout: modifierLayout(),
};
export const progressModSchema: ObjectSchema = { ...transmitModSchema, tag: 'progress_mod', label: 'Progress Mod' };
export const contactModSchema: ObjectSchema  = { ...transmitModSchema, tag: 'contact_mod',  label: 'Contact Mod' };
export const produceModSchema: ObjectSchema  = { ...transmitModSchema, tag: 'produce_mod',  label: 'Produce Mod' };
export const consumeModSchema: ObjectSchema  = { ...transmitModSchema, tag: 'consume_mod',  label: 'Consume Mod' };

export const traitSchema: ObjectSchema = {
	tag: 'trait',
	label: 'Trait',
	blank: () => ({ key: 'trait' }),
	rowLabel: rowLabelKeyOrName,
	layout: group('Trait', [
		fields(
			{ kind: 'string', key: 'key', default: 'trait', label: 'ID',
				help: 'The ID of the trait. Changing this after creation may break references to this object.' },
			{ kind: 'string', key: 'name', default: '', label: 'Name',
				help: 'The name of the trait that will be displayed on-screen.' },
			{ kind: 'image', key: 'icon', label: 'Icon', advanced: true },
			{ kind: 'color', key: 'color', default: '0,0,0,1', label: 'Color',
				help: 'Determines color of line on graph.' },
			{ kind: 'bool', key: 'inactive', default: false, label: 'Inactive by default',
				help: 'Hides from graph initially. Users can click on the indicator to display it.' },
			{ kind: 'bool', key: 'hidden', default: false, label: 'Hidden',
				help: 'If checked, the trait will be completely hidden from the user.' },
			{ kind: 'number', key: 'prob', default: 0, min: 0, max: 1, step: 0.01, label: 'Starting Probability',
				help: 'Automatically sets a portion of the population (between 0 and 1) to have this trait at the start.' },
			{ kind: 'ref', key: 'guigroup', list: 'guigroup', default: '', label: 'GUI Group',
				help: 'The category this should be placed under in the GUI.' },
		),
		group('Transmit', [fields({ kind: 'children', key: 'transmit', label: 'Transmit', itemTag: 'transmit',
			help: 'Vectors people with this trait will shed into the environment.' })]),
		group('Progress', [fields({ kind: 'children', key: 'progress', label: 'Progress', itemTag: 'progress',
			help: 'New effects that develop over time in people with this trait.' })]),
		group('Produce', [fields({ kind: 'children', key: 'produce', label: 'Produce', itemTag: 'produce',
			help: 'Resources that are produced by people with this trait.' })]),
		group('Consume', [fields({ kind: 'children', key: 'consume', label: 'Consume', itemTag: 'consume',
			help: 'Resources that are consumed by people with this trait.' })]),
		group('Transmit Mod', [fields({ kind: 'children', key: 'transmit_mod', label: 'Transmit Mod', itemTag: 'transmit_mod',
			help: "Modifies the vectors released due to other traits in anyone with this trait." })], false),
		group('Progress Mod', [fields({ kind: 'children', key: 'progress_mod', label: 'Progress Mod', itemTag: 'progress_mod',
			help: 'Modifies the rate of new emergent traits in anyone with this trait.' })], false),
		group('Contact Mod', [fields({ kind: 'children', key: 'contact_mod', label: 'Contact Mod', itemTag: 'contact_mod',
			help: 'Alters susceptibility to contact by vectors in the environment.' })], false),
		group('Production Mod', [fields({ kind: 'children', key: 'produce_mod', label: 'Production Mod', itemTag: 'produce_mod',
			help: 'Modifies resource production in anyone with this trait.' })], false),
		group('Consumption Mod', [fields({ kind: 'children', key: 'consume_mod', label: 'Consumption Mod', itemTag: 'consume_mod',
			help: 'Modifies resource consumption in anyone with this trait.' })], false),
		group('Definitions', [
			fields(
				{ kind: 'refList', key: 'def_and', list: 'trait', label: 'Has all of',
					help: 'This trait is automatically added to any host that has all of the following traits.' },
				{ kind: 'refList', key: 'def_not', list: 'trait', label: 'Has none of',
					help: 'This trait is automatically added to any host that is missing the following traits.' },
				{ kind: 'refList', key: 'def_or',  list: 'trait', label: 'Has at least one of',
					help: 'This trait is automatically added to any host that has one or more of the following traits.' },
				{ kind: 'refList', key: 'require', list: 'trait', label: 'Must have',
					help: 'This trait is automatically removed if it is missing one of these traits.' },
				{ kind: 'refList', key: 'forbid',  list: 'trait', label: 'May not have',
					help: 'This trait is automatically removed if it has one of these traits.' },
			),
		], false),
	]),
};

export const guigroupSchema: ObjectSchema = {
	tag: 'guigroup',
	label: 'GUI Group',
	blank: () => ({ key: 'group', name: '' }),
	rowLabel: rowLabelKeyOrName,
	layout: fields(
		{ kind: 'string', key: 'key',  default: 'group', label: 'ID' },
		{ kind: 'string', key: 'name', default: '',      label: 'Label' },
	),
};

export const phaseSchema: ObjectSchema = {
	tag: 'phase',
	label: 'Phase',
	blank: () => ({ key: 'phase' }),
	rowLabel: rowLabelKeyOrName,
	layout: fields(
		{ kind: 'string', key: 'key', default: 'phase', label: 'ID' },
	),
};

export const resourceSchema: ObjectSchema = {
	tag: 'resource',
	label: 'Resource',
	blank: () => ({ key: 'resource' }),
	rowLabel: rowLabelKeyOrName,
	layout: fields(
		{ kind: 'string', key: 'key',  default: 'resource', label: 'ID' },
		{ kind: 'string', key: 'name', default: '',         label: 'Name' },
		{ kind: 'image',  key: 'icon', label: 'Icon', advanced: true },
		{ kind: 'color',  key: 'color', default: '0,0,0,1', label: 'Color' },
		{ kind: 'number', key: 'value', default: 0, label: 'Initial Value' },
		{ kind: 'bool',   key: 'inactive', default: false, label: 'Inactive by default' },
		{ kind: 'bool',   key: 'hidden',   default: false, label: 'Hidden' },
		{ kind: 'bool',   key: 'signed',   default: false, label: 'Allow negative' },
		{ kind: 'select', key: 'display', default: '', label: 'Display type', options: [
			{ value: '',     label: 'Numeric' },
			{ value: 'perc', label: 'Percentage' },
			{ value: 'none', label: 'Hidden' },
		] },
		{ kind: 'select', key: 'graph_display', default: '', label: 'Graph type', options: [
			{ value: '',     label: 'Numeric' },
			{ value: 'perc', label: 'Percentage' },
			{ value: 'none', label: 'Hidden' },
		] },
		{ kind: 'number', key: 'precision', default: 0, min: 0, int: true, label: 'Decimal Places' },
		{ kind: 'ref', key: 'denominator', list: 'resource', default: '', label: 'Denominator',
			help: "Use another resource's value as the denominator for displaying as a fraction or a percentage." },
		{ kind: 'bool', key: 'global', default: false, label: 'Global Resource',
			help: 'If checked, the resource applies to the entire country. Otherwise, each site has its own stockpile.' },
		{ kind: 'ref', key: 'guigroup', list: 'guigroup', default: '', label: 'GUI Group' },
	),
};

export const actionCostSchema: ObjectSchema = {
	tag: 'cost',
	label: 'Cost',
	blank: () => ({ resource: '', value: 0, phase: '' }),
	rowLabel: rowLabelImpact,
	layout: fields(
		{ kind: 'ref', key: 'resource', list: 'resource', default: '', label: 'Resource',
			help: 'The resource that the action consumes.' },
		{ kind: 'number', key: 'value', default: 0, min: 0, label: 'Cost per unit',
			help: 'Amount of the resource consumed per action unit. Always positive — production goes in the Produce list instead.' },
		{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase',
			help: 'Phase on which the cost is paid. Defaults to the first phase if blank.' },
	),
};

export const actionProduceSchema: ObjectSchema = {
	tag: 'action_produce',
	label: 'Produce',
	blank: () => ({ resource: '', value: 0, sd: 0, phase: '' }),
	rowLabel: rowLabelImpact,
	layout: fields(
		{ kind: 'ref', key: 'resource', list: 'resource', default: '', label: 'Resource',
			help: 'The resource the action produces (or drains, when negative).' },
		{ kind: 'number', key: 'value', default: 0, label: 'Amount per unit',
			help: 'Amount produced per action unit. Negative values drain the resource. Multiplied by current_value at the produce phase.' },
		{ kind: 'number', key: 'sd', default: 0, min: 0, label: 'Standard deviation',
			help: 'Optional gaussian noise added to the produced amount each phase.' },
		{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase',
			help: 'Phase on which production fires. Defaults to the first phase if blank.' },
	),
};

export const actionSchema: ObjectSchema = {
	tag: 'action',
	label: 'User Action',
	blank: () => ({ key: 'action' }),
	rowLabel: rowLabelKeyOrName,
	layout: group('User Action', [
		fields(
			{ kind: 'string', key: 'key', default: 'action', label: 'ID' },
			{ kind: 'string', key: 'name', default: '', label: 'Name' },
			{ kind: 'image', key: 'icon', label: 'Icon', advanced: true },
			{ kind: 'text', key: 'info', default: '', label: 'Info' },
			{ kind: 'bool', key: 'global', default: false, label: 'Global Action' },
			{ kind: 'number', key: 'value', default: 0, min: 0, label: 'Starting Value' },
			{ kind: 'number', key: 'max', default: 1, min: 0, label: 'Max' },
			{ kind: 'select', key: 'control', default: '', label: 'Control type', options: [
				{ value: '',         label: 'None' },
				{ value: 'checkbox', label: 'Checkbox' },
				{ value: 'range',    label: 'Slider' },
				{ value: 'number',   label: 'Number' },
			] },
			{ kind: 'bool', key: 'hidden', default: false, label: 'Hidden' },
			{ kind: 'ref', key: 'guigroup', list: 'guigroup', default: '', label: 'GUI Group' },
		),
		group('Transmit', [fields({ kind: 'children', key: 'transmit', label: 'Transmit', itemTag: 'transmit',
			help: 'Vectors that will be released when the action is performed.' })]),
		group('Cost', [fields({ kind: 'children', key: 'cost', label: 'Cost', itemTag: 'cost',
			help: 'Resources consumed each time the action runs. Costs gate affordability — the action is reduced if the player can\'t pay.' })]),
		group('Produce', [fields({ kind: 'children', key: 'produce', label: 'Produce', itemTag: 'action_produce',
			help: 'Resources produced (or drained, when negative) each time the action runs. Optional standard deviation adds noise.' })]),
	]),
};

export const popInitSchema: ObjectSchema = {
	tag: 'startpop',
	label: 'Initial Population',
	blank: () => ({ size: 0, apply: [] }),
	rowLabel: (i) => {
		const traits = arrayString(i.apply);
		const size = i.size ?? 0;
		return `${traits.length ? traits.join(',') : 'None'} × ${size}`;
	},
	layout: fields(
		{ kind: 'number', key: 'size', default: 0, min: 0, int: true, label: 'Proportional Size',
			help: 'The proportional size of the population.' },
		{ kind: 'refList', key: 'apply', list: 'trait', label: 'Population Traits',
			help: 'The traits defining this population.' },
	),
};

export const siteSchema: ObjectSchema = {
	tag: 'site',
	label: 'Site',
	blank: () => ({ key: 'site' }),
	rowLabel: rowLabelKeyOrName,
	layout: group('Site', [
		fields(
			{ kind: 'string', key: 'key', default: 'site', label: 'ID' },
			{ kind: 'string', key: 'name', default: '', label: 'Name' },
			{ kind: 'text', key: 'info', default: '', label: 'Info' },
			{ kind: 'number', key: 'pop', default: 0, min: 0, int: true, label: 'Site Population' },
		),
		group('Initial Local Traits', [
			fields({ kind: 'children', key: 'startpop', label: 'Initial Populations', itemTag: 'startpop',
				help: 'Populations defined by a specific set of traits and relative size.' }),
			fields({ kind: 'children', key: 'transmit', label: 'Additional Vectors', itemTag: 'transmit',
				help: 'Vectors that will be released at the beginning of the simulation.' }),
		]),
	]),
};

export const routeSchema: ObjectSchema = {
	tag: 'route',
	label: 'Route',
	blank: () => ({ key: 'route', sites: [], strength: 1, migration: 0 }),
	rowLabel: (i) => {
		const s = Array.isArray(i.sites) ? i.sites : [];
		const link = s.length ? s.join(' ↔ ') : '(unconnected)';
		return `${typeof i.key === 'string' ? i.key : 'route'}: ${link}`;
	},
	layout: fields(
		{ kind: 'string', key: 'key', default: 'route', label: 'ID' },
		{ kind: 'string', key: 'name', default: '', label: 'Name' },
		{ kind: 'refList', key: 'sites', list: 'site', label: 'Connected Sites',
			help: 'Exactly two sites this route connects. Ranged vectors and migration travel both ways.' },
		{ kind: 'number', key: 'strength', default: 1, min: 0, label: 'Strength',
			help: "This route's share of a site's exported vectors, weighed against the site's own weight of 1 and its other routes." },
		{ kind: 'number', key: 'migration', default: 0, min: 0, max: 0.5, step: 0.01, label: 'Migration Rate',
			help: 'Fraction of each connected site\'s population that migrates to the other side per day, uniformly across traits.' },
		{ kind: 'refList', key: 'migration_forbid', list: 'trait', label: 'Migration Forbidden Traits',
			help: 'People with any of these traits do not migrate (e.g. dead, imprisoned).' },
	),
};

export const eventValueSchema: ObjectSchema = {
	tag: 'exp',
	label: 'Expression Token',
	blank: () => ({ op: '+', type: 'number', value: 0 }),
	rowLabel: rowLabelEventValue,
	layout: fields(
		{ kind: 'select', key: 'op', default: '+', label: 'Operation', options: [
			{ value: '+', label: '+' }, { value: '-', label: '-' },
			{ value: '*', label: '×' }, { value: '/', label: '÷' }, { value: '^', label: '^' },
		] },
		{ kind: 'select', key: 'type', default: 'number', label: 'Type', options: [
			{ value: '(', label: '(' }, { value: ')', label: ')' },
			{ value: 'number',   label: 'Numeric' },
			{ value: 'random',   label: 'Random' },
			{ value: 'action',   label: 'Action Value' },
			{ value: 'resource', label: 'Resource Value' },
			{ value: 'trait',    label: 'Population with Trait' },
			{ value: 'age',      label: 'Current Day' },
		] },
		{ kind: 'ref', key: 'action',   list: 'action',   default: '', label: 'Value of Action' },
		{ kind: 'ref', key: 'resource', list: 'resource', default: '', label: 'Value of Resource' },
		{ kind: 'ref', key: 'trait',    list: 'trait',    default: '', label: 'Population with Trait' },
		{ kind: 'number', key: 'value', default: 0, label: 'Value' },
		{ kind: 'number', key: 'neg_offset', default: 0, min: -1, int: true, label: 'Days ago' },
		{ kind: 'select', key: 'incdec', default: '', label: 'Change', options: [
			{ value: '',    label: 'Current' },
			{ value: 'inc', label: 'Increment' },
			{ value: 'dec', label: 'Decrement' },
		] },
		{ kind: 'select', key: 'calc', default: '', label: 'Calculation', options: [
			{ value: '',    label: 'Value' },
			{ value: 'sum', label: 'Sum of timespan' },
			{ value: 'avg', label: 'Average over timespan' },
		] },
	),
};

export const eventConditionSchema: ObjectSchema = {
	tag: 'condition',
	label: 'Condition',
	blank: () => ({ op: '==', exp: [], exp2: [] }),
	rowLabel: (i) => {
		const op = typeof i.op === 'string' ? i.op : '==';
		const e1 = Array.isArray(i.exp) ? i.exp.length : 0;
		const e2 = Array.isArray(i.exp2) ? i.exp2.length : 0;
		return `(${e1} tokens) ${op} (${e2} tokens)`;
	},
	layout: fields(
		{ kind: 'bool', key: 'or', default: false, label: 'Optional',
			help: 'The event will fire as long as at least one optional condition is met.' },
		{ kind: 'children', key: 'exp', label: 'Value 1', itemTag: 'exp' },
		{ kind: 'select', key: 'op', default: '==', label: 'Operation', options: [
			{ value: '==', label: 'equals' },
			{ value: '<',  label: 'less than' },
			{ value: '<=', label: 'less than or equal to' },
			{ value: '>',  label: 'greater than' },
			{ value: '>=', label: 'greater than or equal to' },
			{ value: '!=', label: 'not equal to' },
		] },
		{ kind: 'children', key: 'exp2', label: 'Value 2', itemTag: 'exp' },
	),
};

export const eventResultSchema: ObjectSchema = {
	tag: 'result',
	label: 'Result',
	blank: () => ({ type: 'display', exp: [] }),
	rowLabel: (i) => {
		const t = typeof i.type === 'string' ? i.type : '';
		switch (t) {
			case 'display': return 'News: ' + (typeof i.title === 'string' ? i.title : '');
			case 'action': return `Set action ${i.action ?? '?'}`;
			case 'action_vis': return `${i.hide ? 'Disable' : 'Enable'} action ${i.action ?? '?'}`;
			case 'resource': return `Set resource ${i.resource ?? '?'}`;
			case 'resource_vis': return `${i.hide ? 'Hide' : 'Show'} resource ${i.resource ?? '?'}`;
			case 'height': return 'Set graph height';
			case 'transmit': return 'Release vectors';
			case 'failure': return 'Scenario failure';
			case 'victory': return 'Scenario victory';
			default: return t || '(empty)';
		}
	},
	layout: fields(
		{ kind: 'select', key: 'type', default: 'display', label: 'Operation', options: [
			{ value: 'display',     label: 'News Item' },
			{ value: 'action',      label: 'Set Action Value' },
			{ value: 'action_vis',  label: 'Enable/Disable Action' },
			{ value: 'resource',    label: 'Set Resource' },
			{ value: 'resource_vis',label: 'Show/Hide Resource' },
			{ value: 'height',      label: 'Set Graph Height' },
			{ value: 'transmit',    label: 'Release Vectors' },
			{ value: 'failure',     label: 'Scenario Failure' },
			{ value: 'victory',     label: 'Scenario Victory' },
		] },
		{ kind: 'string', key: 'title', default: '', label: 'Headline' },
		{ kind: 'text',   key: 'text',  default: '', label: 'Text' },
		{ kind: 'bool',   key: 'auto',  default: false, label: 'Open Automatically' },
		{ kind: 'bool',   key: 'update_ui', default: false, label: 'Update Display' },
		{ kind: 'ref', key: 'action',   list: 'action',   default: '', label: 'Action' },
		{ kind: 'ref', key: 'resource', list: 'resource', default: '', label: 'Resource' },
		{ kind: 'select', key: 'hide', default: '0', label: 'Setting', options: [
			{ value: '0', label: 'Show' },
			{ value: '1', label: 'Hide' },
		] },
		{ kind: 'refList', key: 'apply',  list: 'trait',  label: 'Apply' },
		{ kind: 'refList', key: 'remove', list: 'trait',  label: 'Remove' },
		{ kind: 'refList', key: 'vector', list: 'vector', label: 'Vector Types' },
		{ kind: 'bool', key: 'popmult', default: false, label: 'Broadcast' },
		{ kind: 'bool', key: 'precise', default: false, label: 'Precise' },
		{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase' },
		{ kind: 'children', key: 'exp', label: 'Value', itemTag: 'exp' },
	),
};

export const eventSchema: ObjectSchema = {
	tag: 'event',
	label: 'Event',
	blank: () => ({ key: 'event', times: 1 }),
	rowLabel: rowLabelKeyOrName,
	layout: group('Event', [
		fields(
			{ kind: 'string', key: 'key', default: 'event', label: 'ID' },
			{ kind: 'bool', key: 'global', default: false, label: 'Global' },
			{ kind: 'number', key: 'times', default: 1, min: -1, int: true, label: 'Times event can fire',
				help: 'The maximum number of times the event can fire. -1 = unlimited.' },
		),
		group('Conditions', [fields({ kind: 'children', key: 'condition', label: 'Conditions', itemTag: 'condition',
			help: 'Conditions that must be met for the event to trigger.' })]),
		group('Results', [fields({ kind: 'children', key: 'result', label: 'Results', itemTag: 'result',
			help: 'Results that occur when the event triggers.' })]),
		fields(
			{ kind: 'ref', key: 'phase', list: 'phase', default: '', label: 'Phase' },
		),
	]),
};

export const worldSchema: ObjectSchema = {
	tag: 'world',
	label: 'Scenario',
	blank: () => ({
		name: 'New Scenario',
		trait: [], vector: [], action: [], resource: [],
		guigroup: [], phase: [], site: [], route: [], event: [],
	}),
	rowLabel: (i) => (typeof i.name === 'string' && i.name) ? i.name : 'Scenario',
	layout: group('Scenario', [
		fields({ kind: 'string', key: 'name', default: 'My Scenario', label: 'Name' }),
		group('Date', [fields(
			{ kind: 'number', key: 'start_age', default: 0, min: 0, int: true, label: 'Startup Time',
				help: 'Steps to run before starting.' },
			{ kind: 'bool', key: 'use_date', default: true, label: 'Use date' },
			{ kind: 'date', key: 'start_date', default: '', label: 'Start date' },
		)], false),
		group('Text Replacement', [fields(
			{ kind: 'string', key: 'day_string',  default: 'Day',  label: 'Day' },
			{ kind: 'string', key: 'news_string', default: 'NEWS', label: 'News' },
		)], false),
		group('Color Scheme', [fields(
			{ kind: 'color', key: 'color_primary',   default: '0,128,255,1',  label: 'Primary Color' },
			{ kind: 'color', key: 'color_secondary', default: '255,0,0,1',    label: 'Secondary Color' },
			{ kind: 'color', key: 'color_light',     default: '255,255,255,1',label: 'Light Color' },
			{ kind: 'color', key: 'color_dark',      default: '0,0,0,1',      label: 'Dark Color' },
		)], false),
		group('Traits',      [fields({ kind: 'children', key: 'trait',    label: 'Traits',       itemTag: 'trait' })]),
		group('Vector Types',[fields({ kind: 'children', key: 'vector',   label: 'Vector Types', itemTag: 'vector' })]),
		group('User Actions',[fields({ kind: 'children', key: 'action',   label: 'User Actions', itemTag: 'action' })]),
		group('Resources',   [fields({ kind: 'children', key: 'resource', label: 'Resources',    itemTag: 'resource' })]),
		group('GUI Groups',  [fields({ kind: 'children', key: 'guigroup', label: 'GUI Groups',   itemTag: 'guigroup' })]),
		group('Phases',      [fields({ kind: 'children', key: 'phase',    label: 'Phases',       itemTag: 'phase' })]),
		group('Sites',       [fields({ kind: 'children', key: 'site',     label: 'Sites',        itemTag: 'site' })]),
		group('Routes',      [fields({ kind: 'children', key: 'route',    label: 'Routes',       itemTag: 'route',
			help: 'Connections between sites. Ranged vectors and migration travel along routes.' })]),
		group('Events',      [fields({ kind: 'children', key: 'event',    label: 'Events',       itemTag: 'event' })]),
	]),
};
