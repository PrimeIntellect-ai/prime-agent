import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, Image, Text, type TUI } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.js";
import type { KernelSentAgentMessage } from "../../../core/kernel/index.js";
import { createBashToolDefinition } from "../../../core/tools/bash.js";
import { createEditToolDefinition } from "../../../core/tools/edit.js";
import { createAllToolDefinitions } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.js";
import type { AgentConnectionToolDefinition } from "../../agent-connection/index.js";
import { type Theme, theme } from "../theme/theme.js";
import { getWorkingPulseFrame, workingIconFrame } from "../theme/working-icon.js";
import { FileChangeSummaryComponent, getToolFileChanges } from "./edit-summary.js";
import { getIpythonCodeFromArgs, IPythonCellComponent } from "./ipython-cell.js";
import { ToolPanel } from "./tool-panel.js";

export interface ToolExecutionOptions {
	showImages?: boolean;
	/** Whether image metadata may parse dimensions from base64 data. */
	includeImageDimensions?: boolean;
}

export interface ToolExecutionRendererDefinition {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}
export type ToolExecutionDefinition = AgentConnectionToolDefinition & Partial<ToolExecutionRendererDefinition>;

function hasToolRenderer(toolDefinition: ToolExecutionDefinition | undefined): boolean {
	return toolDefinition?.renderCall !== undefined || toolDefinition?.renderResult !== undefined;
}

function matchesBuiltInReplayMetadata(toolName: string, toolDefinition: ToolExecutionDefinition | undefined): boolean {
	if (!toolDefinition) {
		return true;
	}
	if (hasToolRenderer(toolDefinition)) {
		return false;
	}
	return toolDefinition.replayBuiltInToolName === toolName;
}

function createReplayBuiltInToolDefinition(
	toolName: string,
	cwd: string,
	toolDefinition: ToolExecutionDefinition | undefined,
): ToolDefinition<any, any> | undefined {
	if (toolName === "ipython") {
		return createAllToolDefinitions(cwd).ipython;
	}
	switch (toolName) {
		case "bash": {
			const builtInDefinition = createBashToolDefinition(cwd);
			return matchesBuiltInReplayMetadata(toolName, toolDefinition) ? builtInDefinition : undefined;
		}
		case "edit": {
			const builtInDefinition = createEditToolDefinition(cwd);
			return matchesBuiltInReplayMetadata(toolName, toolDefinition) ? builtInDefinition : undefined;
		}
		default:
			return undefined;
	}
}

export class ToolExecutionComponent extends Container {
	private contentPanel: ToolPanel;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private ipythonCellComponent?: IPythonCellComponent;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showExpandHint = true;
	private showImages: boolean;
	private includeImageDimensions: boolean;
	private isPartial = true;
	private toolDefinition?: ToolExecutionDefinition;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private pendingSentAgentMessages: KernelSentAgentMessage[] = [];
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolExecutionDefinition | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createReplayBuiltInToolDefinition(toolName, cwd, toolDefinition);
		this.showImages = options.showImages ?? true;
		this.includeImageDimensions = options.includeImageDimensions ?? true;
		this.ui = ui;
		this.cwd = cwd;

		// Always create both shell variants. contentPanel is the tool panel used
		// for default renderer-based composition (and the generic fallback when no
		// tool definition exists). selfRenderContainer is used when the tool
		// renders its own framing.
		this.contentPanel = new ToolPanel();
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			this.addChild(this.selfRenderContainer);
		} else {
			this.addChild(this.contentPanel);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (this.shouldUseIpythonRenderer()) {
			return "self";
		}
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private shouldUseIpythonRenderer(): boolean {
		return this.toolName === "ipython" && !this.toolDefinition?.renderCall && !this.toolDefinition?.renderResult;
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showExpandHint: this.showExpandHint,
			showImages: this.showImages,
			includeImageDimensions: this.includeImageDimensions,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		const details =
			typeof result.details === "object" && result.details !== null
				? (result.details as Record<string, unknown>)
				: {};
		const sentAgentMessages = Array.isArray(details.sentAgentMessages) ? [...details.sentAgentMessages] : [];
		for (const message of this.pendingSentAgentMessages) {
			if (
				!sentAgentMessages.some(
					(entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === message.id,
				)
			) {
				sentAgentMessages.push(message);
			}
		}
		this.result = sentAgentMessages.length > 0 ? { ...result, details: { ...details, sentAgentMessages } } : result;
		this.isPartial = isPartial;
		this.updateDisplay();
	}

	appendSentAgentMessage(message: KernelSentAgentMessage): void {
		if (this.pendingSentAgentMessages.some((entry) => entry.id === message.id)) {
			return;
		}
		this.pendingSentAgentMessages.push(message);
		if (this.result) {
			this.updateResult(this.result, this.isPartial);
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowExpandHint(show: boolean): void {
		if (this.showExpandHint === show) {
			return;
		}
		this.showExpandHint = show;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setIncludeImageDimensions(include: boolean): void {
		this.includeImageDimensions = include;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		// Refresh the animated glyph without rebuilding the whole panel, for as long
		// as panelStatus() is still animating (including partial streaming results).
		if (this.isStatusAnimating() && !this.usesSelfRenderShell()) {
			this.contentPanel.setHeader(this.panelHeader());
		}
		return super.render(width);
	}

	private isStatusAnimating(): boolean {
		if (!this.executionStarted) {
			return false;
		}
		// Matches panelStatus(): animating until a non-partial or error result lands.
		if (this.result && !this.isPartial) {
			return false;
		}
		return !this.result?.isError;
	}

	private usesSelfRenderShell(): boolean {
		return this.hasRendererDefinition() && this.getRenderShell() === "self";
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			this.selfRenderContainer.clear();

			if (this.shouldUseIpythonRenderer()) {
				const state = {
					code: getIpythonCodeFromArgs(this.args),
					content: this.result?.content,
					details: this.result?.details,
					isPartial: this.isPartial,
					isError: this.result?.isError ?? false,
					expanded: this.expanded,
					executionStarted: this.executionStarted,
					argsComplete: this.argsComplete,
					showExpandHint: this.showExpandHint,
					showImages: this.showImages,
					cwd: this.cwd,
				};
				if (!this.ipythonCellComponent) {
					this.ipythonCellComponent = new IPythonCellComponent(state);
				} else {
					this.ipythonCellComponent.update(state);
				}
				this.selfRenderContainer.addChild(this.ipythonCellComponent);
				hasContent = true;
			} else {
				hasContent = this.mountRenderers(this.selfRenderContainer, true);
			}
		} else {
			// Default shell: tool panel with a `label · status` header so the block
			// is self-identifying. The header replaces the bold-tool-name fallback.
			this.contentPanel.setHeader(this.panelHeader());
			this.contentPanel.clear();
			if (this.hasRendererDefinition()) {
				this.mountRenderers(this.contentPanel, false);
			} else {
				const fallbackText = this.formatToolExecution();
				if (fallbackText) {
					this.contentPanel.addChild(new Text(fallbackText, 0, 0));
				}
			}
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (!this.showImages || !img.data || !img.mimeType) continue;

				const imageComponent = new Image(
					img.data,
					img.mimeType,
					{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
					{
						fallbackOnly: true,
						fallbackPrefix: "    ╰─ ",
					},
				);
				this.imageComponents.push(imageComponent);
				this.addChild(imageComponent);
			}
		}

		const isBuiltInEdit =
			this.toolName === "edit" &&
			(this.toolDefinition === undefined || this.toolDefinition.replayBuiltInToolName === "edit");
		if (!this.expanded && this.result && (isBuiltInEdit || this.shouldUseIpythonRenderer())) {
			const changes = getToolFileChanges(this.toolName, this.args, this.result, this.cwd);
			if (changes.length > 0) {
				const container = this.usesSelfRenderShell() ? this.selfRenderContainer : this.contentPanel;
				container.addChild(new FileChangeSummaryComponent(changes, this.cwd));
				hasContent = true;
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	/**
	 * Mount the call/result renderer components into the given shell container.
	 * `useFallbacks` keeps the bold-tool-name call fallback for self-rendering
	 * tools; the default panel shell already names the tool in its header.
	 */
	private mountRenderers(container: Container | ToolPanel, useFallbacks: boolean): boolean {
		let hasContent = false;

		const callRenderer = this.getCallRenderer();
		if (!callRenderer) {
			if (useFallbacks) {
				container.addChild(this.createCallFallback());
				hasContent = true;
			}
		} else {
			try {
				const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
				this.callRendererComponent = component;
				container.addChild(component);
				hasContent = true;
			} catch {
				this.callRendererComponent = undefined;
				if (useFallbacks) {
					container.addChild(this.createCallFallback());
					hasContent = true;
				}
			}
		}

		if (this.result) {
			const resultRenderer = this.getResultRenderer();
			if (!resultRenderer) {
				const component = this.createResultFallback();
				if (component) {
					container.addChild(component);
					hasContent = true;
				}
			} else {
				try {
					const component = resultRenderer(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						this.getRenderContext(this.resultRendererComponent),
					);
					this.resultRendererComponent = component;
					container.addChild(component);
					hasContent = true;
				} catch {
					this.resultRendererComponent = undefined;
					const component = this.createResultFallback();
					if (component) {
						container.addChild(component);
						hasContent = true;
					}
				}
			}
		}

		return hasContent;
	}

	private panelHeader(): string {
		const label = this.toolDefinition?.label ?? this.builtInToolDefinition?.label ?? this.toolName;
		return `${theme.fg("muted", label)}${theme.fg("dim", " · ")}${this.panelStatus()}`;
	}

	private panelStatus(): string {
		if (this.result && !this.isPartial) {
			return this.result.isError ? theme.fg("error", "error") : theme.fg("success", "done");
		}
		if (this.result?.isError) {
			return theme.fg("error", "error");
		}
		if (this.executionStarted) {
			return theme.fg("bashMode", `${workingIconFrame(getWorkingPulseFrame())} running`);
		}
		return theme.fg("muted", "queued");
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages, {
			includeImageDimensions: this.includeImageDimensions,
		});
	}

	private formatToolExecution(): string {
		const parts: string[] = [];
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			parts.push(content);
		}
		const output = this.getTextOutput();
		if (output) {
			parts.push(output);
		}
		return parts.join("\n\n");
	}
}

export function selectLatestToolExpandHint(
	existingComponents: readonly Component[],
	latestComponent: ToolExecutionComponent,
): void {
	for (let index = existingComponents.length - 1; index >= 0; index--) {
		const component = existingComponents[index];
		if (component instanceof ToolExecutionComponent) {
			component.setShowExpandHint(false);
			break;
		}
	}
	latestComponent.setShowExpandHint(true);
}
