export type ClipboardModule = {
	setText: (text: string) => Promise<void>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

export function loadBundledClipboard(): ClipboardModule | null {
	return null;
}
