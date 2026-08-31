/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores cloned state snapshots. Popped snapshots are returned directly
 * since they are already detached.
 */
export class UndoStack<S> {
	private stack: S[] = [];

	constructor(private readonly clone: (state: S) => S = structuredClone) {}

	push(state: S): void {
		this.stack.push(this.clone(state));
	}

	pop(): S | undefined {
		return this.stack.pop();
	}

	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
