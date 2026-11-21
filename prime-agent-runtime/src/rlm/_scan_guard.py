"""Scan-cost guard: a recursive scan over home-scale roots with no time or
depth bound is unbounded in time — output caps (`| head`) never bound how
long a no-match scan walks. bash() cannot know at dispatch how the handle
will be awaited, so it teaches at dispatch with a budgeted stderr hint and
the command still runs (searches are legitimate). With the opt-in
PRIME_AGENT_SCAN_TIMEOUT, an armed scan's group is killed at the user's
bound and the result keeps the partial output plus a timeout status."""

from __future__ import annotations

import math
import os
import re
import sys

_MAX_SCAN_HINTS = 3
_scan_hints_written = 0
SCAN_TIMEOUT_ENV = "PRIME_AGENT_SCAN_TIMEOUT"


def _is_home_scale_root(token: str) -> bool:
    """The home tree itself (`~`, `~/`, `$HOME`, `${HOME}`) or one component
    below it (`~/Documents`, the incident dirs) walks a top-level home
    subtree; deeper `~`-rooted paths (`~/work/repo/src`) are ordinary project
    trees and stay quiet. Exact names keep other env vars ($HOMEDIR,
    ${HOMEBREW_PREFIX}) out. A grouping paren glued to the token
    (`(rg pattern $HOME)`) is stripped first — only `)`: `${HOME}`'s closing
    brace is part of the expansion."""
    token = token.rstrip(")")
    if token in ("~", "~/", "$HOME", "$HOME/", "${HOME}", "${HOME}/"):
        return True
    for root in ("~/", "$HOME/", "${HOME}/"):
        if token.startswith(root):
            rest = token.removeprefix(root).rstrip("/")
            return bool(rest) and "/" not in rest
    return False


def _is_find_depth_bound(tokens: list[str]) -> bool:
    """find's `-maxdepth N` with a numeric argument. The words of an -exec,
    -execdir, -ok, or -okdir action are a command, not find options:
    `find ~ -exec find {} -maxdepth 1 \\;` has no bound. The action ends at
    `{} +` or at `;`, which reaches here masked as exactly two placeholders
    (`\\;`, `';'`, or `";"`; longer quoted words like `'%s\\n'` mask longer).
    A grouping paren glued to N (`(find ~ -maxdepth 2)`) is not part of N."""
    in_action = False
    for i, t in enumerate(tokens):
        if in_action:
            in_action = t != _MASK_PLACEHOLDER * 2 and not (
                t == "+" and tokens[i - 1] == "{}"
            )
        elif t in ("-exec", "-execdir", "-ok", "-okdir"):
            in_action = True
        elif (
            t == "-maxdepth"
            and i + 1 < len(tokens)
            and tokens[i + 1].rstrip(")").isdigit()
        ):
            return True
    return False


# Redirection operators: the token after one is a target file, not a scan
# root, so a project-local scan writing to ~ must not warn.
_REDIRECT_OPERATORS = frozenset(
    {">", ">>", "<", "<>", ">|", ">&", "<&", "&>", "&>>"}
)


def _is_redirect_operator(token: str) -> bool:
    """A redirection operator token, with its optional fd prefix (`2>`)."""
    return token.lstrip("0123456789") in _REDIRECT_OPERATORS


# A redirection with its target in the same token (`2>/dev/null`, `>out`).
_ATTACHED_REDIRECT = re.compile(r"[0-9]*(?:&>>|&>|>>|>\||>&|<&|<>|>|<)\S")


# Options whose operand is the next token, so that operand is neither the
# pattern nor a root. Both tools share the pattern, count, and context
# options. The grep set adds GNU grep's other value options (its -T takes
# none); the rg set is every value option in ripgrep 15's --help, where -r is
# --replace (a value), not grep's recursive flag.
_SHARED_VALUE_OPTIONS = frozenset(
    {
        "-e", "--regexp", "-f", "--file", "-m", "--max-count",
        "-A", "-B", "-C", "--after-context", "--before-context", "--context",
    }
)
_GREP_VALUE_OPTIONS = _SHARED_VALUE_OPTIONS | {
    "-d", "--directories", "-D", "--devices", "--binary-files", "--exclude",
    "--exclude-dir", "--exclude-from", "--group-separator", "--include",
    "--label",
}
_RG_VALUE_OPTIONS = _SHARED_VALUE_OPTIONS | {
    "-d", "--max-depth", "--maxdepth", "-E", "--encoding", "-g", "--glob", "-j",
    "--threads",
    "-M", "--max-columns", "-r", "--replace", "-t", "-T", "--type",
    "--type-not", "--color", "--colors", "--context-separator",
    "--dfa-size-limit", "--engine", "--field-context-separator",
    "--field-match-separator", "--generate", "--hostname-bin",
    "--hyperlink-format", "--iglob", "--ignore-file", "--max-filesize",
    "--path-separator", "--pre", "--pre-glob", "--regex-size-limit", "--sort",
    "--sortr", "--type-add", "--type-clear",
}

# The short letters of those options: a cluster's first value-taking letter
# consumes the rest of its token (`-fFILE`, `-rlefoo`, `-A2`).
_GREP_VALUE_LETTERS = frozenset(
    option[1] for option in _GREP_VALUE_OPTIONS if len(option) == 2
)
_RG_VALUE_LETTERS = frozenset(
    option[1] for option in _RG_VALUE_OPTIONS if len(option) == 2
)


def _short_cluster(token: str, value_letters: frozenset[str]) -> str | None:
    """The option letters of a short cluster, up to and including the first
    letter that takes an operand (`-rlefoo` -> `rle`, `-A2` -> `A`). None for
    a long option, a bare `-`, or a non-option token."""
    if not token.startswith("-") or token.startswith("--") or len(token) < 2:
        return None
    letters: list[str] = []
    for letter in token[1:]:
        letters.append(letter)
        if letter in value_letters:
            break
    return "".join(letters)


# find's global options precede the paths, so they do not start the
# expression; `-O level` / `-D debugopts` take an operand when bare.
_FIND_GLOBAL_OPTIONS = frozenset(
    {"-H", "-L", "-P", "-X", "-d", "-s", "-x", "--"}
)

# Reserved words that can come before a command: the command after them
# still runs (`if find ...`, `then find ...`, `! find ...`).
_COMMAND_PREFIX_WORDS = frozenset(
    {"!", "do", "elif", "else", "if", "then", "time", "until", "while"}
)

# An assignment word before a command (`LC_ALL=C find ...`) only sets the
# command's environment. An array assignment (`files=(find ~)`) is not a
# prefix: its words are array elements, and nothing after it runs.
_ASSIGNMENT_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=(?!\()")


# Masked quoted arguments leave this placeholder token behind: bash saw an
# argument here, and the scanner's positional pattern-skip must skip the
# placeholder, not a scan root that follows it.
_MASK_PLACEHOLDER = "\x01"


def _mask_quoted_char(ch: str) -> str:
    """Masked quoted data stays in one word with its neighbors (a placeholder,
    never whitespace) and keeps `/`: bash joins `~/"work/repo"` into one deep
    path, and the home-scale root test reads the depth from its `/`."""
    return "/" if ch == "/" else _MASK_PLACEHOLDER


# A quoted span that is all digits, one option word, or `--` (`'2'`,
# `"--max-depth"`, `'--'`) is an argument, not data: the tool sees it after
# quote removal, so it stays visible for option and bound detection.
_ARGUMENT_WORD = re.compile(r"[0-9]+|--|--?[A-Za-z0-9][A-Za-z0-9_.=-]*")


def _quoted_argument_end(chars: list[str], start: int, quote: str) -> int | None:
    """The closing quote's index when the quoted text from `start` is one
    argument word; None for any other quoted text."""
    end = start
    while end < len(chars) and chars[end] != quote:
        end += 1
    if end < len(chars) and _ARGUMENT_WORD.fullmatch("".join(chars[start:end])):
        return end
    return None


# Substitution nesting deeper than this is not scanned: a malformed
# deeply-nested command must stay cheap on both stack and time.
_SUBSTITUTION_DEPTH_CAP = 8


def _starts_with_home_expansion(chars: list[str], at: int) -> bool:
    """True when chars[at:] starts with $HOME or ${HOME}; a following
    variable-name character ($HOMEDIR) is a different variable."""
    if at + 1 < len(chars) and chars[at + 1] == "{":
        return "".join(chars[at : at + 7]) == "${HOME}"
    if "".join(chars[at : at + 5]) != "$HOME":
        return False
    nxt = chars[at + 5] if at + 5 < len(chars) else None
    return nxt is None or not (nxt.isascii() and (nxt.isalnum() or nxt == "_"))


# Heredoc bodies masked per command: each one scans forward for its
# terminator line, so a malformed command full of `<<` operators must not
# turn the preflight scan quadratic.
_HEREDOC_MASK_CAP = 8


def _mask_scan_literals(command: str) -> str:
    """One linear scan masking
    single-quoted spans, double-quoted literal data, comments, and heredoc
    bodies so they cannot masquerade as a scan. A double-quoted span that
    starts with a $HOME/${HOME} expansion stays fully live (the path argument
    of a scan); all-digit quoted spans stay visible (a quoted depth bound like
    `--max-depth "3"` is an argument, not data); $(...) and backticks stay live
    (they execute). Heredoc bodies are input text, never executed, so the
    whole body through the delimiter line is masked — except that an unquoted
    delimiter still expands, so $(...) and backticks in its body stay live.
    """
    chars = list(command)
    n = len(chars)
    heredocs_masked = 0
    i = 0
    while i < n:
        ch = chars[i]
        if ch == "'":
            # An argument word (`-maxdepth '2'`, `'--max-depth' 2`) stays
            # visible; other single-quoted text is data.
            end = _quoted_argument_end(chars, i + 1, "'")
            if end is not None:
                chars[i] = chars[end] = ""
                i = end + 1
                continue
            j = i + 1
            while j < n and chars[j] != "'":
                chars[j] = _mask_quoted_char(chars[j])
                j += 1
            chars[i] = _MASK_PLACEHOLDER
            if j < n:
                chars[j] = ""  # the closing quote joins a glued suffix
            i = j + 1
            continue
        if ch == "\\" and i + 1 < n:
            # An escaped character is literal text: `\;` never splits a segment,
            # and a backslash-newline joins its lines. The placeholder keeps an
            # escaped character inside its token.
            if chars[i + 1] == "\n":
                chars[i] = ""
                chars[i + 1] = ""
            else:
                chars[i] = _MASK_PLACEHOLDER
                chars[i + 1] = _MASK_PLACEHOLDER
            i += 2
            continue
        if ch == "$" and i + 2 < n and chars[i + 1] == "(" and chars[i + 2] == "(":
            # Arithmetic expansion `$((...))` is not command text for the
            # guard: skip it whole so a `<<` shift inside it (`$((a<<b))`)
            # cannot read as a heredoc operator.
            depth = 0
            j = i + 1
            while j < n:
                if chars[j] == "(":
                    depth += 1
                elif chars[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            i = (j + 1) if j < n else n
            continue
        if (
            ch == "<"
            and i + 1 < n
            and chars[i + 1] == "<"
            and not (i + 2 < n and chars[i + 2] == "<")
            and (i == 0 or chars[i - 1] != "<")
            and heredocs_masked < _HEREDOC_MASK_CAP
        ):
            heredocs_masked += 1
            # Heredoc `<<[-]DELIM` in all its spellings (`cat<<EOF`,
            # `2<<EOF`, `<< EOF`, `<< 'EOF'`): the body until the delimiter
            # line is input text, never executed, so mask it. A digit-first
            # delimiter is an arithmetic shift (`$((1<<2))`), not a heredoc.
            j = i + 2
            tabbed = False
            if j < n and chars[j] == "-":
                tabbed = True
                j += 1
            while j < n and chars[j] in " \t":
                j += 1
            word_chars: list[str] = []
            backslashed = False
            # The delimiter word stops at shell operators outside quoted
            # text, so `<<EOF; cmd` leaves `; cmd` live on the start line.
            # A backslash quotes the next character (`<<\EOF` is the quoted
            # delimiter `EOF`).
            while j < n:
                c = chars[j]
                if c in ("'", '"'):
                    word_chars.append(c)
                    j += 1
                    while j < n and chars[j] != c:
                        word_chars.append(chars[j])
                        j += 1
                    if j < n:
                        word_chars.append(chars[j])
                        j += 1
                elif c == "\\" and j + 1 < n:
                    backslashed = True
                    word_chars.append(chars[j + 1])
                    j += 2
                elif c.isspace() or c in ";&|()<>":
                    break
                else:
                    word_chars.append(c)
                    j += 1
            word = "".join(word_chars)
            # Shell quote removal across the whole delimiter word: `E'OF'` is
            # `EOF`, and any quoting or escaping anywhere in the word
            # disables expansion.
            quoted = "'" in word or '"' in word or backslashed
            delim = word.replace("'", "").replace('"', "")
            # A present (even empty, `<<''`) delimiter word is a heredoc.
            if word:
                body = j
                while body < n and chars[body] != "\n":
                    body += 1
                if body < n:
                    body += 1  # first char of the body
                    # The terminator line ends the heredoc even mid-
                    # substitution; find it on the raw text. With an
                    # unquoted delimiter, bash first joins a line that ends
                    # in an unescaped backslash with the next line.
                    probe = body
                    region_end = term_eol = n
                    while True:
                        eol = probe
                        while eol < n and chars[eol] != "\n":
                            eol += 1
                        parts = ["".join(chars[probe:eol])]
                        while (
                            not quoted
                            and eol < n
                            and (len(parts[-1]) - len(parts[-1].rstrip("\\"))) % 2 == 1
                        ):
                            parts[-1] = parts[-1][:-1]
                            joined_eol = eol + 1
                            while joined_eol < n and chars[joined_eol] != "\n":
                                joined_eol += 1
                            parts.append("".join(chars[eol + 1 : joined_eol]))
                            eol = joined_eol
                        line = "".join(parts)
                        if (line.lstrip("\t") if tabbed else line) == delim:
                            region_end = probe
                            term_eol = eol
                            break  # terminator line: body ends here
                        if eol >= n:
                            break  # no terminator: bash reads to EOF
                        probe = eol + 1
                    # Mask the whole body region in one pass: with an
                    # unquoted delimiter, $(...) and backticks stay live
                    # (bash runs them in the body, and a substitution may
                    # span lines); an escaped \$, \`, or \\ is literal;
                    # everything else is data. The terminator line is data.
                    if quoted:
                        for k in range(body, term_eol):
                            chars[k] = " "
                    else:
                        k = body
                        sub_depth = 0
                        sub_quote = None
                        while k < region_end:
                            c = chars[k]
                            if sub_depth > 0:
                                # Inside a live command substitution; the
                                # paren depth carries across body lines, and
                                # quoted parens do not count toward it.
                                if sub_quote is not None:
                                    if c == sub_quote:
                                        sub_quote = None
                                elif c in ("'", '"'):
                                    sub_quote = c
                                elif c == "(":
                                    sub_depth += 1
                                elif c == ")":
                                    sub_depth -= 1
                                k += 1
                            elif (
                                c == "\\"
                                and k + 1 < region_end
                                and chars[k + 1] in ("$", "`", "\\")
                            ):
                                # An escaped \$, \`, or \\ is literal.
                                chars[k] = " "
                                chars[k + 1] = " "
                                k += 2
                            elif c == "$" and k + 1 < region_end and chars[k + 1] == "(":
                                sub_depth = 1
                                k += 2
                            elif c == "`":
                                k += 1
                                while k < region_end and chars[k] != "`":
                                    k += 1
                                k += 1
                            else:
                                chars[k] = " "
                                k += 1
                        for k in range(region_end, term_eol):
                            chars[k] = " "
            i += 2
            continue
        if ch == '"':
            # An argument word (`--max-depth "3"`, `"--max-depth" 3`) stays
            # visible, like its single-quoted form.
            end = _quoted_argument_end(chars, i + 1, '"')
            if end is not None:
                chars[i] = chars[end] = ""
                i = end + 1
                continue
            # A span that starts with a home expansion is a path argument:
            # keep the whole span live so the expansion is never split into
            # its own token (the positional pattern-skip in the segment
            # scanner keeps quoted patterns from counting as roots).
            if _starts_with_home_expansion(chars, i + 1):
                # One pass finds the closing quote and masks the span's own
                # separators, so both steps use the same quoting rules: quoted
                # separators are data, but a $(...)/backtick inside the span
                # still executes and its body must stay intact for the
                # substitution scan.
                j = i + 1
                sub_depth = 0
                sub_quote = None
                sub_backtick = False
                while j < n:
                    c = chars[j]
                    in_sub = sub_depth > 0 or sub_backtick
                    # A backslash quotes the next character, except in
                    # single quotes, where it is literal. In the span itself
                    # it quotes only $ ` " \ as in bash: another escaped
                    # character, such as a separator, stays span data.
                    if (
                        c == "\\"
                        and j + 1 < n
                        and sub_quote != "'"
                        and (in_sub or chars[j + 1] in '$`"\\')
                    ):
                        j += 2
                        continue
                    if in_sub:
                        # A substitution carries its own quoting: a `"` inside
                        # it never closes the outer span.
                        if sub_quote is not None:
                            if c == sub_quote:
                                sub_quote = None
                        elif sub_backtick:
                            if c == "`":
                                sub_backtick = False
                        elif c in ("'", '"'):
                            sub_quote = c
                        elif c == "(":
                            sub_depth += 1
                        elif c == ")":
                            sub_depth -= 1
                        elif c == "`":
                            sub_backtick = True
                        j += 1
                        continue
                    if c == '"':
                        break
                    if c == "$" and j + 1 < n and chars[j + 1] == "(":
                        sub_depth = 1
                        j += 2
                        continue
                    if c == "`":
                        sub_backtick = True
                        j += 1
                        continue
                    # Quoted separators and spaces are data: replace them
                    # with the non-whitespace placeholder so the span
                    # stays ONE token. `|;&` are the segment-splitting
                    # separators: left live, they split the parent command
                    # and hide the scan root.
                    if c.isspace() or c in "|;&":
                        chars[j] = _MASK_PLACEHOLDER
                    j += 1
                close = j
                # Remove the quotes as the shell does, so a glued suffix
                # (`"$HOME"/work/repo`) stays part of the same token.
                chars[i] = ""
                if close < n:
                    chars[close] = ""
                i = close + 1
                continue
            chars[i] = _MASK_PLACEHOLDER
            i += 1
            while i < n and chars[i] != '"':
                if chars[i] == "\\" and i + 1 < n:
                    # Escapes inside double quotes are literal data, including
                    # an escaped \$HOME.
                    chars[i] = _MASK_PLACEHOLDER
                    chars[i + 1] = _mask_quoted_char(chars[i + 1])
                    i += 2
                elif chars[i] == "$" and i + 1 < n and chars[i + 1] == "(":
                    depth = 0
                    quote = None
                    j = i
                    while j < n:
                        qc = chars[j]
                        if quote is not None:
                            # Quoted parens do not count toward the depth.
                            if qc == quote:
                                quote = None
                        elif qc in ("'", '"'):
                            quote = qc
                        elif qc == "(":
                            depth += 1
                        elif qc == ")":
                            depth -= 1
                            if depth == 0:
                                break
                        j += 1
                    i = (j + 1) if j < n else n
                elif chars[i] == "`":
                    i += 1
                    while i < n and chars[i] != "`":
                        i += 1
                    i += 1
                else:
                    chars[i] = _mask_quoted_char(chars[i])
                    i += 1
            if i < n:
                chars[i] = ""  # the closing quote joins a glued suffix
            i += 1
            continue
        if ch == "#" and (
            i == 0
            or chars[i - 1].isspace()
            or chars[i - 1] in ";&|()<>"
        ):
            while i < n and chars[i] != "\n":
                chars[i] = " "
                i += 1
            continue
        i += 1
    return "".join(chars)


def _segments_contain_unbounded_scan(masked: str) -> bool:
    """True when any segment of the masked command is an unbounded scan."""
    # A standalone `&` backgrounds the left side and starts a new command,
    # so `sleep 1 & find "$HOME"` segments like its `&&` form. The
    # lookarounds keep redirection spellings (`2>&1`, `<&`, `&>`, `&>>`)
    # inside the segment: their `&` is not a separator.
    for segment in re.split(r"&&|\|\||;|\||\n|(?<![<>])&(?!>)", masked):
        tokens = segment.split()
        # Leading grouping operators, reserved words, assignment words, and
        # redirections: `(find ...)`, `{ ...; }`, `then find ...`,
        # `! find ...`, `time -p find ...`, `LC_ALL=C find ...`, and
        # `2>/dev/null find ...` run the same command, so the shape must
        # survive them. Walk by index and strip all prefixes at once: popping
        # the head or copying one character per round is quadratic in the
        # number of prefixes.
        command_start = 0
        previous = ""
        while command_start < len(tokens):
            stripped = tokens[command_start].lstrip("({")
            if _is_redirect_operator(stripped):
                command_start += 2  # the operator and its target
                previous = ""
                continue
            # bash's `time` takes `-p`, then `--`, before its pipeline.
            time_option = (previous == "time" and stripped in ("-p", "--")) or (
                previous == "-p" and stripped == "--"
            )
            if (
                stripped
                and stripped not in _COMMAND_PREFIX_WORDS
                and not _ASSIGNMENT_WORD.match(stripped)
                and not _ATTACHED_REDIRECT.match(stripped)
                and not time_option
            ):
                tokens[command_start] = stripped
                break
            previous = stripped
            command_start += 1
        tokens = tokens[command_start:]
        if not tokens or tokens[0] == "timeout":
            continue
        rest = tokens[1:]
        if tokens[0] == "find":
            if _is_find_depth_bound(rest):
                continue
            # find's syntax is `find [path...] [expression]`: a `-`-led
            # token starts the expression, and everything after it (-exec
            # bodies, -newer operands, ...) is operands, not scan roots —
            # so `find . -exec cp {} ~/backup/ \;` stays quiet. BSD's
            # `-f path` names the hierarchy itself. A redirection's target
            # is a file to write, never a scan root.
            root_tokens = []
            expression = False
            i = 0
            while i < len(rest):
                t = rest[i]
                if _is_redirect_operator(t):
                    i += 2  # the operator and its target
                    continue
                if expression:
                    i += 1
                    continue
                if t in _FIND_GLOBAL_OPTIONS or t.startswith(("-O", "-D")):
                    # Global options never start the expression; a bare
                    # `-O`/`-D` consumes its operand token.
                    i += 2 if t in ("-O", "-D") else 1
                    continue
                if t == "-f":
                    if i + 1 < len(rest):
                        root_tokens.append(rest[i + 1])
                    i += 2
                    continue
                if t.startswith("-"):
                    expression = True
                else:
                    root_tokens.append(t)
                i += 1
            if not any(_is_home_scale_root(t) for t in root_tokens):
                continue
            return True
        if tokens[0] not in ("grep", "egrep", "fgrep", "rg"):
            continue
        is_rg = tokens[0] == "rg"
        value_options = _RG_VALUE_OPTIONS if is_rg else _GREP_VALUE_OPTIONS
        value_letters = _RG_VALUE_LETTERS if is_rg else _GREP_VALUE_LETTERS
        # One walk makes every option decision. Options end at `--`, and an
        # option's operand is not an option: `grep -e -r ~/x` is not
        # recursive, and `rg -g --files` globs for `--files`. rg always
        # recurses; the grep family needs -r, -R, --recursive,
        # --dereference-recursive, or -d/--directories recurse. Only rg has
        # a depth bound (--max-depth, --maxdepth, or -d with a number; a
        # glued grouping paren is not part of the number).
        recursive = is_rg
        depth_bound = pattern_from_option = files_mode = False
        positionals: list[str] = []
        skip_next = False
        seen_ddash = False
        for i, t in enumerate(rest):
            if skip_next:
                skip_next = False  # an option's operand or a redirection target
                continue
            if _is_redirect_operator(t):
                skip_next = True  # its target is a file to write, not a root
                continue
            if not seen_ddash and t == "--":
                seen_ddash = True
                continue
            if seen_ddash or t == "-" or not t.startswith("-"):
                positionals.append(t)
                continue
            following = rest[i + 1] if i + 1 < len(rest) else ""
            if t.startswith("--"):
                name, eq, value = t.partition("=")
                recursive = recursive or name in ("--recursive", "--dereference-recursive")
                if not is_rg and name == "--directories":
                    recursive = recursive or (value if eq else following) == "recurse"
                pattern_from_option = pattern_from_option or name in ("--regexp", "--file")
                files_mode = files_mode or (is_rg and t == "--files")
                if is_rg and name in ("--max-depth", "--maxdepth"):
                    operand = value if eq else following
                    depth_bound = depth_bound or operand.rstrip(")").isdigit()
                skip_next = t in value_options
                continue
            # A short cluster's letters are flags up to its first value
            # letter, which takes the rest of the token or, when nothing is
            # attached, the next token (`-rlefoo`, `-rle foo`, `-id2`).
            cluster = _short_cluster(t, value_letters)
            value_letter = cluster[-1] if cluster[-1] in value_letters else ""
            flags = cluster[:-1] if value_letter else cluster
            recursive = recursive or "r" in flags.lower()
            if value_letter:
                attached = t[len(cluster) + 1 :]
                operand = attached or following
                pattern_from_option = pattern_from_option or value_letter in ("e", "f")
                if is_rg and value_letter == "d":
                    depth_bound = depth_bound or operand.rstrip(")").isdigit()
                elif value_letter == "d":
                    recursive = recursive or operand == "recurse"
                skip_next = not attached
        if not recursive or depth_bound:
            continue
        # The first positional is the pattern — pattern text, not a scan
        # root, so a quoted pattern containing $HOME never counts (a masked
        # pattern leaves a placeholder in its place). With a pattern option
        # (-e/--regexp/-f/--file) or rg's --files listing, which takes no
        # pattern, every positional is a root.
        roots = positionals if pattern_from_option or files_mode else positionals[1:]
        if not any(_is_home_scale_root(t) for t in roots):
            continue
        return True
    return False


def _extract_substitutions(masked: str) -> tuple[str, list[str]]:
    """Replace every $(...) or process-substitution <(...)/>(...) span
    (paren-depth matched, quote-aware) and backtick span with placeholders,
    returning the parent text plus the bodies themselves: the bodies execute,
    so they are command text — but they are scanned separately, so a quoted
    separator inside one must never split the parent command. The
    placeholders are not whitespace, so a span stays in its word:
    `"$HOME/$(x)/repo"` is one deep path, not the root `$HOME/`."""

    def _is_escaped(at: int) -> bool:
        # A backslash-escaped `\$(` or backtick is literal data, not a
        # substitution opener.
        run = 0
        k = at - 1
        while k >= 0 and masked[k] == "\\":
            run += 1
            k -= 1
        return run % 2 == 1

    chars = list(masked)
    n = len(chars)
    bodies: list[str] = []
    i = 0
    while i < len(masked):
        if chars[i] == "$" and chars[i + 1 : i + 3] == ["(", "("]:
            # Arithmetic expansion `$((...))` is not command text: step past
            # its opener, so only a $(...) nested in it is extracted.
            i += 3
            continue
        if (
            chars[i] in ("$", "<", ">")
            and i + 1 < n
            and chars[i + 1] == "("
            and not _is_escaped(i)
        ):
            depth = 0
            quote = None
            j = i + 1
            while j < n:
                c = chars[j]
                if quote is not None:
                    # Quoted parens do not count toward the depth; the
                    # substitution still closes at its real `)`.
                    if c == quote:
                        quote = None
                elif c in ("'", '"'):
                    quote = c
                elif c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            if j < n:
                body = "".join(chars[i + 2 : j])
                if body.strip():
                    bodies.append(body)
                for k in range(i, j + 1):
                    chars[k] = _MASK_PLACEHOLDER
                i = j
            else:
                # An unmatched `$(` has no closing paren ahead: the suffix is
                # its unclosed body, so stop scanning there instead of
                # rescanning it for every later `$(` (quadratic).
                break
        elif chars[i] == "`" and not _is_escaped(i):
            j = i + 1
            while j < n and chars[j] != "`":
                j += 1
            if j < n:
                body = "".join(chars[i + 1 : j])
                if body.strip():
                    bodies.append(body)
                for k in range(i, j + 1):
                    chars[k] = _MASK_PLACEHOLDER
                i = j
        i += 1
    return "".join(chars), bodies


def _is_unbounded_home_scan(command: str) -> bool:
    """True for the unbounded-scan shape.

    Recursive scan (grep -r, rg, find — recursive by default) over a ~/$HOME
    root, with no `timeout` prefix and no --max-depth/-maxdepth bound.
    Quoted literal data, heredoc bodies, and comments are masked first so
    they cannot masquerade as a scan; command- and process-substitution
    bodies run in a subshell, so they are scanned as commands too.
    """
    # Iterative worklist with a depth cap: recursion would hit Python's
    # limit (or the agent's stack) on deeply nested malformed input before
    # the executor ever starts, and an uncapped walk would spend quadratic
    # time on it.
    worklist = [(command, 0)]
    while worklist:
        text, depth = worklist.pop()
        masked = _mask_scan_literals(text)
        parent, bodies = _extract_substitutions(masked)
        if _segments_contain_unbounded_scan(parent):
            return True
        if depth + 1 < _SUBSTITUTION_DEPTH_CAP:
            worklist.extend((b, depth + 1) for b in bodies)
    return False


def note_scan_cost(command: str, scan_timeout: float | None = None) -> None:
    """Write the scan-cost hint to the dispatching cell's stderr, within budget."""
    global _scan_hints_written
    if _scan_hints_written >= _MAX_SCAN_HINTS or not _is_unbounded_home_scan(command):
        return
    _scan_hints_written += 1
    hint = (
        "bash: this recursive scan of home-scale directories is unbounded "
        "in time; output caps (| head) do not bound scan time. Bound it "
        "with --max-depth / -maxdepth or a narrower directory (not the "
        "shell `timeout` prefix, which stock macOS lacks while "
        "`2>/dev/null` masks its failure), or background it "
        "(`h = bash(...)`) and end the turn."
    )
    if scan_timeout is not None:
        hint += (
            f" A {SCAN_TIMEOUT_ENV} scan timeout of {scan_timeout:g}s "
            "applies to this command."
        )
    sys.stderr.write(hint + "\n")


def scan_timeout_from_env(command: str) -> float | None:
    """The opted-in auto-timeout for `command` when set and it is an unbounded
    home scan; the value must be finite and positive."""
    raw = os.environ.get(SCAN_TIMEOUT_ENV)
    if raw is None:
        return None
    try:
        secs = float(raw)
    except ValueError:
        return None
    return (
        secs
        if math.isfinite(secs) and secs > 0.0 and _is_unbounded_home_scan(command)
        else None
    )
