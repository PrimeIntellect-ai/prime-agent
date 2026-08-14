export interface WorkflowUsage {
	input: number;
	output: number;
	totalTokens: number;
	cost: number;
}

export interface WorkflowJournalStart {
	sequence: number;
	key: string;
	occurrence: number;
}

export interface WorkflowJournalEntry extends WorkflowJournalStart {
	result: unknown;
	usage?: Partial<WorkflowUsage>;
}

export interface WorkflowJournal {
	start(entry: WorkflowJournalStart): void;
	replay(entry: WorkflowJournalStart): WorkflowJournalEntry | undefined;
	record(entry: WorkflowJournalEntry): void;
	entries(): WorkflowJournalEntry[];
}
