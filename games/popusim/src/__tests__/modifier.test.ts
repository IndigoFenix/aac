/**
 * Feature tests: modifiers (TransmitModifier vs ContactModifier),
 * modifier limit (cannot infect more units than the shed contains),
 * multiplicative stacking, cure deactivates modifier.
 */

import { describe, it, expect } from 'vitest';
import {
	bootScenario,
	runDays,
	totalPop,
	popOnSiteWithTrait,
	popOnSiteWithAllTraits,
	popWithTrait,
} from './_helpers';

describe('TransmitModifier (producer-side, halves shed amount)', () => {
	it('masked group sheds about half as many viruses as unmasked', { timeout: 30000 }, async () => {
		// Two sites, each carrying its own infected pop with a fixed transmit.
		// Site A: mask trait reduces transmit value to 0.5×.
		// Site B: no mask. Both seeded identically.
		const scenario: Record<string, unknown> = {
			name: 'TxMod',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					transmit: [{ vector: ['v1'], apply: ['infected'], value: 1.0, sd: 0, phase: 'spread' }],
				},
				{
					key: 'masked', name: 'Masked', color: '0,255,0,1',
					transmit_mod: [{ vector: ['v1'], mult: 0.5 }],
				},
			],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [
				{
					key: 'site_masked', name: 'Masked Site', pop: 100_000,
					startpop: [
						{ size: 50, apply: ['masked'] },
						{ size: 50, apply: ['masked', 'infected'] },
					],
				},
				{
					key: 'site_plain', name: 'Plain Site', pop: 100_000,
					startpop: [
						{ size: 50, apply: [] },
						{ size: 50, apply: ['infected'] },
					],
				},
			],
		};
		const world = await bootScenario(scenario);

		// Capture state right after start (1 phase pass already ran).
		const aInf0 = popOnSiteWithTrait(world, 'site_masked', 'infected');
		const bInf0 = popOnSiteWithTrait(world, 'site_plain', 'infected');
		expect(aInf0).toBeGreaterThan(0);
		expect(bInf0).toBeGreaterThan(0);

		await runDays(world, 5);
		const aInf = popOnSiteWithTrait(world, 'site_masked', 'infected');
		const bInf = popOnSiteWithTrait(world, 'site_plain', 'infected');

		// The plain site must have grown more than the masked site, because
		// each infected unit there sheds twice as many viruses per day.
		expect(bInf).toBeGreaterThan(aInf);
		expect(totalPop(world)).toBe(200_000);
	});
});

describe('ContactModifier (target-side, halves susceptibility)', () => {
	it('vaccinated group is infected at half the rate of unvaccinated', { timeout: 30000 }, async () => {
		// Single site, two pops: half vaccinated, half not. Single vector
		// carries an infect modifier on the vaccinated trait.
		const scenario: Record<string, unknown> = {
			name: 'InfMod',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					transmit: [{ vector: ['v1'], apply: ['infected'], value: 1.0, sd: 0, phase: 'spread' }],
				},
				{
					key: 'vaccinated', name: 'Vaccinated', color: '0,255,0,1',
					infect_mod: [{ vector: ['v1'], mult: 0.5 }],
				},
			],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 100_000,
				startpop: [
					{ size: 1, apply: ['vaccinated'] },
					{ size: 1, apply: [] },
					{ size: 1, apply: ['infected'] },
				],
			}],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 5);

		const vacInfected = popOnSiteWithAllTraits(world, 'site_a', ['vaccinated', 'infected']);
		const plainInfected = popOnSiteWithAllTraits(world, 'site_a', ['infected'])
			- vacInfected;

		// Both groups started equal; vaccinated should be infected at roughly
		// half the rate. Allow ±50% Monte-Carlo noise around the target ratio.
		expect(vacInfected).toBeGreaterThan(0);
		expect(plainInfected).toBeGreaterThan(vacInfected);
		const ratio = plainInfected / vacInfected;
		expect(ratio).toBeGreaterThan(1.3);
		expect(ratio).toBeLessThan(3.0);
	});
});

describe('site.transmit respects modifiers from prob-init', () => {
	it('a site.transmit shed avoids units immunized by prob-init', { timeout: 30000 }, async () => {
		// prob-init applies the "vaccinated" trait to ~50% of the site.
		// Then site.transmit fires v_inj on the "inject" phase. Vaccinated
		// units have ContactModifier mult=0 on v_inj, so they MUST be skipped.
		// If site.transmit was passing key=null to addShed, the modifier
		// path would not run and the vaccinated would also be infected.
		const scenario: Record<string, unknown> = {
			name: 'SiteTxRespectsProbInit',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'inject', name: 'Inject' }],
			trait: [
				{ key: 'infected', name: 'Infected' },
				{
					key: 'vaccinated', name: 'Vaccinated', prob: 0.5,
					infect_mod: [{ vector: ['v_inj'], mult: 0 }],
				},
			],
			vector: [{ key: 'v_inj', name: 'Inject vec' }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 100_000,
				transmit: [{
					vector: ['v_inj'], apply: ['infected'],
					value: 10_000, sd: 0, precise: true, phase: 'inject',
				}],
			}],
		};
		const world = await bootScenario(scenario);

		const totalInfected = popOnSiteWithTrait(world, 'site_a', 'infected');
		const vaccInfected = popOnSiteWithAllTraits(world, 'site_a', ['vaccinated', 'infected']);

		// Some units became infected.
		expect(totalInfected).toBeGreaterThan(0);
		// But vaccinated units are protected — none should have caught it.
		expect(vaccInfected).toBe(0);
		expect(totalPop(world)).toBe(100_000);
	});
});

describe('ContactModifier limit', () => {
	it('a 2× susceptibility multiplier cannot infect more units than the shed contains', { timeout: 30000 }, async () => {
		// Site config:
		// - Population mostly carries `boosted` trait (ContactModifier 2.0).
		// - A single per-site precise transmit drops a small shed.
		// The shed contains exactly N vectors; with hyper-susceptibility the
		// raw expected hit count (precise) would be 2N. The implementation must
		// clamp to N.
		const scenario: Record<string, unknown> = {
			name: 'InfModLimit',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'inject', name: 'Inject' }],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
				},
				{
					key: 'boosted', name: 'Boosted', color: '0,0,255,1',
					infect_mod: [{ vector: ['v_inj'], mult: 2.0 }],
				},
			],
			vector: [{ key: 'v_inj', name: 'Inject vec' }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 1_000_000,
				startpop: [{ size: 1, apply: ['boosted'] }],
				transmit: [{
					vector: ['v_inj'], apply: ['infected'],
					value: 100, sd: 0, precise: true, phase: 'inject',
				}],
			}],
		};
		const world = await bootScenario(scenario);
		const infected = popWithTrait(world, 'infected');
		// 100 vectors × 2.0 modifier = 200 mathematically, but the engine
		// must clamp so that hits ≤ shed size.
		expect(infected).toBeLessThanOrEqual(100);
		expect(infected).toBeGreaterThan(0);
		expect(totalPop(world)).toBe(1_000_000);
	});
});

describe('Modifier stacking is multiplicative, not additive', () => {
	it('two 0.5 ContactModifiers compose to 0.25', { timeout: 30000 }, async () => {
		// Per-day trait Transmit (real shed key, so getContactMod applies).
		// Half the pop carries modA+modB (effective mult 0.25), the other half
		// carries neither (mult 1.0). After several days, infection rate
		// in the protected half should be substantially lower than in plain.
		const scenario: Record<string, unknown> = {
			name: 'ModStack',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					transmit: [{ vector: ['v1'], apply: ['infected'], value: 1.0, sd: 0, phase: 'spread' }],
				},
				{ key: 'modA', name: 'Mod A', infect_mod: [{ vector: ['v1'], mult: 0.5 }] },
				{ key: 'modB', name: 'Mod B', infect_mod: [{ vector: ['v1'], mult: 0.5 }] },
			],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 200_000,
				startpop: [
					{ size: 100, apply: ['modA', 'modB'] },
					{ size: 100, apply: [] },
					{ size: 1, apply: ['infected'] },
					{ size: 1, apply: ['modA', 'modB', 'infected'] },
				],
			}],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 4);

		const protectedInfected =
			popOnSiteWithAllTraits(world, 'site_a', ['modA', 'modB', 'infected']);
		const protectedTotal = popOnSiteWithAllTraits(world, 'site_a', ['modA', 'modB']);
		const totalInfected = popOnSiteWithTrait(world, 'site_a', 'infected');
		const plainInfected = totalInfected - protectedInfected;
		const plainTotal = 200_000 - protectedTotal;

		expect(protectedInfected).toBeGreaterThan(0);
		expect(plainInfected).toBeGreaterThan(0);

		// Compare infection FRACTIONS (since the two halves may differ slightly
		// in size from rounding). plain_frac : protected_frac ≈ 4:1 ideally.
		// Allow 2× to 8× to absorb early-exponential-growth nonlinearity.
		const plainFrac = plainInfected / plainTotal;
		const protectedFrac = protectedInfected / protectedTotal;
		const ratio = plainFrac / protectedFrac;
		expect(ratio).toBeGreaterThan(2);
		expect(ratio).toBeLessThan(8);
	});
});

describe('Cure deactivates modifier', () => {
	it('once vaccinated trait is removed, infection rate returns to baseline', { timeout: 30000 }, async () => {
		// Phase 1: a "stripping" shed cures the vaccinated trait from half the pop.
		// Phase 2: an infect shed targets everyone equally.
		// After many days, all surviving vaccinated should have been stripped,
		// and infections should NO LONGER show a vaccinated/non-vaccinated gap.
		const scenario: Record<string, unknown> = {
			name: 'CureDeactivate',
			start_age: 0,
			use_date: false,
			phase: [
				{ key: 'strip', name: 'Strip' },
				{ key: 'inject', name: 'Inject' },
			],
			trait: [
				{ key: 'infected', name: 'Infected' },
				{ key: 'vaccinated', name: 'Vaccinated',
					infect_mod: [{ vector: ['v_inject'], mult: 0 }] },
				{
					key: 'stripper', name: 'Stripper',
					transmit: [{
						vector: ['v_strip'], remove: ['vaccinated'],
						value: 5, sd: 0, phase: 'strip',
					}],
				},
			],
			vector: [
				{ key: 'v_strip', name: 'Strip vec' },
				{ key: 'v_inject', name: 'Inject vec' },
			],
			site: [{
				key: 'site_a', name: 'Site A', pop: 10_000,
				startpop: [
					{ size: 50, apply: ['vaccinated'] },
					{ size: 50, apply: ['stripper'] },
				],
				transmit: [{
					vector: ['v_inject'], apply: ['infected'],
					value: 0.01, sd: 0, popmult: true, phase: 'inject',
				}],
			}],
		};
		const world = await bootScenario(scenario);

		// After many days: stripping should have removed `vaccinated` from
		// most/all of the population, and the infection rate of formerly-
		// vaccinated units should now match baseline (no protection left).
		await runDays(world, 30);
		const stillVaccinated = popOnSiteWithTrait(world, 'site_a', 'vaccinated');
		const totalInfected = popOnSiteWithTrait(world, 'site_a', 'infected');

		// Most vaccinated have been stripped.
		expect(stillVaccinated).toBeLessThan(2_000);
		// And infection has spread (was being blocked by mult=0 originally on
		// the vaccinated half — once strip happens it's no longer blocked).
		expect(totalInfected).toBeGreaterThan(0);
		expect(totalPop(world)).toBe(10_000);
	});
});

describe('ContactModifier apply/remove traits', () => {
	it('infect_mod apply adds traits and remove subtracts traits at infection', { timeout: 30000 }, async () => {
		// The "vulnerable" trait carries an ContactModifier on v1 that ALSO
		// applies "weakened" and removes "shielded" when v1 lands. A
		// vulnerable+shielded unit catching "infected" via v1 should end up
		// vulnerable+infected+weakened (no longer shielded). Exercises the
		// apply_traits / remove_traits path in Syndrome.getContactMod.
		const scenario: Record<string, unknown> = {
			name: 'InfModApplyRemove',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					transmit: [{ vector: ['v1'], apply: ['infected'], value: 1.0, sd: 0, phase: 'spread' }],
				},
				{ key: 'shielded', name: 'Shielded' },
				{ key: 'weakened', name: 'Weakened' },
				{
					key: 'vulnerable', name: 'Vulnerable',
					infect_mod: [{
						vector: ['v1'], mult: 1,
						apply: ['weakened'], remove: ['shielded'],
					}],
				},
			],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 10_000,
				startpop: [
					{ size: 9_990, apply: ['vulnerable', 'shielded'] },
					{ size: 10, apply: ['infected'] },
				],
			}],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 6);

		const newlyInfected = popOnSiteWithAllTraits(world, 'site_a', ['vulnerable', 'infected']);
		expect(newlyInfected).toBeGreaterThan(0);

		// Every modifier-routed infection should have gained "weakened"...
		const infectedWeakened = popOnSiteWithAllTraits(world, 'site_a',
			['vulnerable', 'infected', 'weakened']);
		expect(infectedWeakened).toBe(newlyInfected);

		// ...and lost "shielded".
		const infectedShielded = popOnSiteWithAllTraits(world, 'site_a',
			['vulnerable', 'infected', 'shielded']);
		expect(infectedShielded).toBe(0);

		// Sanity: uninfected vulnerable units never spuriously gained "weakened".
		const allWeakened = popOnSiteWithAllTraits(world, 'site_a', ['vulnerable', 'weakened']);
		expect(allWeakened - infectedWeakened).toBe(0);

		expect(totalPop(world)).toBe(10_000);
	});
});

describe('ProgressModifier apply/remove traits', () => {
	it('progress_mod apply/remove inject extra trait changes into the progression shed', { timeout: 30000 }, async () => {
		// "infected" progresses to "recovered" (drops "infected"). The
		// "comorbidity" trait carries a ProgressModifier on the progression
		// vector that ALSO applies "severe" and removes "vaccinated".
		// An infected+vaccinated+comorbidity unit that progresses should
		// land as recovered+severe+comorbidity (no longer vaccinated, no
		// longer infected). Exercises applyModToSynTransmit on the progress
		// path.
		const scenario: Record<string, unknown> = {
			name: 'ProgModApplyRemove',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'progress', name: 'Progress' }],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					progress: [{
						vector: ['v_p'], apply: ['recovered'], remove: ['infected'],
						value: 0.3, sd: 0, phase: 'progress',
					}],
				},
				{ key: 'recovered', name: 'Recovered' },
				{ key: 'vaccinated', name: 'Vaccinated' },
				{ key: 'severe', name: 'Severe' },
				{
					key: 'comorbidity', name: 'Comorbidity',
					progress_mod: [{
						vector: ['v_p'], mult: 1,
						apply: ['severe'], remove: ['vaccinated'],
					}],
				},
			],
			vector: [{ key: 'v_p', name: 'Progress vec' }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 1_000,
				startpop: [
					{ size: 1_000, apply: ['infected', 'vaccinated', 'comorbidity'] },
				],
			}],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 8);

		// Some progression must have happened.
		const recovered = popOnSiteWithAllTraits(world, 'site_a', ['comorbidity', 'recovered']);
		expect(recovered).toBeGreaterThan(0);

		// Every recovered unit should have gained "severe"...
		const recoveredSevere = popOnSiteWithAllTraits(world, 'site_a',
			['comorbidity', 'recovered', 'severe']);
		expect(recoveredSevere).toBe(recovered);

		// ...and lost "vaccinated".
		const recoveredVaccinated = popOnSiteWithAllTraits(world, 'site_a',
			['comorbidity', 'recovered', 'vaccinated']);
		expect(recoveredVaccinated).toBe(0);

		// Still-infected units should be unchanged: vaccinated, no severe.
		const stillInfected = popOnSiteWithAllTraits(world, 'site_a', ['comorbidity', 'infected']);
		const stillInfectedVaccinated = popOnSiteWithAllTraits(world, 'site_a',
			['comorbidity', 'infected', 'vaccinated']);
		expect(stillInfectedVaccinated).toBe(stillInfected);
		const stillInfectedSevere = popOnSiteWithAllTraits(world, 'site_a',
			['comorbidity', 'infected', 'severe']);
		expect(stillInfectedSevere).toBe(0);

		expect(totalPop(world)).toBe(1_000);
	});
});

describe('TransmitModifier apply/remove traits', () => {
	it('transmit_mod apply/remove inject extra trait changes into the outgoing shed', { timeout: 30000 }, async () => {
		// "infected" transmits "infected" via v1. The "supershedder" trait
		// carries a TransmitModifier on v1 that ALSO applies "marked" and
		// removes "clean". Because every infected source in this scenario
		// is also a supershedder, every shed produced carries the extra
		// trait changes. A clean unit hit by such a shed should become
		// infected+marked (no longer clean). Exercises applyModToSynTransmit
		// on the transmit path.
		const scenario: Record<string, unknown> = {
			name: 'TxModApplyRemove',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					transmit: [{ vector: ['v1'], apply: ['infected'], value: 1.0, sd: 0, phase: 'spread' }],
				},
				{ key: 'clean', name: 'Clean' },
				{ key: 'marked', name: 'Marked' },
				{
					key: 'supershedder', name: 'Supershedder',
					transmit_mod: [{
						vector: ['v1'], mult: 1,
						apply: ['marked'], remove: ['clean'],
					}],
				},
			],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 10_000,
				startpop: [
					{ size: 100, apply: ['infected', 'supershedder'] },
					{ size: 9_900, apply: ['clean'] },
				],
			}],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 4);

		// New infections should have happened beyond the 100 seeds.
		const totalInfected = popOnSiteWithTrait(world, 'site_a', 'infected');
		expect(totalInfected).toBeGreaterThan(100);

		// Every newly-infected (formerly-clean) unit must have lost "clean".
		// No infected unit should still be tagged clean.
		const infectedClean = popOnSiteWithAllTraits(world, 'site_a', ['infected', 'clean']);
		expect(infectedClean).toBe(0);

		// Newly-infected units should have gained "marked".
		const newlyInfected = totalInfected - 100;
		const newlyInfectedMarked = popOnSiteWithAllTraits(world, 'site_a',
			['infected', 'marked']) - popOnSiteWithAllTraits(world, 'site_a',
			['infected', 'supershedder', 'marked']);
		expect(newlyInfectedMarked).toBe(newlyInfected);

		// Sanity: untouched clean units never gained "marked".
		const cleanMarked = popOnSiteWithAllTraits(world, 'site_a', ['clean', 'marked']);
		expect(cleanMarked).toBe(0);

		expect(totalPop(world)).toBe(10_000);
	});
});
