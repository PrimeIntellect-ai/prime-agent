#!/bin/sh

set -eu

# Keep these sentinels split so release publishing only rewrites the configured
# values below; local or unpublished copies still need unreplaced values to compare.
prime_agent_unconfigured_base_url="__PRIME_AGENT_DOWNLOAD_BASE""_URL__"
prime_agent_unconfigured_default_release_channel="__PRIME_AGENT_DEFAULT_RELEASE_""CHANNEL__"
prime_agent_base_url="${PRIME_AGENT_DOWNLOAD_BASE_URL:-__PRIME_AGENT_DOWNLOAD_BASE_URL__}"
prime_agent_base_url="${prime_agent_base_url%/}"
prime_agent_default_release_channel="__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"
if [ "$prime_agent_default_release_channel" = "$prime_agent_unconfigured_default_release_channel" ]; then
	prime_agent_default_release_channel=stable
fi
prime_agent_release_channel="${PRIME_AGENT_RELEASE_CHANNEL:-$prime_agent_default_release_channel}"
prime_agent_package="${PRIME_AGENT_PACKAGE:-prime-agent}"
prime_agent_cmd="${PRIME_AGENT_CMD:-prime-agent}"
prime_agent_esc=$(printf '\033')
prime_agent_original_path="${PATH:-}"
prime_agent_reset="${prime_agent_esc}[0m"
prime_agent_bold="${prime_agent_esc}[1m"
prime_agent_italic="${prime_agent_esc}[3m"
prime_agent_hide_cursor="${prime_agent_esc}[?25l"
prime_agent_show_cursor="${prime_agent_esc}[?25h"
prime_agent_home_cursor="${prime_agent_esc}[H"
prime_agent_clear_screen="${prime_agent_esc}[2J${prime_agent_esc}[H"
prime_agent_clear_line="${prime_agent_esc}[K"
prime_agent_sync_start="${prime_agent_esc}[?2026h"
prime_agent_sync_end="${prime_agent_esc}[?2026l"
prime_agent_color_text="${prime_agent_esc}[38;2;244;244;245m"
prime_agent_color_muted="${prime_agent_esc}[38;2;161;161;170m"
prime_agent_color_dim="${prime_agent_esc}[38;2;113;113;122m"
prime_agent_color_primary="${prime_agent_esc}[38;2;127;91;213m"
prime_agent_color_scan="${prime_agent_esc}[38;2;14;165;233m"
prime_agent_color_warning="${prime_agent_esc}[38;2;245;158;11m"
readonly prime_agent_unconfigured_base_url prime_agent_unconfigured_default_release_channel prime_agent_base_url prime_agent_default_release_channel prime_agent_release_channel prime_agent_package prime_agent_cmd prime_agent_esc prime_agent_original_path
readonly prime_agent_reset prime_agent_bold prime_agent_italic prime_agent_hide_cursor prime_agent_show_cursor prime_agent_home_cursor prime_agent_clear_screen prime_agent_clear_line
readonly prime_agent_sync_start prime_agent_sync_end
readonly prime_agent_color_text prime_agent_color_muted prime_agent_color_dim prime_agent_color_primary prime_agent_color_scan prime_agent_color_warning

prime_agent_screen_enabled=0
prime_agent_screen_frame=0
prime_agent_screen_cols=80
prime_agent_screen_rows=24
prime_agent_screen_drawn=0
prime_agent_screen_last_cols=0
prime_agent_screen_last_rows=0
prime_agent_screen_layout_ready=0
prime_agent_screen_layout_show_logo=0
prime_agent_screen_layout_lab_width=0
prime_agent_screen_render_lab_width=0
prime_agent_screen_compact=0
prime_agent_download_dir=
prime_agent_bootstrap_kernel_on_install=0
prime_agent_screen_title=
prime_agent_screen_status=
prime_agent_screen_detail=
prime_agent_screen_question=
prime_agent_animation_frame=0
prime_agent_binary_versions_dir="${PRIME_AGENT_VERSIONS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/prime-agent/versions}"
prime_agent_binary_symlink="${PRIME_AGENT_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/prime-agent"
prime_agent_binary_rollback_version=
prime_agent_is_update=0

main() {
	if [ "$prime_agent_base_url" = "$prime_agent_unconfigured_base_url" ]; then
		printf 'error: installer download URL is not configured.\n' >&2
		printf 'Set PRIME_AGENT_DOWNLOAD_BASE_URL or use the installer published by the release workflow.\n' >&2
		exit 1
	fi

	prime_agent_is_update=0
	_prime_agent_positional=
	for _prime_agent_arg in "$@"; do
		case "$_prime_agent_arg" in
			--method=*)
				printf 'error: --method is no longer supported; Prime Agent installs as a compiled Bun binary.\n' >&2
				exit 1
				;;
			--update)
				prime_agent_is_update=1
				;;
			*)
				if [ -z "$_prime_agent_positional" ]; then
					_prime_agent_positional="$_prime_agent_arg"
				else
					_prime_agent_positional="$_prime_agent_positional $_prime_agent_arg"
				fi
				;;
		esac
	done

	prime_agent_install_traps
	prime_agent_init_screen

	if [ "$prime_agent_is_update" = 1 ]; then
		if [ "$prime_agent_screen_enabled" = 1 ]; then
			prime_agent_screen "Updating Prime Agent" "" "" ""
		else
			printf '\n\033[1m  Updating Prime Agent\033[0m\n'
		fi
		prime_agent_binary_update "${_prime_agent_positional:-}"
		return
	fi

	if [ "$prime_agent_screen_enabled" = 1 ]; then
		prime_agent_screen "Installing Prime Agent" "" "" ""
	else
		printf '\n\033[1m  Installing Prime Agent\033[0m\n\033[2m  compiled Bun binary\033[0m\n\n'
	fi
	prime_agent_binary_fresh_install "${_prime_agent_positional:-}"
}

create_temp_dir() {
	if command -v mktemp >/dev/null 2>&1; then
		if tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-install.XXXXXX" 2>/dev/null); then
			printf '%s' "$tmp_dir"
			return
		fi
	fi

	printf 'error: mktemp is required to create a secure temporary directory.\n' >&2
	exit 1
}

prime_agent_install_traps() {
	trap 'prime_agent_cleanup' EXIT
	trap 'prime_agent_signal_cleanup 130' INT
	trap 'prime_agent_signal_cleanup 143' TERM
}

prime_agent_cleanup() {
	status=$?
	if [ -n "${prime_agent_download_dir:-}" ] && [ -d "$prime_agent_download_dir" ]; then
		rm -rf "$prime_agent_download_dir"
	fi
	prime_agent_restore_terminal
	return "$status"
}

prime_agent_signal_cleanup() {
	prime_agent_restore_terminal
	exit "$1"
}

prime_agent_restore_terminal() {
	if [ "${prime_agent_screen_enabled:-0}" = 1 ]; then
		if ( : <>/dev/tty ) 2>/dev/null; then
			printf '%s%s' "$prime_agent_reset" "$prime_agent_show_cursor" >/dev/tty
		else
			printf '%s%s' "$prime_agent_reset" "$prime_agent_show_cursor" >&2
		fi
	fi
}

prime_agent_init_screen() {
	if [ "${PRIME_AGENT_INSTALLER_PLAIN:-0}" = 1 ]; then
		return
	fi
	if [ ! -t 1 ]; then
		return
	fi
	if [ "${TERM:-}" = dumb ]; then
		return
	fi
	prime_agent_screen_enabled=1
}

prime_agent_read_terminal_size() {
	prime_agent_screen_cols=80
	prime_agent_screen_rows=24

	if size=$(stty size 2>/dev/null </dev/tty); then
		set -- $size
		if [ "${1:-}" ] && [ "${2:-}" ]; then
			case "$1" in *[!0-9]*|"") ;; *) prime_agent_screen_rows="$1" ;; esac
			case "$2" in *[!0-9]*|"") ;; *) prime_agent_screen_cols="$2" ;; esac
		fi
	fi

	if [ "$prime_agent_screen_cols" -lt 1 ]; then
		prime_agent_screen_cols=80
	fi
	if [ "$prime_agent_screen_rows" -lt 1 ]; then
		prime_agent_screen_rows=24
	fi
}

prime_agent_screen() {
	if [ "$prime_agent_screen_enabled" != 1 ]; then
		return
	fi

	prime_agent_screen_title="${2:-$1}"
	if [ -z "$prime_agent_screen_title" ]; then
		prime_agent_screen_title="$1"
	fi
	prime_agent_screen_status=
	prime_agent_screen_detail="${3:-}"
	prime_agent_screen_question="${4:-}"
	prime_agent_screen_frame=$((prime_agent_screen_frame + 1))
	prime_agent_read_terminal_size
	prime_agent_init_screen_layout
	prime_agent_refresh_screen_layout_mode

	if [ "$prime_agent_screen_drawn" = 0 ] ||
		[ "$prime_agent_screen_cols" -ne "$prime_agent_screen_last_cols" ] ||
		[ "$prime_agent_screen_rows" -ne "$prime_agent_screen_last_rows" ]; then
		prime_agent_screen_prefix="${prime_agent_reset}${prime_agent_clear_screen}${prime_agent_hide_cursor}"
		prime_agent_screen_drawn=1
		prime_agent_screen_last_cols="$prime_agent_screen_cols"
		prime_agent_screen_last_rows="$prime_agent_screen_rows"
	else
		prime_agent_screen_prefix="${prime_agent_reset}${prime_agent_home_cursor}${prime_agent_hide_cursor}"
	fi
	prime_agent_screen_frame_text=$(prime_agent_render_screen)

	if ( : <>/dev/tty ) 2>/dev/null; then
		printf '%s%s%s%s' "$prime_agent_sync_start" "$prime_agent_screen_prefix" "$prime_agent_screen_frame_text" "$prime_agent_sync_end" >/dev/tty
	else
		printf '%s%s%s%s' "$prime_agent_sync_start" "$prime_agent_screen_prefix" "$prime_agent_screen_frame_text" "$prime_agent_sync_end" >&2
	fi
}

prime_agent_init_screen_layout() {
	if [ "$prime_agent_screen_layout_ready" = 1 ]; then
		return
	fi

	prime_agent_screen_layout_ready=1
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	if prime_agent_terminal_size_supports_logo; then
		prime_agent_screen_layout_show_logo=1
		prime_agent_screen_layout_lab_width=$(prime_agent_lab_width_for_cols "$prime_agent_screen_cols")
	fi
}

prime_agent_refresh_screen_layout_mode() {
	prime_agent_screen_compact=0
	prime_agent_screen_render_lab_width=0
	if [ "$prime_agent_screen_layout_show_logo" != 1 ]; then
		return
	fi
	if [ "$prime_agent_screen_rows" -lt 17 ]; then
		prime_agent_screen_compact=1
		return
	fi

	max_safe_width=$((prime_agent_screen_cols - 1))
	if [ "$max_safe_width" -lt 32 ]; then
		prime_agent_screen_compact=1
		return
	fi

	prime_agent_screen_render_lab_width="$prime_agent_screen_layout_lab_width"
	if [ "$prime_agent_screen_render_lab_width" -gt "$max_safe_width" ]; then
		prime_agent_screen_render_lab_width="$max_safe_width"
	fi
}

prime_agent_terminal_size_supports_logo() {
	[ "$prime_agent_screen_rows" -ge 22 ] && [ "$prime_agent_screen_cols" -ge 42 ]
}

prime_agent_lab_width_for_cols() {
	cols="$1"
	width=$((cols - 6))
	if [ "$width" -gt 78 ]; then
		width=78
	fi
	if [ "$width" -lt 42 ]; then
		width=42
	fi
	max_safe_width=$((cols - 1))
	if [ "$max_safe_width" -lt 1 ]; then
		max_safe_width=1
	fi
	if [ "$width" -gt "$max_safe_width" ]; then
		width="$max_safe_width"
	fi
	if [ "$width" -lt 32 ]; then
		width=32
	fi
	printf '%s' "$width"
}

prime_agent_render_screen() {
	content_height=$(prime_agent_content_height)
	top=$(((prime_agent_screen_rows - content_height) / 2))
	if [ "$top" -lt 0 ]; then
		top=0
	fi

	y=0
	while [ "$y" -lt "$prime_agent_screen_rows" ]; do
		content_index=$((y - top))
		prime_agent_content_line "$content_index"
		if [ "${prime_agent_content_is_set:-0}" = 1 ]; then
			prime_agent_print_centered_line "$prime_agent_content_text" "$prime_agent_content_width" "$prime_agent_content_style"
		else
			prime_agent_print_centered_line "" 0 ""
		fi
		y=$((y + 1))
	done
}

prime_agent_content_height() {
	height=2
	if prime_agent_show_logo; then
		height=$((height + 15))
	fi
	printf '%s' "$height"
}

prime_agent_show_logo() {
	[ "$prime_agent_screen_layout_show_logo" = 1 ] && [ "$prime_agent_screen_compact" != 1 ] && [ "$prime_agent_screen_render_lab_width" -ge 32 ]
}

prime_agent_content_line() {
	index="$1"
	prime_agent_content_is_set=0
	prime_agent_content_text=
	prime_agent_content_width=0
	prime_agent_content_style=

	if prime_agent_show_logo; then
		case "$index" in
			0|1|2|3|4|5|6|7|8|9|10|11|12|13) prime_agent_set_lab_line "$index" ;;
			14) prime_agent_set_blank_line ;;
		esac
		if [ "$prime_agent_content_is_set" = 1 ]; then
			return
		fi
		index=$((index - 15))
	fi

	if [ "$index" -lt 0 ]; then
		return
	fi

	if [ "$index" -eq 0 ]; then
		if [ -n "$prime_agent_screen_question" ]; then
			prime_agent_set_text_line "$(prime_agent_screen_primary_text)" "$prime_agent_bold$prime_agent_color_text"
		else
			prime_agent_set_title_line "$prime_agent_screen_title"
		fi
		return
	fi

	if [ "$index" -eq 1 ]; then
		if [ -n "$prime_agent_screen_question" ]; then
			prime_agent_set_text_line "Press Enter to continue; type n to cancel." "$prime_agent_color_muted"
		elif [ -n "$prime_agent_screen_detail" ]; then
			prime_agent_set_text_line "$prime_agent_screen_detail" "$prime_agent_color_muted"
		else
			prime_agent_set_blank_line
		fi
		return
	fi
}

prime_agent_screen_primary_text() {
	if [ -z "$prime_agent_screen_question" ]; then
		printf '%s' "$prime_agent_screen_title"
		return
	fi

	case "$prime_agent_screen_question" in
		*'[Y/n]'*) printf '%s [Y/n] >' "$prime_agent_screen_title" ;;
		*) printf '%s %s' "$prime_agent_screen_title" "$prime_agent_screen_question" ;;
	esac
}

prime_agent_set_lab_line() {
	lab_row="$1"
	prime_agent_lab_width="$prime_agent_screen_render_lab_width"

	logo_line=$(prime_agent_logo_line "$lab_row")
	if [ -n "$logo_line" ]; then
		logo_start=$(((prime_agent_lab_width - 32) / 2))
		logo_end=$((logo_start + 32))
		left=$(prime_agent_lab_background_range "$lab_row" 0 "$logo_start")
		right=$(prime_agent_lab_background_range "$lab_row" "$logo_end" "$prime_agent_lab_width")
		trace="${left}${prime_agent_color_text}${logo_line}${prime_agent_reset}${right}"
	else
		trace=$(prime_agent_lab_background_range "$lab_row" 0 "$prime_agent_lab_width")
	fi

	prime_agent_content_is_set=1
	prime_agent_content_text="$trace"
	prime_agent_content_width="$prime_agent_lab_width"
	prime_agent_content_style=
}

prime_agent_logo_line() {
	case "$1" in
		2) printf '                          ▄▄███▀' ;;
		3) printf '    ▄▄▄▄▄              ▄█████▀' ;;
		4) printf '    ██████▄         ▄██████▀' ;;
		5) printf '   ▄███▀███▄     ▄███▀▄██▀' ;;
		6) printf '   ███ ▄████▄▄▄████▀▄▄██' ;;
		7) printf '  ▀██  ▀█████████▀▀▀▀▀▀' ;;
		8) printf '  ▄██   ██████▀▀ ▄███' ;;
		9) printf ' █████    ▀█▄▄▄█████▀' ;;
		10) printf '███████▄  ████████▀' ;;
		11) printf '▀███▀▀    █████▀' ;;
	esac
}

prime_agent_lab_background_range() {
	lab_row="$1"
	range_start="$2"
	range_end="$3"
	active_style=
	line=
	x="$range_start"
	while [ "$x" -lt "$range_end" ]; do
		prime_agent_lab_cell "$x" "$lab_row"
		if [ "$prime_agent_lab_cell_style" != "$active_style" ]; then
			if [ -n "$active_style" ]; then
				line="${line}${prime_agent_reset}"
			fi
			if [ -n "$prime_agent_lab_cell_style" ]; then
				line="${line}${prime_agent_lab_cell_style}"
			fi
			active_style="$prime_agent_lab_cell_style"
		fi
		line="${line}${prime_agent_lab_cell_char}"
		x=$((x + 1))
	done
	if [ -n "$active_style" ]; then
		line="${line}${prime_agent_reset}"
	fi
	printf '%s' "$line"
}

prime_agent_lab_cell() {
	x="$1"
	y="$2"
	width="$prime_agent_lab_width"
	height=14
	frame="$prime_agent_screen_frame"
	prime_agent_lab_cell_char=" "
	prime_agent_lab_cell_style=

	hash=$(((x * 37 + y * 53 + frame * 11 + x * y * 3) % 101))
	if [ "$hash" -lt 3 ]; then
		prime_agent_lab_cell_char="·"
		prime_agent_lab_cell_style="$prime_agent_color_dim"
	fi

	center_x=$((width * 36 / 100))
	center_y=$((height * 54 / 100))
	dx=$((x - center_x))
	dy=$((y - center_y))
	if [ "$dx" -lt 0 ]; then
		dx=$((-dx))
	fi
	if [ "$dy" -lt 0 ]; then
		dy=$((-dy))
	fi
	contour=$((dx + dy * 4 + x / 6 - frame))
	if [ "$x" -lt $((width * 82 / 100)) ] && [ $(((contour % 24 + 24) % 24)) -eq 12 ]; then
		if [ $(((x + y) % 5)) -eq 0 ]; then
			prime_agent_lab_cell_char="╌"
		else
			prime_agent_lab_cell_char="·"
		fi
		prime_agent_lab_cell_style="$prime_agent_color_dim"
	fi

	horizon_y=$((height * 58 / 100))
	if [ "$y" -eq "$horizon_y" ] && [ $((x % 2)) -eq 0 ] && [ $(((x + frame) % 13)) -lt 2 ]; then
		prime_agent_lab_cell_char="─"
		if [ "$x" -gt $((width * 60 / 100)) ]; then
			prime_agent_lab_cell_style="$prime_agent_color_primary"
		else
			prime_agent_lab_cell_style="$prime_agent_color_dim"
		fi
	fi

	scan_start=$((width / 2))
	if [ "$x" -ge "$scan_start" ]; then
		scan_offset=$((x - scan_start))
		if [ $((scan_offset % 5)) -eq 0 ]; then
			scan_index=$((scan_offset / 5))
			scan_top=$((1 + (scan_index + frame / 3) % 3))
			scan_bottom=$((height - 2 - (scan_index * 2 + frame / 4) % 3))
			if [ "$y" -ge "$scan_top" ] && [ "$y" -le "$scan_bottom" ] && [ $(((y + scan_index + frame) % 6)) -ne 0 ]; then
				if [ $(((scan_index + y) % 4)) -eq 0 ]; then
					prime_agent_lab_cell_char="┃"
				else
					prime_agent_lab_cell_char="╎"
				fi
				prime_agent_lab_cell_style="$prime_agent_color_scan"
			fi
		fi
	fi

	trace_index=0
	while [ "$trace_index" -lt 3 ]; do
		case "$trace_index" in
			0) base=$((height * 30 / 100)) ;;
			1) base=$((height * 49 / 100)) ;;
			*) base=$((height * 72 / 100)) ;;
		esac
		wave=$(((x * 2 + frame + trace_index * 7) % 16))
		if [ "$wave" -gt 7 ]; then
			wave=$((15 - wave))
		fi
		trace_y=$((base + (wave - 3) / 2))
		if [ "$y" -eq "$trace_y" ]; then
			if [ $(((x + frame + trace_index * 13) % 41)) -eq 0 ]; then
				prime_agent_lab_cell_char="◆"
				prime_agent_lab_cell_style="$prime_agent_color_warning"
			elif [ $(((x + frame) % 12)) -eq 0 ]; then
				prime_agent_lab_cell_char="•"
				prime_agent_lab_cell_style="$prime_agent_color_primary"
			else
				prime_agent_lab_cell_char="·"
				prime_agent_lab_cell_style="$prime_agent_color_primary"
			fi
		fi
		trace_index=$((trace_index + 1))
	done
}

prime_agent_set_blank_line() {
	prime_agent_content_is_set=1
	prime_agent_content_text=
	prime_agent_content_width=0
	prime_agent_content_style=
}

prime_agent_set_text_line() {
	max_width=$((prime_agent_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	prime_agent_content_text=$(prime_agent_fit_ascii "$1" "$max_width")
	prime_agent_content_width=${#prime_agent_content_text}
	prime_agent_content_style="$2"
	prime_agent_content_is_set=1
}

prime_agent_set_title_line() {
	max_width=$((prime_agent_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	prime_agent_content_text=$(prime_agent_fit_ascii "$1" "$max_width")
	prime_agent_content_width=${#prime_agent_content_text}
	case "$prime_agent_content_text" in
		*"Prime Agent"*)
			prime_agent_content_text=$(prime_agent_style_prime_agent_title "$prime_agent_content_text")
			prime_agent_content_style=
			;;
		*)
			prime_agent_content_style="$prime_agent_bold$prime_agent_color_primary"
			;;
	esac
	prime_agent_content_is_set=1
}

prime_agent_style_prime_agent_title() {
	text="$1"
	styled=
	while :; do
		case "$text" in
			*"Prime Agent"*)
				before=${text%%Prime Agent*}
				rest=${text#*Prime Agent}
				styled="${styled}${prime_agent_bold}${prime_agent_color_primary}${before}"
				styled="${styled}${prime_agent_bold}${prime_agent_color_primary}PRIME Agent${prime_agent_reset}"
				text="$rest"
				;;
			*)
				styled="${styled}${prime_agent_bold}${prime_agent_color_primary}${text}${prime_agent_reset}"
				printf '%s' "$styled"
				return
				;;
		esac
	done
}

prime_agent_fit_ascii() {
	text="$1"
	max_width="$2"
	if [ "${#text}" -le "$max_width" ]; then
		printf '%s' "$text"
		return
	fi
	if [ "$max_width" -le 3 ]; then
		printf '%s' "$text" | cut -c 1-"$max_width"
		return
	fi
	cut_width=$((max_width - 3))
	printf '%s...' "$(printf '%s' "$text" | cut -c 1-"$cut_width")"
}

prime_agent_print_centered_line() {
	text="$1"
	width="$2"
	style="$3"
	left=$(((prime_agent_screen_cols - width) / 2))
	if [ "$left" -lt 0 ]; then
		left=0
	fi
	if [ -n "$style" ]; then
		printf '%*s%s%s%s%s\n' "$left" "" "$style" "$text" "$prime_agent_reset" "$prime_agent_clear_line"
	else
		printf '%*s%s%s\n' "$left" "" "$text" "$prime_agent_clear_line"
	fi
}

prime_agent_pulse() {
	case $((prime_agent_screen_frame % 4)) in
		0) printf '.' ;;
		1) printf '..' ;;
		2) printf '...' ;;
		*) printf '' ;;
	esac
}

prime_agent_animation_detail_count() {
	details="$1"
	case "$details" in
		*'
'*) printf '%s\n' "$details" | wc -l | tr -d ' ' ;;
		*) printf '1' ;;
	esac
}

prime_agent_animation_current_frame() {
	frame="${prime_agent_animation_frame:-1}"
	case "$frame" in
		""|*[!0-9]*) frame=1 ;;
	esac
	if [ "$frame" -lt 1 ]; then
		frame=1
	fi
	printf '%s' "$frame"
}

prime_agent_animation_step_index() {
	details="$1"
	detail_count=$(prime_agent_animation_detail_count "$details")
	frame=$(prime_agent_animation_current_frame)
	detail_index=$(((frame - 1) / 24 + 1))
	if [ "$detail_index" -gt "$detail_count" ]; then
		detail_index="$detail_count"
	fi
	printf '%s' "$detail_index"
}

prime_agent_static_progress_title() {
	case "$1" in
		*...) printf '%s' "$1" ;;
		*) printf '%s...' "$1" ;;
	esac
}

prime_agent_animation_status() {
	status="$1"
	details="$2"
	status_mode="$3"
	case "$status_mode" in
		static) prime_agent_static_progress_title "$status" ;;
		*) printf '%s%s' "$status" "$(prime_agent_pulse)" ;;
	esac
}

prime_agent_animation_detail() {
	details="$1"
	case "$details" in
		*'
'*)
			detail_index=$(prime_agent_animation_step_index "$details")
			printf '%s\n' "$details" | sed -n "${detail_index}p"
			;;
		*) printf '%s' "$details" ;;
	esac
}

prime_agent_run_quiet_with_animation() {
	title="$1"
	status="$2"
	detail="$3"
	shift 3

	prime_agent_run_quiet_with_animation_command "$title" "$status" "$detail" pulse "$@"
}

prime_agent_run_quiet_with_animation_command() {
	title="$1"
	status="$2"
	details="$3"
	status_mode="$4"
	shift 4

	if [ "$prime_agent_screen_enabled" != 1 ]; then
		printf '%s\n' "$status" >&2
		"$@"
		return
	fi

	output_dir=$(create_temp_dir)
	output_file="$output_dir/output"
	"$@" >"$output_file" 2>&1 &
	command_pid=$!
	prime_agent_animation_frame=0

	while kill -0 "$command_pid" 2>/dev/null; do
		prime_agent_animation_frame=$((prime_agent_animation_frame + 1))
		status_display=$(prime_agent_animation_status "$status" "$details" "$status_mode")
		prime_agent_screen "$title" "$status_display" "$(prime_agent_animation_detail "$details")" ""
		sleep 0.18
	done

	if wait "$command_pid"; then
		command_status=0
	else
		command_status=$?
	fi

	if [ "$command_status" -ne 0 ] && [ -s "$output_file" ]; then
		prime_agent_restore_terminal
		printf '\n' >&2
		cat "$output_file" >&2
	fi
	rm -rf "$output_dir"
	return "$command_status"
}

resolve_prime_agent_version() {
	if [ "${1:-}" ]; then
		case "$1" in
			stable|beta) release_channel="$1" ;;
			*)
				normalize_version "$1"
				return
				;;
		esac
	else
		release_channel="$prime_agent_release_channel"
	fi

	if [ "${PRIME_AGENT_VERSION:-}" ]; then
		normalize_version "$PRIME_AGENT_VERSION"
		return
	fi

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to resolve the latest Prime Agent version.\n' >&2
		exit 1
	fi

	case "$release_channel" in
		stable|beta) ;;
		*)
			printf 'error: invalid Prime Agent release channel: %s\n' "$release_channel" >&2
			exit 1
			;;
	esac

	channel_dir=$(create_temp_dir)
	channel_path="$channel_dir/$release_channel"
	if ! prime_agent_run_quiet_with_animation \
		"Resolving latest release" \
		"Resolving latest release" \
		"Checking the $release_channel release channel." \
		curl -fsSL "$prime_agent_base_url/$release_channel" -o "$channel_path"; then
		rm -rf "$channel_dir"
		printf 'error: could not resolve latest Prime Agent version from %s/%s\n' "$prime_agent_base_url" "$release_channel" >&2
		exit 1
	fi
	channel_version="$(tr -d '[:space:]' <"$channel_path")"
	rm -rf "$channel_dir"
	if [ -z "$channel_version" ]; then
		printf 'error: could not resolve latest Prime Agent version from %s/%s\n' "$prime_agent_base_url" "$release_channel" >&2
		exit 1
	fi
	normalize_version "$channel_version"
}

normalize_version() {
	version="${1#v}"
	case "$version" in
		"")
			printf 'error: empty Prime Agent version.\n' >&2
			exit 1
			;;
		*[!0-9A-Za-z.-]*)
			printf 'error: invalid Prime Agent version: %s\n' "$1" >&2
			exit 1
			;;
	esac
	printf '%s' "$version"
}

detect_shell_profile() {
	if [ -n "${PRIME_AGENT_SHELL_PROFILE:-}" ]; then
		printf '%s' "$PRIME_AGENT_SHELL_PROFILE"
		return 0
	fi
	if [ -z "${HOME:-}" ]; then
		return 1
	fi

	shell_name="${SHELL:-}"
	shell_name="${shell_name##*/}"
	case "$shell_name" in
		zsh)
			printf '%s/.zshrc' "${ZDOTDIR:-$HOME}"
			;;
		bash)
			printf '%s/.bashrc' "$HOME"
			;;
		*)
			if [ -f "$HOME/.zshrc" ]; then
				printf '%s/.zshrc' "$HOME"
			elif [ -f "$HOME/.bashrc" ]; then
				printf '%s/.bashrc' "$HOME"
			else
				printf '%s/.profile' "$HOME"
			fi
			;;
	esac
}

prime_agent_run_checksum_check() {
	checksum_dir="$1"
	selected_checksums_name="$2"
	checker="$3"
	case "$checker" in
		sha256sum)
			(cd "$checksum_dir" && sha256sum -c "$selected_checksums_name")
			;;
		shasum)
			(cd "$checksum_dir" && shasum -a 256 -c "$selected_checksums_name")
			;;
	esac
}

prime_agent_detect_binary_platform() {
	_os=$(uname -s)
	_arch=$(uname -m)
	case "$_os" in
		Darwin)
			case "$_arch" in
				x86_64|amd64) printf 'darwin-x64' ;;
				arm64|aarch64) printf 'darwin-arm64' ;;
				*) printf 'error: unsupported macOS architecture for binary install: %s\n' "$_arch" >&2; return 1 ;;
			esac
			;;
		Linux)
			if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
				printf 'error: Prime Agent compiled binaries require glibc Linux and do not support musl systems.\n' >&2
				return 1
			fi
			case "$_arch" in
				x86_64|amd64) printf 'linux-x64' ;;
				arm64|aarch64) printf 'linux-arm64' ;;
				*) printf 'error: unsupported Linux architecture for binary install: %s\n' "$_arch" >&2; return 1 ;;
			esac
			;;
		*) printf 'error: unsupported platform for binary install: %s %s\n' "$_os" "$_arch" >&2; return 1 ;;
	esac
}

prime_agent_binary_artifact_name() {
	_version="$1"
	_platform="$2"
	printf 'prime-agent-%s-%s.tar.gz' "$_version" "$_platform"
}

prime_agent_binary_target_version_dir() {
	printf '%s/v%s' "$prime_agent_binary_versions_dir" "$1"
}

prime_agent_binary_smoke_binary() {
	_binary="$1"
	if [ ! -x "$_binary" ]; then
		return 1
	fi
	if ! "$_binary" --version >/dev/null 2>&1; then
		return 1
	fi
}

prime_agent_binary_validate_layout() {
	_root="$1"
	_binary="$2"
	if ! prime_agent_binary_smoke_binary "$_binary"; then
		printf 'error: the downloaded Prime Agent binary did not run correctly.\n' >&2
		return 1
	fi
	for _relative_path in \
		package.json README.md CHANGELOG.md install.sh photon_rs_bg.wasm \
		prime-agent-runtime/pyproject.toml \
		theme/prime.json theme/dark.json theme/light.json theme/theme-schema.json \
		export-html/template.html export-html/template.css export-html/template.js; do
		if [ ! -f "$_root/$_relative_path" ]; then
			printf 'error: release archive is missing required sidecar: %s\n' "$_relative_path" >&2
			return 1
		fi
	done
	for _relative_dir in skills assets docs examples export-html/vendor; do
		if [ ! -d "$_root/$_relative_dir" ]; then
			printf 'error: release archive is missing required sidecar directory: %s\n' "$_relative_dir" >&2
			return 1
		fi
	done
}

prime_agent_binary_atomic_symlink() {
	_target="$1"
	_link="$2"
	_target_dir=$(cd "$(dirname "$_target")" 2>/dev/null && pwd -P) || return 1
	_target="$_target_dir/$(basename "$_target")"
	# Create parent dir if needed
	_link_dir=$(dirname "$_link")
	if [ ! -d "$_link_dir" ]; then
		mkdir -p "$_link_dir"
	fi
	# Atomic replacement with temp symlink
	_tmp="${_link}.tmp.$$"
	ln -sf "$_target" "$_tmp"
	mv -f "$_tmp" "$_link"
}

prime_agent_binary_fresh_install() {
	_version=
	_version="$(resolve_prime_agent_version "$@")"
	_platform=
	if ! _platform=$(prime_agent_detect_binary_platform); then
		exit 1
	fi
	_artifact_name="$(prime_agent_binary_artifact_name "$_version" "$_platform")"
	_artifact_url="$prime_agent_base_url/releases/v$_version/$_artifact_name"
	_versions_dir="$prime_agent_binary_versions_dir"
	_version_dir="$(prime_agent_binary_target_version_dir "$_version")"

	_download_dir=$(create_temp_dir)
	prime_agent_download_dir="$_download_dir"
	_artifact_path="$_download_dir/$_artifact_name"

	mkdir -p "$_versions_dir"

	# Version directories are immutable. Reuse a healthy existing install instead
	# of replacing files underneath the active command symlink.
	_existing_binary="$_version_dir/$prime_agent_cmd"
	if [ ! -x "$_existing_binary" ] && [ -x "$_version_dir/pi" ]; then
		_existing_binary="$_version_dir/pi"
	fi
	if [ -x "$_existing_binary" ] && prime_agent_binary_validate_layout "$_version_dir" "$_existing_binary"; then
		prime_agent_binary_atomic_symlink "$_existing_binary" "$prime_agent_binary_symlink"
		prime_agent_configure_binary_path "$_version"
		return
	fi

	prime_agent_run_quiet_with_animation 		"Downloading Prime Agent v$_version" 		"Downloading Prime Agent v$_version" 		"Fetching the compiled binary for $_platform." 		curl -fsSL "$_artifact_url" -o "$_artifact_path"

	_checksums_url="$prime_agent_base_url/releases/v$_version/SHA256SUMS"
	_checksums_path="$_download_dir/SHA256SUMS"
	prime_agent_run_quiet_with_animation 		"Downloading checksums" 		"Downloading release checksums" 		"Prime Agent v$_version" 		curl -fsSL "$_checksums_url" -o "$_checksums_path"

	prime_agent_verify_binary_checksum "$_checksums_path" "$_artifact_path"

	# Extract to a clean versioned directory
	rm -rf "$_version_dir"
	mkdir -p "$_version_dir"
	prime_agent_run_quiet_with_animation 		"Extracting Prime Agent" 		"Extracting Prime Agent v$_version" 		"Installing to $_version_dir" 		tar -xzf "$_artifact_path" -C "$_version_dir"

	# Find the binary inside the extracted archive.
	# The archive may contain a wrapper dir (e.g. pi/) or be flat.
	_binary_path=
	if [ -f "$_version_dir/pi" ]; then
		_binary_path="$_version_dir/pi"
	elif [ -f "$_version_dir/$prime_agent_cmd" ]; then
		_binary_path="$_version_dir/$prime_agent_cmd"
	else
		for _d in "$_version_dir"/*/; do
			_d="${_d%/}"
			if [ -f "${_d}/pi" ]; then
				_binary_path="${_d}/pi"
				break
			elif [ -f "${_d}/$prime_agent_cmd" ]; then
				_binary_path="${_d}/$prime_agent_cmd"
				break
			fi
		done
	fi

	if [ -z "$_binary_path" ]; then
		printf 'error: could not find the prime-agent binary in the downloaded artifact.\n' >&2
		rm -rf "$_version_dir" "$_download_dir"
		prime_agent_download_dir=
		exit 1
	fi

	chmod +x "$_binary_path" 2>/dev/null || true
	# Ensure bundled install.sh is executable (required sidecar for self-update)
	if [ -f "$_version_dir/install.sh" ]; then
		chmod +x "$_version_dir/install.sh" 2>/dev/null || true
	fi

	# If the binary was inside a wrapper dir, move contents up to version_dir
	_binary_dir=$(dirname "$_binary_path")
	if [ "$_binary_dir" != "$_version_dir" ]; then
		cp -R "$_binary_dir/." "$_version_dir/"
		rm -rf "$_binary_dir"
		_binary_path="$_version_dir/$(basename "$_binary_path")"
	fi
	if ! prime_agent_binary_validate_layout "$_version_dir" "$_binary_path"; then
		rm -rf "$_version_dir" "$_download_dir"
		prime_agent_download_dir=
		exit 1
	fi

	# Create the stable symlink
	mkdir -p "$(dirname "$prime_agent_binary_symlink")"
	prime_agent_binary_atomic_symlink "$_binary_path" "$prime_agent_binary_symlink"

	rm -rf "$_download_dir"
	prime_agent_download_dir=

	prime_agent_configure_binary_path "$_version"
	# The Python kernel will be bootstrapped on first ipython use.
}

prime_agent_binary_update() {
	_update_version=
	_update_version="$(resolve_prime_agent_version "$@")"

	# Read current version from the symlink target's package.json
	_current_version=
	if [ -L "$prime_agent_binary_symlink" ]; then
		_symlink_target=$(readlink "$prime_agent_binary_symlink")
		_pkg_dir=$(dirname "$_symlink_target")
		if [ -f "$_pkg_dir/package.json" ]; then
			_current_version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$_pkg_dir/package.json" 2>/dev/null || printf '')
		fi
	fi

	if [ -n "$_current_version" ] && [ "$_current_version" = "$_update_version" ]; then
		if [ "$prime_agent_screen_enabled" = 1 ]; then
			prime_agent_screen "Prime Agent is up to date" "" "v$_current_version" ""
		else
			printf '\nPrime Agent v%s is already installed.\n' "$_current_version"
		fi
		return
	fi

	_platform=
	if ! _platform=$(prime_agent_detect_binary_platform); then
		exit 1
	fi
	_artifact_name="$(prime_agent_binary_artifact_name "$_update_version" "$_platform")"
	_artifact_url="$prime_agent_base_url/releases/v$_update_version/$_artifact_name"
	_versions_dir="$prime_agent_binary_versions_dir"
	_version_dir="$(prime_agent_binary_target_version_dir "$_update_version")"

	_download_dir=$(create_temp_dir)
	prime_agent_download_dir="$_download_dir"
	_artifact_path="$_download_dir/$_artifact_name"

	if [ "$prime_agent_screen_enabled" = 1 ]; then
		if [ -n "$_current_version" ]; then
			prime_agent_screen "Updating Prime Agent" "" "v$_current_version to v$_update_version" ""
		else
			prime_agent_screen "Updating Prime Agent" "" "to v$_update_version" ""
		fi
	fi

	prime_agent_run_quiet_with_animation 		"Downloading Prime Agent v$_update_version" 		"Downloading Prime Agent v$_update_version" 		"Fetching the compiled binary for $_platform." 		curl -fsSL "$_artifact_url" -o "$_artifact_path"

	_checksums_url="$prime_agent_base_url/releases/v$_update_version/SHA256SUMS"
	_checksums_path="$_download_dir/SHA256SUMS"
	prime_agent_run_quiet_with_animation 		"Downloading checksums" 		"Downloading release checksums" 		"Prime Agent v$_update_version" 		curl -fsSL "$_checksums_url" -o "$_checksums_path"

	prime_agent_verify_binary_checksum "$_checksums_path" "$_artifact_path"

	# Extract to a fresh version directory
	rm -rf "$_version_dir"
	mkdir -p "$_version_dir"
	prime_agent_run_quiet_with_animation 		"Extracting Prime Agent" 		"Extracting Prime Agent v$_update_version" 		"Preparing the update." 		tar -xzf "$_artifact_path" -C "$_version_dir"

	# Find the binary
	_binary_path=
	if [ -f "$_version_dir/pi" ]; then
		_binary_path="$_version_dir/pi"
	elif [ -f "$_version_dir/$prime_agent_cmd" ]; then
		_binary_path="$_version_dir/$prime_agent_cmd"
	else
		for _d in "$_version_dir"/*/; do
			_d="${_d%/}"
			if [ -f "${_d}/pi" ]; then
				_binary_path="${_d}/pi"
				break
			elif [ -f "${_d}/$prime_agent_cmd" ]; then
				_binary_path="${_d}/$prime_agent_cmd"
				break
			fi
		done
	fi

	if [ -z "$_binary_path" ]; then
		printf 'error: could not find the prime-agent binary in the downloaded artifact.\n' >&2
		rm -rf "$_version_dir" "$_download_dir"
		prime_agent_download_dir=
		exit 1
	fi

	chmod +x "$_binary_path" 2>/dev/null || true
	# Ensure bundled install.sh is executable (required sidecar for self-update)
	if [ -f "$_version_dir/install.sh" ]; then
		chmod +x "$_version_dir/install.sh" 2>/dev/null || true
	fi

	# If the binary was inside a wrapper dir, move contents up
	_binary_dir=$(dirname "$_binary_path")
	if [ "$_binary_dir" != "$_version_dir" ]; then
		cp -R "$_binary_dir/." "$_version_dir/"
		rm -rf "$_binary_dir"
		_binary_path="$_version_dir/$(basename "$_binary_path")"
	fi
	if ! prime_agent_binary_validate_layout "$_version_dir" "$_binary_path"; then
		rm -rf "$_version_dir" "$_download_dir"
		prime_agent_download_dir=
		exit 1
	fi

	# Remember old version for rollback
	if [ -L "$prime_agent_binary_symlink" ]; then
		_old_target=$(readlink "$prime_agent_binary_symlink" 2>/dev/null || printf '')
		_old_version_dir=$(dirname "$_old_target" 2>/dev/null || printf '')
		prime_agent_binary_rollback_version="$_old_version_dir"
	fi

	# Atomically switch the symlink, then verify the activated path. If activation
	# fails, restore the previous immutable version before returning an error.
	prime_agent_binary_atomic_symlink "$_binary_path" "$prime_agent_binary_symlink"
	if ! prime_agent_binary_smoke_binary "$prime_agent_binary_symlink"; then
		if prime_agent_binary_rollback; then
			rm -rf "$_version_dir"
			printf 'error: activation failed; restored the previous Prime Agent version.\n' >&2
		else
			printf 'error: activation failed and no healthy rollback version was available.\n' >&2
		fi
		rm -rf "$_download_dir"
		prime_agent_download_dir=
		exit 1
	fi

	rm -rf "$_download_dir"
	prime_agent_download_dir=

	if [ "$prime_agent_screen_enabled" = 1 ]; then
		prime_agent_screen "Prime Agent updated" "" "v$_update_version installed." ""
	else
		printf '\nPrime Agent was updated to v%s.\n' "$_update_version"
	fi

	prime_agent_configure_binary_path "$_update_version"
}

prime_agent_binary_rollback() {
	if [ -z "$prime_agent_binary_rollback_version" ] || [ ! -d "$prime_agent_binary_rollback_version" ]; then
		return 1
	fi
	_rollback_binary=
	if [ -f "$prime_agent_binary_rollback_version/pi" ]; then
		_rollback_binary="$prime_agent_binary_rollback_version/pi"
	elif [ -f "$prime_agent_binary_rollback_version/$prime_agent_cmd" ]; then
		_rollback_binary="$prime_agent_binary_rollback_version/$prime_agent_cmd"
	fi
	if [ -z "$_rollback_binary" ] || [ ! -x "$_rollback_binary" ]; then
		return 1
	fi
	prime_agent_binary_atomic_symlink "$_rollback_binary" "$prime_agent_binary_symlink"
}

prime_agent_verify_binary_checksum() {
	_checksums_path="$1"
	_artifact_path="$2"
	_checksum_dir=$(dirname "$_artifact_path")
	_artifact_name=$(basename "$_artifact_path")
	_selected_checksums_path="$_checksum_dir/SHA256SUMS.selected"

	if ! awk -v file="$_artifact_name" '$2 == file { print; found = 1; exit } END { if (!found) exit 1 }' 		"$_checksums_path" >"$_selected_checksums_path"; then
		printf 'error: checksum for %s was not found in %s\n' "$_artifact_name" "$_checksums_path" >&2
		exit 1
	fi

	if command -v sha256sum >/dev/null 2>&1; then
		prime_agent_run_quiet_with_animation 			"Verifying download" 			"Verifying Prime Agent download" 			"Checking SHA-256." 			prime_agent_run_checksum_check "$_checksum_dir" "$(basename "$_selected_checksums_path")" sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		prime_agent_run_quiet_with_animation 			"Verifying download" 			"Verifying Prime Agent download" 			"Checking SHA-256." 			prime_agent_run_checksum_check "$_checksum_dir" "$(basename "$_selected_checksums_path")" shasum
	else
		printf 'error: sha256sum or shasum is required to verify the download.\n' >&2
		exit 1
	fi
}

prime_agent_configure_binary_path() {
	_installed_version="${1:-}"

	if command -v "$prime_agent_cmd" >/dev/null 2>&1; then
		_existing_path="$(command -v "$prime_agent_cmd")"
		if [ "$_existing_path" = "$prime_agent_binary_symlink" ]; then
			if [ "$prime_agent_screen_enabled" = 1 ]; then
				prime_agent_screen "Prime Agent installed" "" "Run it with: $prime_agent_cmd" ""
			else
				printf '\nRun it with: %s\n' "$prime_agent_cmd"
			fi
			return
		fi
	fi

	_bin_dir=$(dirname "$prime_agent_binary_symlink")
	if [ -n "${_existing_path:-}" ] && [ "$_existing_path" != "$prime_agent_binary_symlink" ]; then
		printf 'warning: %s at %s currently shadows the new binary at %s.\n' \
			"$prime_agent_cmd" "$_existing_path" "$prime_agent_binary_symlink" >&2
	fi

	if [ "$prime_agent_screen_enabled" = 1 ]; then
		prime_agent_screen "Prime Agent installed" "" "PATH update needed for $prime_agent_cmd." ""
		prime_agent_restore_terminal
	else
		printf '\nPrime Agent was installed to %s.\n' "$_bin_dir"
	fi

	_profile=$(detect_shell_profile)
	if [ -n "$_profile" ] && [ -w "$_profile" ] 2>/dev/null; then
		if ! grep -q "$_bin_dir" "$_profile" 2>/dev/null; then
			printf '\nexport PATH="%s:$PATH"\n' "$_bin_dir" >> "$_profile"
			printf 'Added %s to %s.\n' "$_bin_dir" "$_profile"
		fi
		printf '\nRestart your shell or run: export PATH="%s:$PATH" && %s\n' "$_bin_dir" "$prime_agent_cmd"
	else
		printf '\nAdd to your shell profile:\n'
		printf '  export PATH="%s:$PATH"\n' "$_bin_dir"
		printf '\nThen restart your shell and run: %s\n' "$prime_agent_cmd"
	fi
}

# =============================================================================
# NPM Install Path (extracted from main)
# =============================================================================


main "$@"
