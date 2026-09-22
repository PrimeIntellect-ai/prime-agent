/**
 * Click regions: components record them during render() in their own
 * render-output coordinates; containers aggregate them with line offsets
 * and the fullscreen viewport projects them onto screen rows.
 */

/** Position of a click relative to the clicked region's top-left cell. */
export interface ClickPosition {
	/** Zero-based row within the region. */
	row: number;
	/** Zero-based column within the region. */
	col: number;
}

/** A rectangular clickable area produced by a component render. */
export interface ClickRegion {
	/** Zero-based line of the region's top row within the component's rendered output. */
	line: number;
	/** Zero-based visible column of the region's left edge. */
	col: number;
	/** Region width in visible columns. */
	width: number;
	/** Region height in rows. */
	height: number;
	onClick: (position: ClickPosition) => void;
}
