export interface TestPolicyViolation {
	category: string;
	detail: string;
	identity: string;
	line: number;
	title: string;
}

export interface TestPolicyFailure {
	path: string;
	line: number;
	category: string;
	title: string;
	detail: string;
}

export type TestPolicyDebt = Record<string, Record<string, number>>;

export function scan(content: string, path?: string, embedded?: boolean): TestPolicyViolation[];

export function debtFailures(frozen: TestPolicyDebt, current: TestPolicyDebt): TestPolicyFailure[];
