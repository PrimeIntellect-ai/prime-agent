/**
 * Best-effort LaTeX math to Unicode plain text conversion for terminal display.
 *
 * The goal is readable math in a monospace grid, not faithful typesetting:
 * symbols map to their Unicode equivalents (\sum → ∑, \alpha → α), scripts use
 * Unicode sub/superscript characters when every character is available
 * (x_{t-k} → xₜ₋ₖ) and stay in TeX notation otherwise (x_\theta → x_θ), and
 * structural commands degrade to linear notation (\frac{a}{b} → a/b).
 * Unknown commands keep their name with the backslash dropped, so output is
 * never worse than the raw source.
 */

const SYMBOLS: Record<string, string> = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "ϕ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	oint: "∮",
	bigcup: "⋃",
	bigcap: "⋂",
	bigoplus: "⨁",
	bigotimes: "⨂",
	bigodot: "⨀",
	bigvee: "⋁",
	bigwedge: "⋀",
	bigsqcup: "⨆",
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	cdot: "·",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "•",
	oplus: "⊕",
	ominus: "⊖",
	otimes: "⊗",
	oslash: "⊘",
	odot: "⊙",
	wedge: "∧",
	land: "∧",
	vee: "∨",
	lor: "∨",
	cap: "∩",
	cup: "∪",
	setminus: "∖",
	sqcap: "⊓",
	sqcup: "⊔",
	uplus: "⊎",
	dagger: "†",
	ddagger: "‡",
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	neq: "≠",
	ne: "≠",
	equiv: "≡",
	sim: "∼",
	simeq: "≃",
	approx: "≈",
	cong: "≅",
	propto: "∝",
	ll: "≪",
	gg: "≫",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	sqsubseteq: "⊑",
	sqsupseteq: "⊒",
	in: "∈",
	ni: "∋",
	notin: "∉",
	models: "⊨",
	vdash: "⊢",
	dashv: "⊣",
	perp: "⊥",
	parallel: "∥",
	mid: "∣",
	asymp: "≍",
	doteq: "≐",
	prec: "≺",
	succ: "≻",
	preceq: "⪯",
	succeq: "⪰",
	triangleq: "≜",
	coloneqq: "≔",
	coloneq: "≔",
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	gets: "←",
	leftrightarrow: "↔",
	Rightarrow: "⇒",
	Leftarrow: "⇐",
	Leftrightarrow: "⇔",
	iff: "⇔",
	implies: "⇒",
	impliedby: "⇐",
	mapsto: "↦",
	longrightarrow: "⟶",
	longleftarrow: "⟵",
	Longrightarrow: "⟹",
	Longleftarrow: "⟸",
	longmapsto: "⟼",
	uparrow: "↑",
	downarrow: "↓",
	updownarrow: "↕",
	Uparrow: "⇑",
	Downarrow: "⇓",
	hookrightarrow: "↪",
	hookleftarrow: "↩",
	rightharpoonup: "⇀",
	leftharpoonup: "↼",
	rightrightarrows: "⇉",
	rightleftarrows: "⇄",
	leadsto: "⇝",
	nearrow: "↗",
	searrow: "↘",
	nwarrow: "↖",
	swarrow: "↙",
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	emptyset: "∅",
	varnothing: "∅",
	neg: "¬",
	lnot: "¬",
	angle: "∠",
	triangle: "△",
	square: "□",
	Box: "□",
	blacksquare: "■",
	diamond: "⋄",
	Diamond: "◇",
	aleph: "ℵ",
	hbar: "ℏ",
	ell: "ℓ",
	Re: "ℜ",
	Im: "ℑ",
	wp: "℘",
	top: "⊤",
	bot: "⊥",
	flat: "♭",
	sharp: "♯",
	natural: "♮",
	checkmark: "✓",
	degree: "°",
	prime: "′",
	therefore: "∴",
	because: "∵",
	dots: "…",
	ldots: "…",
	dotsc: "…",
	dotso: "…",
	cdots: "⋯",
	dotsb: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	langle: "⟨",
	rangle: "⟩",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	lvert: "|",
	rvert: "|",
	vert: "|",
	lVert: "‖",
	rVert: "‖",
	Vert: "‖",
};

/** Operator names render as plain words (\log → log). */
const OPERATOR_NAMES = new Set([
	"log",
	"ln",
	"lg",
	"exp",
	"sin",
	"cos",
	"tan",
	"cot",
	"sec",
	"csc",
	"arcsin",
	"arccos",
	"arctan",
	"sinh",
	"cosh",
	"tanh",
	"coth",
	"min",
	"max",
	"argmin",
	"argmax",
	"arg",
	"sup",
	"inf",
	"lim",
	"limsup",
	"liminf",
	"det",
	"dim",
	"ker",
	"deg",
	"gcd",
	"hom",
	"Pr",
	"tr",
	"Tr",
	"rank",
	"diag",
	"sgn",
	"softmax",
	"mod",
	"bmod",
]);

/** Single-character escapes (\{ → {) and spacing commands. */
const ESCAPES: Record<string, string> = {
	"{": "{",
	"}": "}",
	"%": "%",
	$: "$",
	"&": "&",
	"#": "#",
	_: "_",
	"|": "‖",
	"\\": "\n",
	" ": " ",
	",": " ",
	";": " ",
	":": " ",
	"!": "",
};

const SPACING_COMMANDS: Record<string, string> = {
	quad: "  ",
	qquad: "    ",
	thinspace: " ",
	enspace: " ",
	medspace: " ",
	thickspace: " ",
};

/** Accent commands → combining character appended to each character. */
const ACCENTS: Record<string, string> = {
	hat: "̂",
	widehat: "̂",
	bar: "̄",
	overline: "̅",
	underline: "̲",
	vec: "⃗",
	tilde: "̃",
	widetilde: "̃",
	dot: "̇",
	ddot: "̈",
	breve: "̆",
	check: "̌",
	acute: "́",
	grave: "̀",
	mathring: "̊",
};

const SUPERSCRIPTS: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	"*": "*",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	θ: "ᶿ",
	ϕ: "ᵠ",
	φ: "ᵠ",
	χ: "ᵡ",
};

const SUBSCRIPTS: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	ϕ: "ᵩ",
	φ: "ᵩ",
	χ: "ᵪ",
};

const COMMON_FRACTIONS: Record<string, string> = {
	"1/2": "½",
	"1/3": "⅓",
	"2/3": "⅔",
	"1/4": "¼",
	"3/4": "¾",
	"1/5": "⅕",
	"2/5": "⅖",
	"3/5": "⅗",
	"4/5": "⅘",
	"1/6": "⅙",
	"5/6": "⅚",
	"1/8": "⅛",
};

interface AlphabetStyle {
	/** Code point of the styled "A" in the Mathematical Alphanumeric block. */
	upper?: number;
	/** Code point of the styled "a". */
	lower?: number;
	/** Code point of the styled "0". */
	digit?: number;
	/** Letters whose styled forms predate the block and live elsewhere in the BMP. */
	exceptions?: Record<string, string>;
}

const ALPHABETS: Record<string, AlphabetStyle> = {
	mathbb: {
		upper: 0x1d538,
		lower: 0x1d552,
		digit: 0x1d7d8,
		exceptions: { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" },
	},
	mathbf: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	boldsymbol: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	bm: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	textbf: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	mathcal: {
		upper: 0x1d49c,
		lower: 0x1d4b6,
		exceptions: {
			B: "ℬ",
			E: "ℰ",
			F: "ℱ",
			H: "ℋ",
			I: "ℐ",
			L: "ℒ",
			M: "ℳ",
			R: "ℛ",
			e: "ℯ",
			g: "ℊ",
			o: "ℴ",
		},
	},
	mathscr: {
		upper: 0x1d49c,
		lower: 0x1d4b6,
		exceptions: {
			B: "ℬ",
			E: "ℰ",
			F: "ℱ",
			H: "ℋ",
			I: "ℐ",
			L: "ℒ",
			M: "ℳ",
			R: "ℛ",
			e: "ℯ",
			g: "ℊ",
			o: "ℴ",
		},
	},
	mathfrak: {
		upper: 0x1d504,
		lower: 0x1d51e,
		exceptions: { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" },
	},
};

/** Text-mode commands: their argument is literal text, so ^ and _ stay as-is. */
const TEXT_COMMANDS = new Set(["text", "textrm", "textit", "textsf", "texttt", "mbox", "hbox"]);

/** Math-mode font commands rendered unstyled; scripts inside still apply. */
const MATH_FONT_COMMANDS = new Set(["mathrm", "mathit", "mathsf", "mathtt", "mathnormal", "operatorname"]);

/** Size/style commands that take no argument and render as nothing. */
const IGNORED_COMMANDS = new Set([
	"left",
	"right",
	"big",
	"Big",
	"bigg",
	"Bigg",
	"bigl",
	"bigr",
	"bigm",
	"Bigl",
	"Bigr",
	"Bigm",
	"biggl",
	"biggr",
	"Biggl",
	"Biggr",
	"displaystyle",
	"textstyle",
	"scriptstyle",
	"limits",
	"nolimits",
	"middle",
	"allowbreak",
	"nonumber",
	"notag",
]);

function styleAlphabet(text: string, style: AlphabetStyle): string {
	let result = "";
	for (const ch of text) {
		const exception = style.exceptions?.[ch];
		if (exception) {
			result += exception;
		} else if (ch >= "A" && ch <= "Z" && style.upper !== undefined) {
			result += String.fromCodePoint(style.upper + ch.charCodeAt(0) - 0x41);
		} else if (ch >= "a" && ch <= "z" && style.lower !== undefined) {
			result += String.fromCodePoint(style.lower + ch.charCodeAt(0) - 0x61);
		} else if (ch >= "0" && ch <= "9" && style.digit !== undefined) {
			result += String.fromCodePoint(style.digit + ch.charCodeAt(0) - 0x30);
		} else {
			result += ch;
		}
	}
	return result;
}

/** Map every character through a sub/superscript table, or return undefined if any character is missing. */
function mapScript(text: string, table: Record<string, string>): string | undefined {
	let result = "";
	for (const ch of text) {
		const mapped = table[ch];
		if (mapped === undefined) {
			return undefined;
		}
		result += mapped;
	}
	return result;
}

/** True when a fraction/sqrt operand reads unambiguously without parentheses. */
function isSimpleOperand(text: string): boolean {
	return [...text].length === 1 || /^[\p{L}\p{N}\p{M}]+$/u.test(text);
}

function parenthesize(text: string): string {
	return isSimpleOperand(text) ? text : `(${text})`;
}

class LatexParser {
	private readonly src: string;
	private pos = 0;
	private textMode = false;

	constructor(src: string) {
		this.src = src;
	}

	parse(): string {
		return this.parseSequence();
	}

	/** Render atoms (with attached scripts) until a closing brace or end of input. */
	private parseSequence(): string {
		let result = "";
		while (this.pos < this.src.length) {
			const ch = this.src[this.pos];
			if (ch === "}") {
				break;
			}
			if ((ch === "^" || ch === "_") && !this.textMode) {
				this.pos++;
				result += this.parseScript(ch === "^" ? SUPERSCRIPTS : SUBSCRIPTS, ch);
				continue;
			}
			if (ch === "&") {
				// Alignment marker: becomes a separating space unless one is there.
				this.pos++;
				if (!/\s$/.test(result)) {
					result += " ";
				}
				continue;
			}
			result += this.parseAtom() ?? "";
		}
		return result;
	}

	/** Render the next atom: a group, a command, or a single character. */
	private parseAtom(): string | undefined {
		if (this.pos >= this.src.length) {
			return undefined;
		}
		const ch = this.src[this.pos];
		if (ch === "{") {
			return this.parseGroup();
		}
		if (ch === "\\") {
			return this.parseCommand();
		}
		this.pos++;
		return ch;
	}

	/** Consume "{...}" and render its contents. Assumes "{" at the current position. */
	private parseGroup(): string {
		this.pos++; // consume "{"
		const content = this.parseSequence();
		if (this.src[this.pos] === "}") {
			this.pos++;
		}
		return content;
	}

	/** Consume "[...]" and render its contents, or return undefined when absent. */
	private parseOptionalBracket(): string | undefined {
		if (this.src[this.pos] !== "[") {
			return undefined;
		}
		const end = this.src.indexOf("]", this.pos + 1);
		if (end === -1) {
			return undefined;
		}
		const content = new LatexParser(this.src.slice(this.pos + 1, end)).parse();
		this.pos = end + 1;
		return content;
	}

	/** Render the next required argument: a braced group, or a single atom (TeX allows \frac12). */
	private parseArgument(): string {
		while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
			this.pos++;
		}
		if (this.src[this.pos] === "{") {
			return this.parseGroup();
		}
		return this.parseAtom() ?? "";
	}

	/** Render a ^ or _ script. The operator character itself is already consumed. */
	private parseScript(table: Record<string, string>, operator: string): string {
		const content = this.parseArgument();
		const mapped = mapScript(content, table);
		if (mapped !== undefined) {
			return mapped;
		}
		// No Unicode form for every character: keep lossless TeX notation (x_θ).
		return [...content].length === 1 ? `${operator}${content}` : `${operator}{${content}}`;
	}

	/** Render a command. Assumes "\" at the current position. */
	private parseCommand(): string {
		this.pos++; // consume "\"
		if (this.pos >= this.src.length) {
			return "";
		}

		const ch = this.src[this.pos];
		if (!/[a-zA-Z]/.test(ch)) {
			this.pos++;
			return ESCAPES[ch] ?? ch;
		}

		let name = "";
		while (this.pos < this.src.length && /[a-zA-Z]/.test(this.src[this.pos])) {
			name += this.src[this.pos];
			this.pos++;
		}
		if (this.src[this.pos] === "*") {
			this.pos++; // operatorname*, section* etc.
		}

		const symbol = SYMBOLS[name];
		if (symbol !== undefined) {
			return symbol;
		}
		if (OPERATOR_NAMES.has(name)) {
			return name;
		}
		const spacing = SPACING_COMMANDS[name];
		if (spacing !== undefined) {
			return spacing;
		}
		if (IGNORED_COMMANDS.has(name)) {
			if (name === "left" || name === "right") {
				return this.parseDelimiter();
			}
			return "";
		}
		if (TEXT_COMMANDS.has(name)) {
			const wasTextMode = this.textMode;
			this.textMode = true;
			const content = this.parseArgument();
			this.textMode = wasTextMode;
			return content;
		}
		if (MATH_FONT_COMMANDS.has(name)) {
			return this.parseArgument();
		}
		const alphabet = ALPHABETS[name];
		if (alphabet !== undefined) {
			return styleAlphabet(this.parseArgument(), alphabet);
		}
		const accent = ACCENTS[name];
		if (accent !== undefined) {
			const content = this.parseArgument();
			return [...content].map((c) => (/\s/.test(c) ? c : c + accent)).join("");
		}
		switch (name) {
			case "frac":
			case "dfrac":
			case "tfrac":
			case "cfrac": {
				const numerator = this.parseArgument();
				const denominator = this.parseArgument();
				const common = COMMON_FRACTIONS[`${numerator}/${denominator}`];
				if (common !== undefined) {
					return common;
				}
				return `${parenthesize(numerator)}/${parenthesize(denominator)}`;
			}
			case "binom": {
				const top = this.parseArgument();
				const bottom = this.parseArgument();
				return `C(${top},${bottom})`;
			}
			case "sqrt": {
				const index = this.parseOptionalBracket();
				const radicand = this.parseArgument();
				const operand = isSimpleOperand(radicand) ? radicand : `(${radicand})`;
				if (index === undefined) {
					return `√${operand}`;
				}
				if (index === "3") {
					return `∛${operand}`;
				}
				if (index === "4") {
					return `∜${operand}`;
				}
				return `${mapScript(index, SUPERSCRIPTS) ?? `^${index}`}√${operand}`;
			}
			case "not": {
				const negated = this.parseAtom() ?? "";
				return `${negated}̸`;
			}
			case "begin":
			case "end": {
				this.parseArgument(); // environment name
				return "";
			}
			case "stackrel":
			case "overset": {
				const above = this.parseArgument();
				const base = this.parseArgument();
				const mapped = mapScript(above, SUPERSCRIPTS);
				return mapped !== undefined ? base + mapped : `${base}^{${above}}`;
			}
			case "underset": {
				const below = this.parseArgument();
				const base = this.parseArgument();
				const mapped = mapScript(below, SUBSCRIPTS);
				return mapped !== undefined ? base + mapped : `${base}_{${below}}`;
			}
			default:
				// Unknown command: drop the backslash, keep the name.
				return name;
		}
	}

	/** Render the delimiter following \left or \right ("." means invisible). */
	private parseDelimiter(): string {
		while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
			this.pos++;
		}
		const ch = this.src[this.pos];
		if (ch === undefined) {
			return "";
		}
		if (ch === ".") {
			this.pos++;
			return "";
		}
		if (ch === "\\") {
			return this.parseCommand();
		}
		this.pos++;
		return ch;
	}
}

/**
 * Convert LaTeX math source to Unicode plain text.
 *
 * Newlines in the source are preserved and "\\" becomes a newline, so
 * multi-line display math (aligned environments) renders on multiple lines.
 * Runs of spaces collapse to one — TeX treats source whitespace as
 * insignificant, and spacing commands otherwise leave double gaps.
 */
export function latexToUnicode(tex: string): string {
	return new LatexParser(tex)
		.parse()
		.replace(/[^\S\n]{2,}/g, " ")
		.replace(/\n\s*\n/g, "\n");
}
