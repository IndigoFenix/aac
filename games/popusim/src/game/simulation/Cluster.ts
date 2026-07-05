/**
 * Cluster - Hierarchical population organization by trait
 * PopBranch - A branch of population with specific traits
 * PopCluster - A cluster of population branches for a trait
 */

import type { Trait } from '../traits/Trait';
import type { Population } from './Population';
import type { Shed } from './Shed';

// Forward references
interface WorldLike {
	clusters: ClusterLike[][];
}

interface SiteLike {
	world: WorldLike;
}

interface ClusterLike {
	key: string;
	trait: Trait;
	level: number;
}

/**
 * Cluster - Represents a hierarchical trait grouping
 * Each cluster has an associated trait and organizes populations
 */
export class Cluster {
	trait: Trait;
	level: number;
	key: string;

	constructor(trait: Trait, level: number) {
		this.trait = trait;
		this.level = level;
		this.key = trait.key;
	}
}

/**
 * PopBranch - A branch in the population hierarchy
 * 
 * A pop branch represents a number of units with a particular set of traits.
 * These units may have other traits below this level.
 * A pop branch should have a PopCluster for each cluster below its level.
 * All PopClusters should have the same population size.
 */
export class PopBranch {
	site: SiteLike;
	world: WorldLike;
	popcluster: PopCluster | null;
	traits: Trait[];
	popclusters: PopCluster[] & { kv: Record<string, PopCluster> };
	popclusters_kv: Record<string, PopCluster> = {};
	pops: Population[] | null = null;
	pop: Population | null = null;
	level: number;
	is_bottom: boolean;
	size: number;

	constructor(
		site: SiteLike,
		popcluster: PopCluster | null,
		size: number,
		traits?: Trait[]
	) {
		this.site = site;
		this.world = site.world;
		this.popcluster = popcluster;
		this.traits = traits || [];
		
		this.popclusters = [] as unknown as PopCluster[] & { kv: Record<string, PopCluster> };
		(this.popclusters as unknown as { kv: Record<string, PopCluster> }).kv = {};
		
		this.level = this.popcluster ? this.popcluster.level : 0;
		this.is_bottom = this.level === this.world.clusters.length - 1;
		this.size = size;

		if (this.size > 0) {
			this.onPopInitialized();
		} else {
			this.pop = null;
		}
	}

	onPopInitialized(): void {
		if (this.is_bottom) {
			this.pop = this.createPopulation();
		} else {
			this.createSubClusters();
			this.pop = null;
		}
	}

	createSubClusters(): void {
		const clusters = this.world.clusters[this.level];
		for (const cluster of clusters) {
			const pc = new PopCluster(this.site, this, cluster as unknown as Cluster);
			this.popclusters.push(pc);
			this.popclusters_kv[cluster.key] = pc;
		}
	}

	createPopulation(): Population | null {
		// Override in subclass or implement when needed
		return null;
	}

	updateBranchContact(amount: number, shed: Shed): void {
		if (this.size === 0) return;

		// Find the relevant cluster and pass the vector to it
		for (let level = this.level; level < this.world.clusters.length; level++) {
			const relevantClusterKey = shed.relevant_clusters[level];
			if (relevantClusterKey) {
				const relevant_cluster = this.popclusters_kv[relevantClusterKey.key];
				if (relevant_cluster) {
					relevant_cluster.updateClusterContact(amount, shed);
					break;
				}
			}
		}
	}

	getAllRelevantSubpops(relevant_clusters: Record<number, ClusterLike>): Population[] {
		if (this.is_bottom) {
			return this.pop ? [this.pop] : [];
		}

		const subpops: Population[] = [];
		const relevant_cluster = relevant_clusters[this.level + 1];

		if (relevant_cluster) {
			const pc = this.popclusters_kv[relevant_cluster.key];
			if (pc) {
				for (const branch of pc.popbranches) {
					subpops.push(...branch.getAllRelevantSubpops(relevant_clusters));
				}
			}
		}

		return subpops;
	}

	getAllSubpopsOfShed(_amount: number, _shed: Shed): Population[] {
		// Override in subclass or implement when needed
		return [];
	}
}

/**
 * PopCluster - A cluster of population branches for a trait
 * 
 * A PopCluster represents a set of PopBranches.
 * The total of all PopBranches populations should add up to
 * the population of the PopCluster, which equals the PopBranch above it.
 */
export class PopCluster {
	site: SiteLike;
	world: WorldLike;
	branch: PopBranch;
	cluster: Cluster;
	trait: Trait;
	level: number;
	branch_without_trait: PopBranch;
	branch_with_trait: PopBranch;
	popbranches: PopBranch[];

	constructor(site: SiteLike, branch: PopBranch, cluster: Cluster) {
		this.site = site;
		this.world = site.world;
		this.branch = branch;
		this.cluster = cluster;
		this.trait = cluster.trait;
		this.level = cluster.level;

		// Create branches with and without the trait
		this.branch_without_trait = new PopBranch(
			site,
			this,
			this.branch.size,
			this.branch.traits
		);
		
		this.branch_with_trait = new PopBranch(
			site,
			this,
			0,
			[...this.branch.traits, this.trait]
		);

		this.popbranches = [
			this.branch_without_trait,
			this.branch_with_trait
		];
	}

	addPopBranch(traits: Trait[]): PopBranch {
		const b = new PopBranch(this.site, this, 0, traits);
		this.popbranches.push(b);
		return b;
	}

	updateClusterContact(_amount: number, _shed: Shed): void {
		// Distribute the vector into the branch with and without the trait as needed
		// Implementation depends on game logic
	}
}

export default Cluster;
