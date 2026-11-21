from __future__ import annotations

import io
import unittest
from unittest import mock

from rlm import _scan_guard


class ScanGuardTest(unittest.TestCase):
    """The unbounded home-scan classifier and the scan-cost hint."""

    INCIDENT = (
        "grep -rli -e 'training metrics' -e 'advanced dashboard' "
        "~/Documents ~/Desktop ~/Claude ~/environments ~/outputs ~/Downloads "
        "2>/dev/null | grep -viE '\\.(pdf|jsonl|log|txt)$' | head -10; echo done"
    )

    def test_scan_shape(self):
        is_scan = _scan_guard._is_unbounded_home_scan
        # The incident command warns; `| head` is an output cap, not a bound.
        self.assertTrue(is_scan(self.INCIDENT))
        self.assertTrue(is_scan("grep -rl needle ~/Documents | head -10"))
        self.assertTrue(is_scan("rg pattern ~/Documents"))
        self.assertTrue(is_scan("find ~/Downloads -name '*.pdf'"))
        # Time and depth bounds, and project-local scans, do not.
        self.assertFalse(is_scan("timeout 60 grep -rl needle ~/Documents"))
        self.assertFalse(is_scan("rg --max-depth 3 pattern ~/Downloads"))
        self.assertFalse(is_scan("find ~/Documents -maxdepth 2 -name '*.pdf'"))
        self.assertFalse(is_scan("grep -rli pattern ."))
        self.assertFalse(is_scan("grep -rl pattern src/ crates/"))
        self.assertFalse(is_scan("rg pattern ."))
        # Quoted data cannot masquerade as a scan.
        self.assertFalse(is_scan("echo 'grep -r pattern ~/Documents'"))
        self.assertFalse(is_scan("echo 'example | grep -r needle ~/Documents'"))
        self.assertFalse(is_scan("rg -d 2 pattern ~/Downloads"))
        self.assertFalse(is_scan("rg --max-depth=3 pattern ~/Downloads"))
        self.assertFalse(is_scan('rg --max-depth="3" needle "$HOME"'))
        self.assertFalse(is_scan("rg --max-depth='3' needle ~"))
        self.assertFalse(is_scan("find ~/Documents -maxdepth 2 -name '*.pdf'"))
        self.assertFalse(is_scan("grep -rl needle src # ~/Documents"))
        self.assertFalse(is_scan("grep -rl needle $HOMEDIR"))
        self.assertFalse(is_scan("grep -rl needle ${HOMEBREW_PREFIX}/docs"))
        self.assertTrue(is_scan('grep -rl needle "$HOME/Documents"'))
        self.assertTrue(is_scan("grep -rl needle $HOME/Documents"))
        self.assertTrue(is_scan("find ~/Documents -name maxdepth.txt"))
        # Double-quoted literal data is data; only expansions stay live.
        self.assertTrue(is_scan('grep -rl needle "foo|bar" ~/Documents'))
        self.assertFalse(is_scan('echo "grep -rl needle ~/Documents"'))
        self.assertFalse(is_scan('grep -rl needle "~/Documents"'))
        self.assertTrue(is_scan('grep -rl needle "$HOME"'))
        self.assertFalse(is_scan('grep -rl needle "$HOMEDIR"'))
        self.assertTrue(is_scan('grep -rl needle "#" ~/Documents'))
        # Heredoc bodies are input text; substitution bodies run in a subshell.
        self.assertFalse(
            is_scan("cat >example.sh <<'EOF'\ngrep -rl needle ~/Documents\nEOF")
        )
        self.assertFalse(is_scan("cat <<EOF\ngrep -rl needle ~/Documents\nEOF\necho done"))
        self.assertTrue(is_scan('echo "$(grep -rl needle ~/Documents)"'))
        self.assertTrue(is_scan("files=$(grep -rl needle ~/Documents); echo $files"))
        self.assertTrue(is_scan('echo "before $(grep -rl needle ~/Documents) after"'))
        self.assertFalse(is_scan('rg --max-depth "3" needle ~/Documents'))
        self.assertFalse(is_scan("find ~/Documents -maxdepth '2'"))
        self.assertFalse(is_scan("echo $((1<<2))"))
        # Quoted patterns are pattern text; heredoc delimiters in all their
        # spellings; unquoted heredoc bodies still substitute.
        self.assertFalse(is_scan('grep -rl "$HOME/needle" src/'))
        self.assertFalse(is_scan('grep -rl "docs$HOME" src/'))
        self.assertTrue(is_scan('grep -rl needle "$HOME"'))
        self.assertTrue(is_scan('grep -rl needle "$HOME/Documents"'))
        for start in ("cat << EOF", "cat<<EOF", "cat 2<<EOF", "cat << 'EOF'", 'cat <<"EOF"'):
            self.assertFalse(is_scan(f"{start}\ngrep -rl needle ~/Documents\nEOF"), start)
        self.assertTrue(is_scan("cat <<EOF\n$(grep -rl needle ~/Documents)\nEOF"))
        self.assertFalse(is_scan("cat <<'EOF'\n$(grep -rl needle ~/Documents)\nEOF"))
        self.assertTrue(is_scan("files=$(grep -rl 'needle' ~/Documents)"))
        self.assertTrue(is_scan('echo "$(echo $(grep -rl needle ~/Documents))"'))
        self.assertFalse(is_scan('grep -rl "\\$HOME" src/'))
        self.assertTrue(is_scan('echo "use <<EOF in scripts"; grep -rl needle ~/Documents'))
        self.assertTrue(is_scan("echo 'cat <<EOF'; grep -rl needle ~/Documents"))
        self.assertTrue(is_scan("# cat <<EOF\ngrep -rl needle ~/Documents"))
        # Partially quoted delimiters and named arithmetic shifts.
        self.assertFalse(is_scan("cat <<E'OF'\ngrep -rl needle ~/Documents\nEOF"))
        self.assertTrue(is_scan("cat <<E'OF'\nbody\nEOF\nfind \"$HOME\" -name '*.pdf'"))
        self.assertFalse(is_scan("echo $((a<<b))"))
        self.assertTrue(is_scan("echo $((a<<b))\ngrep -rl needle ~/Documents"))
        self.assertFalse(is_scan("cat <<E'OF'\n$(grep -rl needle ~/Documents)\nEOF"))
        # Escaped and multiline heredoc substitutions.
        self.assertFalse(
            is_scan("cat <<EOF\n\\$(grep -rl needle ~/Documents)\nEOF\nsleep 120")
        )
        self.assertTrue(is_scan("cat <<EOF\n$(\nfind ~/Documents\n)\nEOF"))
        self.assertTrue(is_scan("cat <<EOF\n$(echo hi) $(grep -rl needle ~/Documents)\nEOF"))
        self.assertTrue(is_scan("cat <<EOF; find \"$HOME\" -name '*.pdf'\nbody\nEOF"))
        self.assertTrue(is_scan("cat <<EOF; echo\nbody\nEOF\nfind \"$HOME\" -name '*.pdf'"))
        # Digit-led delimiters, here-strings, unclosed heredocs, and quoted
        # patterns ahead of two roots.
        self.assertFalse(is_scan("cat <<123\ngrep -rl needle ~/Documents\n123"))
        self.assertTrue(is_scan("cat <<<hello\nfind ~/Documents -name '*.pdf'"))
        self.assertTrue(is_scan("cat <<EOF\n$(grep -rl needle ~/Documents)"))
        self.assertTrue(is_scan("grep -rl 'needle' ~/Documents src/"))
        self.assertTrue(is_scan('grep -rl "needle" ~/Documents src/'))
        self.assertFalse(is_scan("cat <<\\EOF\ngrep -rl needle ~/Documents\nEOF"))
        self.assertFalse(is_scan("cat <<\\EOF\n$(grep -rl needle ~/Documents)\nEOF"))
        # Per-tool bounds, pattern options, quote-aware matching, capped
        # nesting.
        self.assertTrue(is_scan("grep -rl -e -d2 ~/Documents"))
        self.assertTrue(is_scan("grep -rl --regexp=needle ~/Documents src/"))
        self.assertFalse(is_scan('grep -rl "$HOME"'))
        self.assertTrue(is_scan("echo \"$(echo '(')\" $(grep -rl needle ~/Documents)"))
        self.assertFalse(is_scan("$((" * 25000 + "))" * 25000))
        # Heredoc-count bound, escaped backticks, operator-adjacent comments,
        # rg --files, and pattern-option operands.
        many = "cat " + "<<A " * 20000
        self.assertFalse(is_scan(many))
        self.assertFalse(is_scan("printf '%s\\n' \\`grep -rl needle ~/Documents\\`; sleep 120"))
        self.assertFalse(is_scan("echo ok;# example | grep -rl needle ~/Documents"))
        self.assertTrue(is_scan("rg --files ~/Documents"))
        self.assertFalse(is_scan('grep -rl -e "$HOME/needle" src/'))
        # Quoted separators inside home-prefixed spans; `--`.
        self.assertFalse(
            is_scan("printf '%s\\n' \"$HOME/example;grep -rl needle ~/Documents\"; sleep 120")
        )
        self.assertTrue(is_scan("grep -rl -- -needle ~/Documents"))
        self.assertFalse(is_scan('grep -rl -- "$HOME" src/'))
        # BSD find -f, empty quoted delimiters, nested subs in home spans.
        self.assertTrue(is_scan("find -f ~/Documents"))
        self.assertFalse(is_scan("cat <<''\ngrep -rl needle ~/Documents\n\n"))
        self.assertTrue(is_scan('"$HOME/x; $(echo a; grep -rl needle ~/Documents)"'))
        # Substitution bodies are masked in the parent.
        self.assertFalse(is_scan("echo \"$(printf '%s' 'x; find ~/Documents')\"; sleep 120"))
        self.assertTrue(is_scan("echo \"$(grep -rl 'needle' ~/Documents)\""))
        # A quoted multi-home pattern stays one token.
        self.assertFalse(is_scan('grep -rl "$HOME/a|$HOME/b" src/'))
        self.assertTrue(is_scan('grep -rl needle "$HOME/docs with spaces"'))
        # A redirection target or a find expression operand is not a scan
        # root; real home roots still warn.
        self.assertFalse(is_scan("grep -rl needle . > ~/out.txt"))
        self.assertFalse(is_scan("grep -rl needle src/ 2>> ~/err.log"))
        self.assertFalse(is_scan("rg pattern . >> ~/results.txt"))
        self.assertFalse(is_scan("cat < ~/in.txt | grep -rl needle . > ~/out.txt"))
        self.assertFalse(is_scan("find . -name '*.log' -exec cp {} ~/backup/ \\;"))
        self.assertFalse(is_scan("find . -newer ~/stamp"))
        self.assertTrue(is_scan("grep -rl needle ~/Documents > ~/out.txt"))
        self.assertTrue(is_scan("grep -rl needle ~/Documents 2> ~/err.log"))
        self.assertTrue(is_scan("find ~/Documents -name '*.pdf' > ~/out.txt"))
        self.assertTrue(is_scan("find -f ~/Documents"))
        # find's global options precede the paths, so a home root behind
        # -L/-H/-P/--/-O is still a scan root.
        self.assertTrue(is_scan("find -L ~/Documents -name '*.pdf'"))
        self.assertTrue(is_scan("find -H ~/Documents"))
        self.assertTrue(is_scan("find -P ~/Documents"))
        self.assertTrue(is_scan("find -- ~/Documents"))
        self.assertTrue(is_scan("find -X ~/Documents"))
        self.assertTrue(is_scan("find -O3 ~/Documents"))
        self.assertTrue(is_scan("find -O 3 ~/Documents"))
        self.assertFalse(is_scan("find -L . -newer ~/stamp"))
        self.assertFalse(is_scan("find -L . -name '*.log' -exec cp {} ~/backup/ \\;"))
        # Grouping operators do not hide the command: a grouped scan warns
        # like its ungrouped form.
        self.assertTrue(is_scan("(find ~/Documents) | head -10"))
        self.assertTrue(is_scan("{ find ~/Documents; }"))
        self.assertTrue(is_scan("((find ~/Documents))"))
        self.assertTrue(is_scan("(grep -rl needle ~/Documents)"))
        self.assertFalse(is_scan("(timeout 60 find ~/Documents)"))
        self.assertTrue(is_scan("{ rg pattern ~/Documents; }"))
        self.assertFalse(is_scan("(grep -rl needle .)"))
        self.assertFalse(is_scan("{ find . -name '*.log'; }"))
        # A grouping closer glued to an exact $HOME root does not hide it,
        # and many grouped prefixes stay linear in the preflight.
        self.assertTrue(is_scan("(rg pattern $HOME)"))
        # `${HOME}`'s closing brace is part of the expansion: the paren
        # strip must not eat it.
        self.assertTrue(is_scan('grep -rl needle "${HOME}"'))
        self.assertTrue(is_scan('grep -rl needle "${HOME}/"'))
        self.assertTrue(is_scan('(rg pattern "${HOME}")'))
        self.assertTrue(is_scan("((rg pattern $HOME))"))
        self.assertTrue(is_scan("(grep -rl needle $HOME)"))
        self.assertTrue(is_scan("(find $HOME)"))
        self.assertFalse(is_scan("(" * 100000))
        self.assertFalse(is_scan("( " * 100000 + "true"))
        self.assertTrue(is_scan("( " * 100000 + "find ~/Documents"))

    def test_nested_substitutions_escaped_separators_and_attached_options(self):
        # A substitution keeps its own quoting: a `"` inside $(...) never
        # closes the outer span, so its quoted `; find ~` stays data.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(
            is_scan('echo "$HOME/$(printf "%s" "x; find ~ ")"; sleep 120')
        )
        self.assertFalse(
            is_scan('echo "$HOME/$(printf "%s" "x; grep -rl needle ~ ")"; sleep 1')
        )
        # An escaped separator is literal text, not a command boundary, and a
        # backslash-newline joins its lines before the segment split.
        self.assertFalse(is_scan("printf '%s\\n' \\;find \"$HOME\"; sleep 120"))
        self.assertFalse(is_scan("printf '%s\\n' \\;find ~/Documents; sleep 120"))
        self.assertFalse(is_scan("find ~ \\\n-maxdepth 2 -name '*.pdf'"))
        # An attached or bundled short option carries its operand, so the
        # home root stays a root instead of reading as the positional pattern.
        self.assertTrue(is_scan('rg -fpatterns.txt "$HOME"'))
        self.assertTrue(is_scan('rg -ePATTERN "$HOME"'))
        self.assertTrue(is_scan('grep -rfpatterns.txt "$HOME"'))
        self.assertTrue(is_scan('grep -rlefoo "$HOME"'))
        # A bare value-taking cluster takes the next token as its operand.
        self.assertTrue(is_scan("grep -rle -error ~/Documents"))

    def test_home_scale_root_is_home_or_one_component_below(self):
        # Only the home tree itself or one component below it is home-scale;
        # deeper ~-rooted project paths stay quiet.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan("grep -rn foo ~/work/repo/src"))
        self.assertFalse(is_scan("rg pat ~/.config/app/x.toml"))
        self.assertFalse(is_scan("grep -rn foo $HOME/work/repo/src"))
        self.assertFalse(is_scan("grep -rn foo ${HOME}/work/repo/src"))
        self.assertFalse(is_scan("find ~/proj/src -name '*.py'"))
        self.assertTrue(is_scan("grep -rl needle ~"))
        self.assertTrue(is_scan("grep -rl needle ~/"))
        self.assertTrue(is_scan("grep -rl needle $HOME"))
        self.assertTrue(is_scan("grep -rl needle $HOME/"))
        self.assertTrue(is_scan("grep -rl needle ${HOME}/Documents"))
        self.assertTrue(is_scan("grep -rn foo ~/Documents/"))
        self.assertTrue(is_scan("find ~/proj -name '*.py'"))

    def test_pattern_option_operands_do_not_classify_as_recursive(self):
        # A pattern option's operand is pattern text, not an option token:
        # it must not count as the `-r` flag, and a real flag still does.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan("grep -e -error ~/Documents"))
        self.assertFalse(is_scan("grep -e -r ~/Documents"))
        self.assertFalse(is_scan("grep --regexp -r ~/Documents"))
        self.assertFalse(is_scan("grep -f -rfile ~/Documents"))
        self.assertFalse(is_scan("grep -e -error -e foo ~/Documents"))
        self.assertTrue(is_scan("grep -rl -e -error ~/Documents"))
        self.assertTrue(is_scan("grep -R -e -error ~/Documents"))

    def test_max_count_operand_does_not_displace_the_pattern(self):
        # A count bound takes a numeric operand before the pattern: the
        # operand is consumed, so the quoted "$HOME" stays pattern text and
        # src/ is the only root — no spurious home-scan warning.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan('grep -rl -m 1 "$HOME" src/'))
        self.assertFalse(is_scan('grep -rl --max-count 1 "$HOME" src/'))
        self.assertFalse(is_scan('rg -m 1 "$HOME" src/'))
        # Self-contained spellings never displaced the pattern.
        self.assertFalse(is_scan('grep -rl -m1 "$HOME" src/'))
        self.assertFalse(is_scan('grep -rl --max-count=1 "$HOME" src/'))
        # The bound never hides a real home root nor ends option parsing.
        self.assertTrue(is_scan('grep -rl -m 1 needle "$HOME"'))
        self.assertTrue(is_scan('grep -rl -m 1 needle "$HOME/Documents"'))
        self.assertFalse(is_scan('grep -rl -m 1 -- "$HOME" src/'))

    def test_glob_operand_does_not_displace_the_pattern(self):
        # A glob filter takes its operand before the pattern: the operand is
        # consumed, so the quoted "$HOME/needle" stays pattern text and src/
        # is the only root — no spurious home-scan warning.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan("rg -g '*.rs' \"$HOME/needle\" src/"))
        self.assertFalse(is_scan("rg --glob '*.rs' \"$HOME/needle\" src/"))
        # Self-contained spellings never displaced the pattern.
        self.assertFalse(is_scan("rg -g'*.rs' \"$HOME/needle\" src/"))
        self.assertFalse(is_scan("rg --glob='*.rs' \"$HOME/needle\" src/"))
        # The glob never hides a real home root nor ends option parsing.
        self.assertTrue(is_scan("rg -g '*.rs' needle $HOME"))
        self.assertTrue(is_scan("rg -g '*.rs' needle \"$HOME/Documents\""))
        self.assertFalse(is_scan("rg -g '*.rs' -- \"$HOME/needle\" src/"))
        # Type, context, and iglob options take an operand the same way;
        # type options only in rg (grep's -T takes none).
        self.assertFalse(is_scan('rg -t py "$HOME" src/'))
        self.assertFalse(is_scan('rg -A 2 "$HOME/x" src/'))
        self.assertFalse(is_scan('rg --iglob "*.py" "$HOME/x" src/'))
        self.assertFalse(is_scan('grep -r -C 3 "$HOME/x" src/'))
        self.assertTrue(is_scan("grep -r -T needle ~/Documents"))

    def test_home_span_separators_do_not_split_scan_roots(self):
        # A quoted separator inside a home-prefixed span is data, so a real
        # scan keeps its root and warns instead of being split into
        # root-less segments.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan('rg "$HOME/a|$HOME/b" ~/Documents'))
        self.assertTrue(is_scan('rg "$HOME/a;$HOME/b" ~/Documents'))
        self.assertTrue(is_scan('rg "$HOME/a&&$HOME/b" ~/Documents'))
        # A quoted expansion glued to a suffix stays one path token.
        self.assertFalse(is_scan('find "$HOME"/work/repo/src -name x'))
        self.assertFalse(is_scan('rg foo "${HOME}"/work/repo/src'))
        self.assertFalse(is_scan('grep -r foo "$HOME"/work/repo'))
        self.assertTrue(is_scan('rg foo "$HOME"'))
        self.assertTrue(is_scan('rg foo "$HOME"/Documents'))

    def test_home_span_backslash_in_single_quotes_is_literal(self):
        # In single quotes a backslash is literal, so `'%s\'` closes at its
        # second quote: the span ends at its real closing quote and the rest
        # of the command is read as commands, with its comment masked.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan("echo \"$HOME/$(printf '%s\\' x)\"; find ~/Documents"))
        self.assertFalse(
            is_scan("echo \"$HOME/$(printf '%s\\' x)\"; grep -rl needle src # ~/Documents")
        )

    def test_home_span_mask_follows_substitution_quotes_and_escapes(self):
        # The span's separator mask reads the same quoting as its closer: a
        # quoted `)` does not end the substitution, so the scan after it
        # still warns. In the span itself an escaped separator is data (a
        # BRE `\|` alternation), and an escaped `\$(` opens nothing.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan("echo \"$HOME/$(printf ')'; find ~/Documents)\""))
        self.assertTrue(is_scan('grep -rl "$HOME/a\\|$HOME/b" ~/Documents'))
        self.assertFalse(is_scan('echo "$HOME/\\$(x; find ~/Documents"'))

    def test_options_end_at_double_dash_and_operands_are_not_options(self):
        # Every option decision reads only real options: after `--` each
        # token is a positional, an option's operand is not an option, and a
        # bare `-` (stdin) is a positional.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan('rg -- "$HOME" --files src/'))
        self.assertFalse(is_scan('rg -g --files "$HOME/x" src/'))
        self.assertFalse(is_scan('rg -- "$HOME" -e src/'))
        self.assertFalse(is_scan("grep -- -r ~/Documents"))
        self.assertTrue(is_scan("rg -- --max-depth 1 ~/Documents"))
        self.assertTrue(is_scan("rg -e --max-depth 1 ~/Documents"))
        self.assertTrue(is_scan("grep -r - ~/Documents"))

    def test_substitution_inside_a_word_keeps_the_path_depth(self):
        # A substitution's output joins its word, so the masked span must
        # stay in that word: `"$HOME/$(x)/repo"` is a deep path.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan('find "$HOME/$(printf work)/repo"'))
        self.assertFalse(is_scan("find ~/`printf work`/repo"))
        self.assertTrue(is_scan('find "$HOME/$(printf Documents)"'))

    def test_find_action_words_are_not_a_depth_bound(self):
        # The words of -exec/-ok run as a command, so their -maxdepth does not
        # bound the outer walk; a bound after the action's `;` or `{} +` still
        # counts, and a glued grouping paren is not part of the number.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan("find ~ -type d -exec find {} -maxdepth 1 \\;"))
        self.assertTrue(is_scan("find ~/Documents -ok find {} -maxdepth 1 ';'"))
        self.assertFalse(is_scan("find ~ -exec echo {} \\; -maxdepth 1"))
        self.assertFalse(is_scan("find ~ -exec echo {} + -maxdepth 2"))
        self.assertFalse(is_scan("(find ~ -maxdepth 2)"))
        self.assertFalse(is_scan("(rg needle ~ --max-depth 2)"))
        self.assertFalse(is_scan("(rg needle ~ -d 2)"))

    def test_leading_redirections_do_not_hide_the_command(self):
        # Bash allows redirections before the command word.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan("2>/dev/null find ~"))
        self.assertTrue(is_scan('> /tmp/results rg needle "$HOME"'))
        self.assertTrue(is_scan("LC_ALL=C 2>&1 grep -rl needle ~/Documents"))
        self.assertFalse(is_scan("2>/dev/null find ~ -maxdepth 1"))

    def test_grep_dereference_recursive_is_recursive(self):
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan("grep --dereference-recursive needle ~/Documents"))
        self.assertFalse(is_scan("grep --dereference-recursive needle src/"))

    def test_rg_value_options_do_not_displace_the_pattern(self):
        # rg's -r is --replace and takes a value, like -E/--encoding and the
        # long value options: the operand is skipped, so the quoted
        # "$HOME/needle" stays the pattern and src/ is the only root.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan('rg -r X "$HOME/needle" src/'))
        self.assertFalse(is_scan('rg --replace X "$HOME/needle" src/'))
        self.assertFalse(is_scan('rg -E utf-8 "$HOME/needle" src/'))
        self.assertFalse(is_scan('rg --sort path "$HOME/needle" src/'))
        self.assertFalse(is_scan('rg -rlefoo "$HOME"'))
        self.assertTrue(is_scan('rg -r X needle "$HOME"'))

    def test_clustered_rg_depth_bound_is_a_bound(self):
        # `-d` at the end of a short cluster is still the depth bound; after a
        # value letter (`-ed2`) it is that option's operand.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan("rg -id2 needle ~/Documents"))
        self.assertFalse(is_scan("rg -id 2 needle ~/Documents"))
        self.assertTrue(is_scan("rg -ed2 ~/Documents"))

    def test_glued_quoted_fragments_keep_the_path_depth(self):
        # Bash joins quoted fragments into one word, so `"$HOME"/"work/repo"`
        # is the deep path $HOME/work/repo. Masked quoted data stays in the
        # word and keeps its `/`, so only a real home-scale root warns.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan('find "$HOME"/"work/repo" -name x'))
        self.assertFalse(is_scan('find ~/"work/repo" -name x'))
        self.assertFalse(is_scan("find ~/'work/repo' -name x"))
        self.assertFalse(is_scan('find ~/"work"/repo -name x'))
        self.assertTrue(is_scan('find "$HOME"/"Documents"'))
        self.assertTrue(is_scan("find ~/'Documents'"))

    def test_reserved_words_do_not_hide_the_command(self):
        # The command after a reserved word (`then`, `do`, `!`, `time`, ...)
        # still runs, so a scan there warns like the bare command.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan('if true; then find "$HOME/Documents"; fi'))
        self.assertTrue(is_scan("while true; do grep -rl needle ~/Documents; done"))
        self.assertTrue(is_scan("if find ~/Documents -name x; then echo y; fi"))
        self.assertTrue(is_scan("! find ~/Documents"))
        self.assertTrue(is_scan("time rg needle ~/Documents"))
        self.assertTrue(is_scan("time -p find ~/Documents"))
        self.assertTrue(is_scan("time -p -- find ~/Documents"))
        self.assertFalse(is_scan("if true; then timeout 60 find ~/Documents; fi"))
        self.assertFalse(is_scan("if true; then echo find ~/Documents; fi"))

    def test_arithmetic_expansion_is_not_command_text(self):
        # `$((...))` is arithmetic, so its text never reads as a scan; a
        # command substitution nested in it still runs and still warns.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan("echo $(( find + ~ 1 ))"))
        self.assertTrue(is_scan("echo $(( $(find ~/Documents | wc -l) + 1 ))"))

    def test_rg_maxdepth_alias_is_a_bound(self):
        # rg also accepts --maxdepth for --max-depth, with either operand form.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan('rg --maxdepth=2 needle "$HOME"'))
        self.assertFalse(is_scan('rg --maxdepth 2 needle "$HOME"'))
        self.assertTrue(is_scan('rg --maxdepth=x needle "$HOME"'))

    def test_quoted_option_words_stay_visible(self):
        # The tool sees a quoted option word after quote removal, so a quoted
        # depth bound is still a bound and a quoted expression word still
        # ends find's roots.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan('rg "--max-depth" "2" needle "$HOME"'))
        self.assertFalse(is_scan("find ~/Documents '-maxdepth' 2"))
        self.assertFalse(is_scan("find . '-newer' ~/stamp"))
        self.assertTrue(is_scan("find ~/Documents '-name' x"))

    def test_assignment_words_do_not_hide_the_command(self):
        # An assignment word before a command only sets its environment, so
        # the scan after it warns like the bare command.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan("LC_ALL=C grep -rl needle ~/Documents"))
        self.assertTrue(is_scan('FOO=1 BAR="a b" find ~/Documents'))
        self.assertFalse(is_scan("LC_ALL=C timeout 60 find ~/Documents"))
        self.assertFalse(is_scan("x=1"))

    def test_array_assignment_is_not_a_command_prefix(self):
        # The words of an array assignment are elements, not a command, so a
        # scan-like element never warns; a real scan after it still does.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertFalse(is_scan("files=( find ~/Documents ); sleep 100"))
        self.assertFalse(is_scan("files=(rg needle ~)"))
        self.assertTrue(is_scan("files=(a b); find ~/Documents"))

    def test_process_substitution_bodies_are_scanned(self):
        # `<(...)` and `>(...)` bodies run like `$(...)` bodies, so a scan
        # inside one warns.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan("diff <(find ~/Documents) <(ls)"))
        self.assertTrue(is_scan("tee >(grep -rl needle ~/Documents) < /dev/null"))
        self.assertFalse(is_scan("diff <(find . -name x) <(ls)"))

    def test_standalone_background_ampersand_is_a_segment_separator(self):
        # A lone `&` backgrounds the left side and starts a new command, so
        # `sleep 1 & find "$HOME"` must warn like its `&&` form; the `&` in
        # redirection spellings (`2>&1`, `<&`, `&>`, `&>>`) is not a
        # separator and must not break the segment.
        is_scan = _scan_guard._is_unbounded_home_scan
        self.assertTrue(is_scan('sleep 1 & find "$HOME"'))
        self.assertTrue(is_scan('sleep 1 & grep -rl needle ~/Documents'))
        self.assertTrue(is_scan('sleep 120 & find "$HOME" -name "*.pdf"'))
        self.assertFalse(is_scan('sleep 120 & grep -rl needle .'))
        # Redirection spellings keep the segment whole.
        self.assertTrue(is_scan('grep -rl needle "$HOME" 2>&1'))
        self.assertTrue(is_scan('grep -rl needle 2>&1 "$HOME"'))
        self.assertTrue(is_scan('grep -rl needle "$HOME" &> ~/out.txt'))
        self.assertTrue(is_scan('grep -rl needle "$HOME" &>> ~/out.txt'))
        self.assertFalse(is_scan('grep -rl needle . 2>&1'))
        self.assertFalse(is_scan('grep -rl needle . &> ~/out.txt'))
        self.assertFalse(is_scan('rg pattern . <&0'))

    def test_dispatch_hint_is_budgeted_and_names_the_fix(self):
        with (
            mock.patch.object(_scan_guard, "_scan_hints_written", 0),
            mock.patch("sys.stderr", new=io.StringIO()) as err,
        ):
            for _ in range(4):
                _scan_guard.note_scan_cost("grep -rl needle ~/Documents")
            _scan_guard.note_scan_cost("grep -rl needle .")
        self.assertEqual(err.getvalue().count("unbounded"), 3)
        self.assertIn("h = bash(", err.getvalue())

    def test_dispatch_hint_bounds_portably_not_via_the_shell_timeout(self):
        # Stock macOS has no GNU `timeout`, and the incident-style
        # `timeout 60 grep ... 2>/dev/null` masks its command-not-found
        # failure, so the hint must not recommend the shell prefix.
        with (
            mock.patch.object(_scan_guard, "_scan_hints_written", 0),
            mock.patch("sys.stderr", new=io.StringIO()) as err,
        ):
            _scan_guard.note_scan_cost("grep -rl needle ~/Documents")
        self.assertIn("--max-depth", err.getvalue())
        self.assertNotIn("timeout 60", err.getvalue())

    def test_dispatch_hint_names_an_armed_scan_timeout(self):
        with (
            mock.patch.object(_scan_guard, "_scan_hints_written", 0),
            mock.patch("sys.stderr", new=io.StringIO()) as err,
        ):
            _scan_guard.note_scan_cost("grep -rl needle ~/Documents", 12.5)
        self.assertIn("PRIME_AGENT_SCAN_TIMEOUT", err.getvalue())
        self.assertIn("12.5s", err.getvalue())


if __name__ == "__main__":
    unittest.main()
