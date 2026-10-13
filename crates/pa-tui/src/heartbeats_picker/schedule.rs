//! The schedule interpreter: the small cron-field vocabulary and the
//! human-readable schedule forms the interval column and the drill-in
//! render from (the storage format stays the raw cron).

/// The interpreted form of one cron field: `*`, `*/n`, a single value,
/// or anything else the small interpreter below does not cover (lists,
/// ranges — those keep the raw expression).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CronField {
    Any,
    Step(u32),
    Value(u32),
    Other,
}

fn parse_cron_field(field: &str) -> CronField {
    if field == "*" {
        CronField::Any
    } else if let Some(step) = field.strip_prefix("*/") {
        step.parse::<u32>()
            .map_or(CronField::Other, CronField::Step)
    } else {
        field
            .parse::<u32>()
            .map_or(CronField::Other, CronField::Value)
    }
}

/// The day name for one cron day-of-week value (`0`/`7` Sunday through
/// `6` Saturday).
fn cron_day_name(value: u32) -> Option<&'static str> {
    Some(match value {
        0 | 7 => "Sunday",
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        6 => "Saturday",
        _ => return None,
    })
}

/// The human-readable form of one schedule expression for the interval
/// column (the operator's 2026-09-24 ruling: "cron format is not human
/// readable"). The storage format stays the raw cron — render-side only.
/// The natural-language schedules (`every 10m`, `in 2h`, `at <date>`)
/// pass through unchanged, the five-field cron forms interpret into
/// plain English (the stored `@hourly`/`@daily` aliases expand at
/// creation into the five-field forms), and anything the interpreter
/// cannot cover falls back to the raw expression.
#[must_use]
pub fn human_schedule(expression: &str) -> String {
    let trimmed = expression.trim();
    match trimmed {
        "@hourly" => return "hourly".to_string(),
        "@daily" | "@midnight" => return "daily".to_string(),
        "@weekly" => return "weekly".to_string(),
        "@monthly" => return "monthly".to_string(),
        "@yearly" | "@annually" => return "yearly".to_string(),
        _ => {}
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        // The passthrough stays the expression itself, trimmed: a
        // whitespace-padded wire value must never render its padding into the
        // column (or twice, via the pair's raw-append fallback).
        return trimmed.to_string();
    }
    let minute = parse_cron_field(fields[0]);
    let hour = parse_cron_field(fields[1]);
    let dom = parse_cron_field(fields[2]);
    let month = parse_cron_field(fields[3]);
    let dow = parse_cron_field(fields[4]);
    if month != CronField::Any {
        return trimmed.to_string();
    }
    let at = |h: u32, m: u32| format!("{h:02}:{m:02}");
    if dom == CronField::Any && dow == CronField::Any {
        return match (hour, minute) {
            (CronField::Any, CronField::Any | CronField::Step(1)) => "every minute".to_string(),
            (CronField::Any, CronField::Step(n)) => format!("every {n} minutes"),
            (CronField::Step(1) | CronField::Any, CronField::Value(0)) => "hourly".to_string(),
            (CronField::Step(n), CronField::Value(0)) => format!("every {n} hours"),
            (CronField::Any, CronField::Value(m)) => format!("hourly at :{m:02}"),
            (CronField::Value(h), CronField::Value(m)) => format!("daily {}", at(h, m)),
            _ => trimmed.to_string(),
        };
    }
    if dom == CronField::Any {
        if let (CronField::Value(d), CronField::Value(h), CronField::Value(m)) = (dow, hour, minute)
        {
            if let Some(day) = cron_day_name(d) {
                return format!("{day}s {}", at(h, m));
            }
        }
        return trimmed.to_string();
    }
    if dow == CronField::Any {
        if let (CronField::Value(1), CronField::Value(h), CronField::Value(m)) = (dom, hour, minute)
        {
            return format!("monthly {}", at(h, m));
        }
    }
    trimmed.to_string()
}
