//! Tool-argument validation, the TS `validateToolArguments` contract
//! (`packages/ai/src/utils/validation.ts`).
//!
//! The TS reference validates against TypeBox schemas with `Value.Convert`
//! (primitive coercion) plus a compiled validator. This port implements the
//! JSON Schema subset that the product's tool schemas use: `type` (including
//! type arrays), `properties`, `required`, `items`, `enum`, `const`,
//! `additionalProperties: false`, and numeric bounds, with the same primitive
//! coercion behavior (`"42"` -> `42` for `type: "number"`, etc.). The error
//! message format matches the TS reference exactly so surfaced text is
//! identical.

use serde_json::Value;

/// Validates tool call arguments against the tool's JSON Schema, returning
/// the validated (and potentially coerced) arguments.
///
/// Mirrors TS `validateToolArguments(tool, toolCall)`: on failure it returns
/// the preformatted error message (TS throws `Error(message)`); the caller
/// wraps it into an error tool result.
pub fn validate_tool_arguments(
    tool_name: &str,
    schema: &Value,
    arguments: &Value,
) -> Result<Value, String> {
    let mut args = arguments.clone();
    coerce(schema, &mut args);
    let mut errors = Vec::new();
    check(schema, &args, "", &mut errors);
    if errors.is_empty() {
        return Ok(args);
    }
    let error_lines = errors
        .iter()
        .map(|(path, message)| format!("  - {path}: {message}"))
        .collect::<Vec<_>>()
        .join("\n");
    let error_lines = if error_lines.is_empty() {
        "Unknown validation error".to_string()
    } else {
        error_lines
    };
    let received =
        serde_json::to_string_pretty(arguments).unwrap_or_else(|_| arguments.to_string());
    Err(format!(
        "Validation failed for tool \"{tool_name}\":\n{error_lines}\n\nReceived arguments:\n{received}"
    ))
}

fn schema_type(schema: &Value) -> Vec<&str> {
    match schema.get("type") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// Primitive coercion mirroring TypeBox `Value.Convert`: string values are
/// parsed into number/boolean when the schema requests it, and number/boolean
/// values are stringified when the schema requests a string.
fn coerce(schema: &Value, value: &mut Value) {
    let types = schema_type(schema);
    if types.is_empty() {
        coerce_children(schema, value);
        return;
    }
    for ty in types {
        match (ty, &*value) {
            ("number", Value::String(s)) => {
                if let Ok(n) = s.trim().parse::<f64>() {
                    *value = number_value(n);
                    return coerce_children(schema, value);
                }
            }
            ("integer", Value::String(s)) => {
                if let Ok(n) = s.trim().parse::<i64>() {
                    *value = Value::from(n);
                    return coerce_children(schema, value);
                }
            }
            ("boolean", Value::String(s)) => {
                let lower = s.trim().to_ascii_lowercase();
                if lower == "true" {
                    *value = Value::Bool(true);
                    return coerce_children(schema, value);
                }
                if lower == "false" {
                    *value = Value::Bool(false);
                    return coerce_children(schema, value);
                }
            }
            ("string", Value::Number(n)) => {
                *value = Value::String(n.to_string());
                return coerce_children(schema, value);
            }
            ("string", Value::Bool(b)) => {
                *value = Value::String(b.to_string());
                return coerce_children(schema, value);
            }
            _ => {}
        }
    }
    coerce_children(schema, value);
}

fn coerce_children(schema: &Value, value: &mut Value) {
    let properties = match schema.get("properties") {
        Some(Value::Object(p)) => p.clone(),
        _ => return,
    };
    match value {
        Value::Object(map) => {
            for (key, sub_schema) in &properties {
                if let Some(v) = map.get_mut(key) {
                    coerce(sub_schema, v);
                }
            }
            // Coerce entries under `additionalProperties: { ... }` schemas too.
            if let Some(additional_schema) = schema.get("additionalProperties") {
                if additional_schema.is_object() {
                    for (key, v) in map.iter_mut() {
                        if !properties.contains_key(key) {
                            coerce(additional_schema, v);
                        }
                    }
                }
            }
        }
        Value::Array(items) => {
            if let Some(Value::Array(item_schemas)) = schema.get("items") {
                // Positional tuple validation; coerce each pair.
                for (i, item) in items.iter_mut().enumerate() {
                    if let Some(s) = item_schemas.get(i) {
                        coerce(s, item);
                    }
                }
            } else if let Some(item_schema) = schema.get("items") {
                for item in items.iter_mut() {
                    coerce(item_schema, item);
                }
            }
        }
        _ => {}
    }
}

fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.007199254740992e15 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// Instance path formatting mirroring TS `formatValidationPath`:
/// JSON pointer paths (`/a/b`) become dotted paths (`a.b`), and the empty
/// path reads as `root`.
fn format_path(path: &str) -> String {
    if path.is_empty() {
        "root".to_string()
    } else {
        path.to_string()
    }
}

/// Check `value` against `schema`, appending `(path, message)` errors.
fn check(schema: &Value, value: &Value, path: &str, errors: &mut Vec<(String, String)>) {
    let types = schema_type(schema);
    if !types.is_empty() && !types.iter().any(|ty| type_matches(ty, value)) {
        let expected = types.join("/");
        let found = type_name(value);
        let base = format_path(path);
        errors.push((base, format!("Expected {expected}, received {found}")));
        // Type mismatch: deeper checks would only add noise.
        return;
    }

    if let Some(Value::Array(enum_values)) = schema.get("enum") {
        if !enum_values.iter().any(|allowed| allowed == value) {
            let base = format_path(path);
            errors.push((
                base,
                "Value did not match any of the expected enum values".to_string(),
            ));
        }
    }
    if let Some(expected_const) = schema.get("const") {
        if expected_const != value {
            let base = format_path(path);
            errors.push((
                base,
                "Value did not match the expected const value".to_string(),
            ));
        }
    }

    match value {
        Value::Object(map) => {
            if types.contains(&"object") || schema.get("properties").is_some() {
                if let Some(Value::Object(properties)) = schema.get("properties") {
                    for (key, sub_schema) in properties {
                        let sub_path = if path.is_empty() {
                            key.clone()
                        } else {
                            format!("{path}.{key}")
                        };
                        match map.get(key) {
                            Some(v) => check(sub_schema, v, &sub_path, errors),
                            None => {
                                // Optional properties are skipped, mirroring
                                // standard JSON Schema.
                            }
                        }
                    }
                }
                if let Some(Value::Array(required)) = schema.get("required") {
                    for req in required.iter().filter_map(Value::as_str) {
                        if !map.contains_key(req) {
                            let base = format_path(path);
                            errors.push((base, format!("Required property '{req}' is missing")));
                        }
                    }
                }
                if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
                    if let Some(Value::Object(properties)) = schema.get("properties") {
                        for key in map.keys() {
                            if !properties.contains_key(key) {
                                let sub_path = if path.is_empty() {
                                    key.clone()
                                } else {
                                    format!("{path}.{key}")
                                };
                                errors.push((
                                    sub_path,
                                    "Property is not allowed by additionalProperties".to_string(),
                                ));
                            }
                        }
                    }
                }
            }
        }
        Value::Array(items) => {
            if let Some(Value::Array(item_schemas)) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    let sub_path = if path.is_empty() {
                        index.to_string()
                    } else {
                        format!("{path}.{index}")
                    };
                    if let Some(sub_schema) = item_schemas.get(index) {
                        check(sub_schema, item, &sub_path, errors);
                    }
                }
            } else if let Some(item_schema) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    let sub_path = if path.is_empty() {
                        index.to_string()
                    } else {
                        format!("{path}.{index}")
                    };
                    check(item_schema, item, &sub_path, errors);
                }
            }
        }
        Value::Number(n) => {
            if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
                if n.as_f64().unwrap_or(f64::MIN) < min {
                    let base = format_path(path);
                    errors.push((
                        base,
                        format!("Expected value to be greater than or equal to {min}"),
                    ));
                }
            }
            if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
                if n.as_f64().unwrap_or(f64::MAX) > max {
                    let base = format_path(path);
                    errors.push((
                        base,
                        format!("Expected value to be less than or equal to {max}"),
                    ));
                }
            }
        }
        _ => {}
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                "integer"
            } else {
                "number"
            }
        }
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn type_matches(ty: &str, value: &Value) -> bool {
    match ty {
        "any" | "unknown" => true,
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "string" => value.is_string(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => true,
    }
}
