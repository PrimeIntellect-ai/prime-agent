//! The type grammar shared by params, ports, and record fields.
//!
//! A type is written as a string in `machine.toml`: `text`, `int`, `float`,
//! `bool`, `file`, `json`, `enum(a, b)`, `list[T]`, or the name of a record
//! declared under `[types.<name>]`. A trailing `?` marks a slot (an output
//! or a record field) that may be absent. There is no null: an absent slot
//! is left out.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::Value;

/// One type in the grammar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Type {
    Text,
    Int,
    Float,
    Bool,
    /// A path to a file the state produced.
    File,
    /// Any JSON value, unchecked.
    Json,
    /// One of a closed set of lowercase words.
    Enum(Vec<String>),
    List(Box<Type>),
    /// A record declared under `[types.<name>]`.
    Record(String),
}

/// A type in a position that may be optional (an output or a record field).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub ty: Type,
    pub optional: bool,
}

/// The declared records: name to its fields in declaration order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Records(pub BTreeMap<String, Vec<(String, Slot)>>);

impl Records {
    #[must_use]
    pub fn fields(&self, name: &str) -> Option<&[(String, Slot)]> {
        self.0.get(name).map(Vec::as_slice)
    }
}

/// The deepest value nesting [`check_value`] walks before refusing.
const MAX_VALUE_DEPTH: usize = 64;

/// Parse a slot: a type with an optional trailing `?`.
///
/// # Errors
/// Returns the reason the text is not a type.
pub fn parse_slot(text: &str) -> Result<Slot, String> {
    let trimmed = text.trim();
    match trimmed.strip_suffix('?') {
        Some(inner) => Ok(Slot {
            ty: parse_type(inner)?,
            optional: true,
        }),
        None => Ok(Slot {
            ty: parse_type(trimmed)?,
            optional: false,
        }),
    }
}

/// Parse a type with no `?`.
///
/// # Errors
/// Returns the reason the text is not a type.
pub fn parse_type(text: &str) -> Result<Type, String> {
    let text = text.trim();
    if let Some(body) = text
        .strip_prefix("enum(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let mut values: Vec<String> = Vec::new();
        for raw in body.split(',') {
            let value = raw.trim();
            if !is_word(value) {
                return Err(format!(
                    "{text:?}: enum values are lowercase words (a-z, 0-9, _ and -), got {value:?}"
                ));
            }
            if values.iter().any(|seen| seen == value) {
                return Err(format!("{text:?}: enum value {value:?} appears twice"));
            }
            values.push(value.to_string());
        }
        return Ok(Type::Enum(values));
    }
    if let Some(inner) = text
        .strip_prefix("list[")
        .and_then(|rest| rest.strip_suffix(']'))
    {
        if inner.trim_end().ends_with('?') {
            return Err(format!(
                "{text:?}: list items cannot be optional; an absent item is left out"
            ));
        }
        return Ok(Type::List(Box::new(parse_type(inner)?)));
    }
    match text {
        "text" => Ok(Type::Text),
        "int" => Ok(Type::Int),
        "float" => Ok(Type::Float),
        "bool" => Ok(Type::Bool),
        "file" => Ok(Type::File),
        "json" => Ok(Type::Json),
        "" => Err("empty type".to_string()),
        name if is_word(name) => Ok(Type::Record(name.to_string())),
        other => Err(format!(
            "{other:?} is not a type: use text, int, float, bool, file, json, enum(a, b), list[T], \
             or a record name from [types]"
        )),
    }
}

/// A lowercase word: an enum value, a record name.
pub(crate) fn is_word(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Every record name a type refers to, outermost first.
pub(crate) fn record_names(ty: &Type) -> Vec<&str> {
    match ty {
        Type::Record(name) => vec![name.as_str()],
        Type::List(inner) => record_names(inner),
        Type::Text
        | Type::Int
        | Type::Float
        | Type::Bool
        | Type::File
        | Type::Json
        | Type::Enum(_) => Vec::new(),
    }
}

/// Check one JSON value against a type.
///
/// `path` names the value in the error (`verdict.findings[0].severity`).
///
/// # Errors
/// Returns `<path>: <reason>` for the first mismatch.
pub fn check_value(ty: &Type, value: &Value, records: &Records, path: &str) -> Result<(), String> {
    check_at(ty, value, records, path, 0)
}

fn check_at(
    ty: &Type,
    value: &Value,
    records: &Records,
    path: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_VALUE_DEPTH {
        return Err(format!(
            "{path}: nested deeper than {MAX_VALUE_DEPTH} levels"
        ));
    }
    let mismatch = || {
        Err(format!(
            "{path}: expected {}, got {}",
            describe(ty),
            json_kind(value)
        ))
    };
    match ty {
        Type::Json => Ok(()),
        Type::Text | Type::File => match value {
            Value::String(text) if matches!(ty, Type::File) && text.trim().is_empty() => {
                Err(format!("{path}: a file path cannot be empty"))
            }
            Value::String(_) => Ok(()),
            _ => mismatch(),
        },
        Type::Int => {
            if value.is_i64() || value.is_u64() {
                Ok(())
            } else {
                mismatch()
            }
        }
        Type::Float => {
            if value.is_number() {
                Ok(())
            } else {
                mismatch()
            }
        }
        Type::Bool => {
            if value.is_boolean() {
                Ok(())
            } else {
                mismatch()
            }
        }
        Type::Enum(values) => match value {
            Value::String(text) if values.iter().any(|v| v == text) => Ok(()),
            Value::String(text) => Err(format!(
                "{path}: {text:?} is not one of {}",
                values.join(", ")
            )),
            _ => mismatch(),
        },
        Type::List(item) => {
            let Value::Array(items) = value else {
                return mismatch();
            };
            for (index, entry) in items.iter().enumerate() {
                check_at(item, entry, records, &format!("{path}[{index}]"), depth + 1)?;
            }
            Ok(())
        }
        Type::Record(name) => {
            let Value::Object(object) = value else {
                return mismatch();
            };
            let Some(fields) = records.fields(name) else {
                return Err(format!("{path}: unknown record type {name:?}"));
            };
            for key in object.keys() {
                if !fields.iter().any(|(field, _)| field == key) {
                    let expected: Vec<&str> = fields.iter().map(|(f, _)| f.as_str()).collect();
                    return Err(format!(
                        "{path}: unknown field {key:?} (a {name} has {})",
                        expected.join(", ")
                    ));
                }
            }
            for (field, slot) in fields {
                let field_path = format!("{path}.{field}");
                match object.get(field) {
                    None if slot.optional => {}
                    None => return Err(format!("{field_path}: missing (a {name} requires it)")),
                    Some(Value::Null) => {
                        return Err(format!(
                            "{field_path}: null is not a value; leave an optional field out"
                        ))
                    }
                    Some(inner) => check_at(&slot.ty, inner, records, &field_path, depth + 1)?,
                }
            }
            Ok(())
        }
    }
}

fn json_kind(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => format!("bool {flag}"),
        Value::Number(number) => format!("number {number}"),
        Value::String(text) if text.chars().count() > 40 => "a string".to_string(),
        Value::String(text) => format!("string {text:?}"),
        Value::Array(_) => "a list".to_string(),
        Value::Object(_) => "an object".to_string(),
    }
}

/// A type as a reader sees it: `one of approve | rework`, `list of finding`.
#[must_use]
pub fn describe(ty: &Type) -> String {
    match ty {
        Type::Text => "text".to_string(),
        Type::Int => "an integer".to_string(),
        Type::Float => "a number".to_string(),
        Type::Bool => "true or false".to_string(),
        Type::File => "a file path".to_string(),
        Type::Json => "any JSON value".to_string(),
        Type::Enum(values) => format!("one of {}", values.join(" | ")),
        Type::List(item) => match item.as_ref() {
            Type::Text => "a list of strings".to_string(),
            Type::Int => "a list of integers".to_string(),
            Type::Float => "a list of numbers".to_string(),
            Type::Bool => "a list of booleans".to_string(),
            Type::File => "a list of file paths".to_string(),
            Type::Json => "a list of JSON values".to_string(),
            Type::Record(name) => format!("a list of {name} objects"),
            Type::Enum(_) | Type::List(_) => format!("a list; each item is {}", describe(item)),
        },
        Type::Record(name) => format!("a {name}"),
    }
}

/// A record's shape, one field per line, for a prompt's Outputs section.
#[must_use]
pub fn describe_record(name: &str, records: &Records) -> String {
    let mut out = format!("A {name} is an object with these fields:\n");
    for (field, slot) in records.fields(name).unwrap_or_default() {
        let optional = if slot.optional { " (optional)" } else { "" };
        let _ = writeln!(out, "  - `{field}`: {}{optional}", describe(&slot.ty));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn verdict_records() -> Records {
        let finding = vec![
            (
                "severity".to_string(),
                parse_slot("enum(blocker, major, minor, nit)").unwrap(),
            ),
            ("at".to_string(), parse_slot("text").unwrap()),
            ("note".to_string(), parse_slot("text?").unwrap()),
        ];
        let verdict = vec![
            (
                "decision".to_string(),
                parse_slot("enum(approve, rework)").unwrap(),
            ),
            ("findings".to_string(), parse_slot("list[finding]").unwrap()),
        ];
        Records(BTreeMap::from([
            ("finding".to_string(), finding),
            ("verdict".to_string(), verdict),
        ]))
    }

    #[test]
    fn parses_the_grammar() {
        assert_eq!(
            parse_slot("list[enum(a, b-c)]?").unwrap(),
            Slot {
                ty: Type::List(Box::new(Type::Enum(vec!["a".into(), "b-c".into()]))),
                optional: true,
            }
        );
        assert_eq!(
            parse_type("finding").unwrap(),
            Type::Record("finding".into())
        );
        for (bad, reason) in [
            ("enum(a, a)", "appears twice"),
            ("enum(A)", "lowercase words"),
            ("list[text?]", "cannot be optional"),
            ("Text", "is not a type"),
        ] {
            let error = parse_slot(bad).unwrap_err();
            assert!(error.contains(reason), "{bad}: {error}");
        }
    }

    #[test]
    fn checks_values_with_exact_paths() {
        let records = verdict_records();
        let ty = Type::Record("verdict".into());
        let good = json!({"decision": "rework", "findings": [{"severity": "nit", "at": "a.rs:1"}]});
        assert_eq!(check_value(&ty, &good, &records, "verdict"), Ok(()));
        let cases = [
            (
                json!({"decision": "rework", "findings": [{"severity": "high", "at": "a.rs:1"}]}),
                "verdict.findings[0].severity: \"high\" is not one of blocker, major, minor, nit",
            ),
            (
                json!({"decision": "rework"}),
                "verdict.findings: missing (a verdict requires it)",
            ),
            (
                json!({"decision": "rework", "findings": [], "extra": 1}),
                "verdict: unknown field \"extra\" (a verdict has decision, findings)",
            ),
            (
                json!({"decision": "rework", "findings": [{"severity": "nit", "at": "x", "note": null}]}),
                "verdict.findings[0].note: null is not a value; leave an optional field out",
            ),
            (
                json!({"decision": 3, "findings": []}),
                "verdict.decision: expected one of approve | rework, got number 3",
            ),
        ];
        for (value, expected) in cases {
            assert_eq!(
                check_value(&ty, &value, &records, "verdict"),
                Err(expected.to_string())
            );
        }
        assert_eq!(
            check_value(&Type::Int, &json!(1.5), &records, "max_loc"),
            Err("max_loc: expected an integer, got number 1.5".to_string())
        );
    }
}
