/**
 * Generic confirm-with-impact modal for rename and delete-with-references.
 *
 * Renders the affected sites grouped by parent schema label so the user
 * sees something like:
 *   This will update 12 references:
 *     • Transmit: 5
 *     • Progress Mod: 4
 *     • Infect Mod: 3
 *
 * The component is presentational; the parent owns the action.
 */

import type { RefSite } from '../refScan';
import { summarizeSites } from '../refScan';

interface Props {
	title: string;
	body: string;
	sites: RefSite[];
	/** Verb for the affected references — "updated" for renames, "cleared"
	 * for deletes. Used in the heading "This will <verb> N references". */
	impactVerb: string;
	/** Primary button label. */
	primaryLabel: string;
	/** Optional secondary action — e.g. "Delete only" for the delete flow,
	 * letting the user proceed without touching references. */
	secondaryLabel?: string;
	primaryDestructive?: boolean;
	onPrimary: () => void;
	onSecondary?: () => void;
	onCancel: () => void;
}

export function RefImpactModal({
	title, body, sites, impactVerb,
	primaryLabel, secondaryLabel, primaryDestructive,
	onPrimary, onSecondary, onCancel,
}: Props) {
	const groups = summarizeSites(sites);
	const total = sites.length;

	return (
		<div class="modal-backdrop" onClick={onCancel}>
			<div class="modal" onClick={(e) => e.stopPropagation()}>
				<div class="modal-header">{title}</div>
				<div class="modal-body" style="max-width: 32rem">
					<p>{body}</p>
					{total === 0 ? (
						<p class="ref-impact-none">No references found.</p>
					) : (
						<>
							<p class="ref-impact-summary">
								This will {impactVerb} {total} reference{total === 1 ? '' : 's'}:
							</p>
							<ul class="ref-impact-list">
								{groups.map(g => (
									<li key={g.label}>
										<span class="ref-impact-label">{g.label}</span>
										<span class="ref-impact-count">{g.count}</span>
									</li>
								))}
							</ul>
						</>
					)}
				</div>
				<div class="modal-footer">
					<button onClick={onCancel}>Cancel</button>
					{secondaryLabel && onSecondary && (
						<button onClick={onSecondary}>{secondaryLabel}</button>
					)}
					<button
						class={primaryDestructive ? 'destructive' : 'primary'}
						onClick={onPrimary}
					>
						{primaryLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
