export class DynamicControllerSuspended extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DynamicControllerSuspended";
	}
}

export class DynamicControllerNestedApprovalBlocked extends Error {
	constructor(
		message: string,
		public readonly nestedRunId: string,
	) {
		super(message);
		this.name = "DynamicControllerNestedApprovalBlocked";
	}
}

export class DynamicControllerBudgetBlocked extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DynamicControllerBudgetBlocked";
	}
}
