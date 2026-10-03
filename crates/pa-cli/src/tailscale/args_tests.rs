//! argv-parsing tests: every accepted form and every rejected one (a serve
//! without `--port` never guesses a default; `--json` is status-only).

use super::super::*;
use super::*;

#[test]
fn parse_requires_a_port_for_serve_and_never_guesses_a_default() {
    assert!(matches!(
        parse_tailscale_args(&args(&["serve"])),
        TailscaleArgs::Error(_)
    ));
    assert!(matches!(
        parse_tailscale_args(&args(&["--funnel"])),
        TailscaleArgs::Error(_)
    ));
}

#[test]
fn parse_accepts_port_forms_and_funnel_together() {
    assert_eq!(
        parse_tailscale_args(&args(&["serve", "--port", "3000"])),
        TailscaleArgs::Serve {
            port: 3000.0,
            funnel: false
        }
    );
    assert_eq!(
        parse_tailscale_args(&args(&["serve", "--port=3000"])),
        TailscaleArgs::Serve {
            port: 3000.0,
            funnel: false
        }
    );
    assert_eq!(
        parse_tailscale_args(&args(&["--port", "3000", "--funnel"])),
        TailscaleArgs::Serve {
            port: 3000.0,
            funnel: true
        }
    );
    assert!(matches!(
        parse_tailscale_args(&args(&["--port", "abc"])),
        TailscaleArgs::Error(_)
    ));
}

#[test]
fn parse_treats_no_args_as_status_honors_json_and_rejects_unknown_subcommands() {
    assert_eq!(
        parse_tailscale_args(&args(&[])),
        TailscaleArgs::Status { json: false }
    );
    assert_eq!(
        parse_tailscale_args(&args(&["status", "--json"])),
        TailscaleArgs::Status { json: true }
    );
    assert!(matches!(
        parse_tailscale_args(&args(&["bogus"])),
        TailscaleArgs::Error(_)
    ));
}

#[test]
fn parse_rejects_json_with_serve_instead_of_silently_serving() {
    match parse_tailscale_args(&args(&["serve", "--port", "3000", "--json"])) {
        TailscaleArgs::Error(message) => {
            assert!(
                message.contains("--json is only supported for status"),
                "{message}"
            );
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        parse_tailscale_args(&args(&["--json", "--port", "3000"])),
        TailscaleArgs::Error(_)
    ));
}

#[test]
fn parse_rejects_unconsumed_repeated_and_conflicting_arguments() {
    // "--funnel false" must NOT be parsed as funnel: true (public exposure!).
    assert!(matches!(
        parse_tailscale_args(&args(&["serve", "--port", "3000", "--funnel", "false"])),
        TailscaleArgs::Error(_)
    ));
    assert!(matches!(
        parse_tailscale_args(&args(&["serve", "--port", "3000", "--port", "4000"])),
        TailscaleArgs::Error(_)
    ));
    assert!(matches!(
        parse_tailscale_args(&args(&["serve", "--funel", "--port", "3000"])),
        TailscaleArgs::Error(_)
    ));
    assert!(matches!(
        parse_tailscale_args(&args(&["status", "--port", "3000"])),
        TailscaleArgs::Error(_)
    ));
    match parse_tailscale_args(&args(&["serve"])) {
        TailscaleArgs::Error(message) => assert!(message.contains("requires --port"), "{message}"),
        other => panic!("{other:?}"),
    }
}
