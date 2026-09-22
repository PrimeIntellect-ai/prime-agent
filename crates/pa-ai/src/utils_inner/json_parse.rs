//! JSON parsing with repair and partial (streaming) tolerance.
//! Ported from `packages/ai/src/utils/json-parse.ts`. The partial parser
//! reproduces the semantics of the npm `partial-json` package used by the TS
//! reference: return the longest usable prefix of truncated JSON (truncated
//! strings keep their content, truncated containers are closed, incomplete
//! keys/values are dropped), and fail only on genuinely invalid input.

use serde_json::{Map, Value};

const VALID_JSON_ESCAPES: [char; 8] = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't'];

fn is_control_character(ch: char) -> bool {
    (ch as u32) <= 0x1f
}

fn escape_control_character(ch: char) -> String {
    match ch {
        '\u{0008}' => "\\b".to_string(),
        '\u{000C}' => "\\f".to_string(),
        '\n' => "\\n".to_string(),
        '\r' => "\\r".to_string(),
        '\t' => "\\t".to_string(),
        other => format!("\\u{:04x}", other as u32),
    }
}

/// Repairs malformed JSON string literals by:
/// - escaping raw control characters inside strings
/// - doubling backslashes before invalid escape characters
pub fn repair_json(json: &str) -> String {
    let mut repaired = String::with_capacity(json.len());
    let mut in_string = false;
    let chars: Vec<char> = json.chars().collect();
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];

        if !in_string {
            repaired.push(ch);
            if ch == '"' {
                in_string = true;
            }
            index += 1;
            continue;
        }

        if ch == '"' {
            repaired.push(ch);
            in_string = false;
            index += 1;
            continue;
        }

        if ch == '\\' {
            let next_char = chars.get(index + 1).copied();
            match next_char {
                None => {
                    repaired.push_str("\\\\");
                }
                Some('u') => {
                    let digits: String = chars[index + 2..(index + 6).min(chars.len())]
                        .iter()
                        .collect();
                    let digits_ok = chars.len() >= index + 6
                        && digits.len() == 4
                        && digits.chars().all(|c| c.is_ascii_hexdigit());
                    if digits_ok {
                        repaired.push_str(&format!("\\u{digits}"));
                        index += 5;
                        continue;
                    }
                    repaired.push_str("\\\\");
                }
                Some(next) if VALID_JSON_ESCAPES.contains(&next) => {
                    repaired.push('\\');
                    repaired.push(next);
                    index += 1;
                }
                Some(_) => {
                    repaired.push_str("\\\\");
                }
            }
            index += 1;
            continue;
        }

        if is_control_character(ch) {
            repaired.push_str(&escape_control_character(ch));
        } else {
            repaired.push(ch);
        }
        index += 1;
    }

    repaired
}

/// Parse JSON; when parsing fails, retry once against the repaired text.
pub fn parse_json_with_repair(json: &str) -> Result<Value, serde_json::Error> {
    match serde_json::from_str::<Value>(json) {
        Ok(value) => Ok(value),
        Err(error) => {
            let repaired = repair_json(json);
            if repaired != json {
                serde_json::from_str::<Value>(&repaired)
            } else {
                Err(error)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ParseError {
    /// Genuinely invalid JSON (not just truncated).
    Invalid,
    /// Input ended in the middle of a literal or container member: the member
    /// is unusable but the enclosing prefix is recoverable.
    Truncated,
}

/// Tolerant partial-JSON parser. `Ok` means a usable value was recovered
/// (possibly a partial one); `Err(ParseError::Invalid)` means the input is not
/// parseable JSON even with truncation tolerance.
pub fn parse_partial_json(input: &str) -> Result<Value, ParseError> {
    let mut parser = PartialParser {
        chars: input.chars().collect(),
        pos: 0,
    };
    parser.skip_whitespace();
    let value = match parser.parse_value() {
        Ok(value) => value,
        Err(ParseError::Truncated) => return Err(ParseError::Invalid),
        Err(error) => return Err(error),
    };
    parser.skip_whitespace();
    // Trailing non-whitespace input is invalid, matching strict JSON.
    if parser.pos < parser.chars.len() {
        return Err(ParseError::Invalid);
    }
    Ok(value)
}

struct PartialParser {
    chars: Vec<char>,
    pos: usize,
}

impl PartialParser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.pos += 1;
        }
    }

    fn parse_value(&mut self) -> Result<Value, ParseError> {
        match self.peek() {
            None => Err(ParseError::Invalid),
            Some('{') => self.parse_object(),
            Some('[') => self.parse_array(),
            Some('"') => self.parse_string().map(|(value, _)| Value::String(value)),
            Some('t') => self.parse_literal("true", Value::Bool(true)),
            Some('f') => self.parse_literal("false", Value::Bool(false)),
            Some('n') => self.parse_literal("null", Value::Null),
            Some(ch) if ch == '-' || ch.is_ascii_digit() => self.parse_number(),
            Some(_) => Err(ParseError::Invalid),
        }
    }

    fn parse_literal(&mut self, text: &str, value: Value) -> Result<Value, ParseError> {
        let literal_chars: Vec<char> = text.chars().collect();
        for expected in literal_chars {
            match self.bump() {
                Some(actual) if actual == expected => {}
                // Truncated literal at EOF: the value is dropped, but the
                // enclosing container prefix remains usable.
                None => return Err(ParseError::Truncated),
                Some(_) => return Err(ParseError::Invalid),
            }
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<Value, ParseError> {
        let start = self.pos;
        while matches!(self.peek(), Some('0'..='9' | '-' | '+' | '.' | 'e' | 'E')) {
            self.pos += 1;
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        let mut candidate = text.as_str();
        // Take the longest prefix that is a valid JSON number.
        while !candidate.is_empty() {
            if serde_json::from_str::<f64>(candidate).is_ok() {
                break;
            }
            candidate = candidate.trim_end_matches(['.', 'e', 'E', '+', '-']);
            if !candidate.is_empty() && serde_json::from_str::<f64>(candidate).is_ok() {
                break;
            }
            if candidate.len() > 1 {
                candidate = &candidate[..candidate.len() - 1];
            } else {
                candidate = "";
            }
        }
        if candidate.is_empty() {
            return Err(ParseError::Invalid);
        }
        let number = serde_json::from_str::<f64>(candidate).map_err(|_| ParseError::Invalid)?;
        // When the number was truncated mid-literal ("12.", "1e"), consume the
        // whole fragment so the trailing remainder is treated as truncation
        // rather than invalid trailing input.
        self.pos = if candidate.len() == text.len() {
            start + candidate.len()
        } else {
            start + text.len()
        };
        // Keep integers as integers so partial parses compare equal to the
        // strict-JSON representation (the npm partial-json package produces
        // JS numbers, which are indistinguishable between 12 and 12.0).
        if !candidate.contains('.') && !candidate.contains('e') && !candidate.contains('E') {
            if let Ok(int) = candidate.parse::<i64>() {
                return Ok(Value::Number(int.into()));
            }
        }
        Ok(Value::Number(
            serde_json::Number::from_f64(number).ok_or(ParseError::Invalid)?,
        ))
    }

    /// Parse a string. Returns the content plus whether the closing quote was
    /// seen (false when EOF truncated the string).
    fn parse_string(&mut self) -> Result<(String, bool), ParseError> {
        // Consume opening quote.
        self.bump();
        let mut out = String::new();
        loop {
            match self.bump() {
                None => return Ok((out, false)),
                Some('"') => return Ok((out, true)),
                Some('\\') => match self.bump() {
                    None => return Ok((out, false)),
                    Some(esc) => match esc {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{0008}'),
                        'f' => out.push('\u{000C}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let mut code = String::new();
                            for _ in 0..4 {
                                match self.bump() {
                                    Some(c) if c.is_ascii_hexdigit() => code.push(c),
                                    // Truncated escape: keep what we have.
                                    None => return Ok((out, false)),
                                    Some(_) => return Err(ParseError::Invalid),
                                }
                            }
                            let value =
                                u16::from_str_radix(&code, 16).map_err(|_| ParseError::Invalid)?;
                            if (0xD800..0xDC00).contains(&value) {
                                // High surrogate: expect a following low surrogate escape.
                                let lookahead = self.pos + 1 < self.chars.len()
                                    && self.chars[self.pos] == '\\'
                                    && self.chars.get(self.pos + 1) == Some(&'u');
                                if lookahead {
                                    let save = self.pos;
                                    self.pos += 2;
                                    let mut low = String::new();
                                    let mut complete = true;
                                    for _ in 0..4 {
                                        match self.bump() {
                                            Some(c) if c.is_ascii_hexdigit() => low.push(c),
                                            None => {
                                                complete = false;
                                                break;
                                            }
                                            Some(_) => return Err(ParseError::Invalid),
                                        }
                                    }
                                    if complete {
                                        if let Ok(low_value) = u16::from_str_radix(&low, 16) {
                                            if (0xDC00..0xE000).contains(&low_value) {
                                                let combined = 0x10000
                                                    + ((value as u32 - 0xD800) << 10)
                                                    + (low_value as u32 - 0xDC00);
                                                if let Some(ch) = char::from_u32(combined) {
                                                    out.push(ch);
                                                    continue;
                                                }
                                            }
                                        }
                                    } else {
                                        self.pos = save;
                                        return Ok((out, false));
                                    }
                                    // Invalid surrogate pair content.
                                    return Err(ParseError::Invalid);
                                }
                                // Lone high surrogate kept as replacement char.
                                out.push('\u{FFFD}');
                            } else if (0xDC00..0xE000).contains(&value) {
                                out.push('\u{FFFD}');
                            } else if let Some(ch) = char::from_u32(value as u32) {
                                out.push(ch);
                            }
                        }
                        _ => return Err(ParseError::Invalid),
                    },
                },
                Some(ch) => out.push(ch),
            }
        }
    }

    fn parse_array(&mut self) -> Result<Value, ParseError> {
        self.bump(); // '['
        let mut items: Vec<Value> = Vec::new();
        loop {
            self.skip_whitespace();
            match self.peek() {
                None => return Ok(Value::Array(items)),
                Some(']') => {
                    self.bump();
                    return Ok(Value::Array(items));
                }
                Some(',') if items.is_empty() => return Err(ParseError::Invalid),
                Some(',') => {
                    // Trailing comma before EOF or ']': tolerate at EOF.
                    self.bump();
                    self.skip_whitespace();
                    match self.peek() {
                        None => return Ok(Value::Array(items)),
                        Some(']') => {
                            self.bump();
                            return Ok(Value::Array(items));
                        }
                        Some(_) => continue,
                    }
                }
                Some(_) => {}
            }
            match self.parse_value() {
                Ok(value) => items.push(value),
                // Truncated member at EOF: drop it and close the array.
                Err(ParseError::Truncated) => {
                    self.pos = self.chars.len();
                    return Ok(Value::Array(items));
                }
                Err(ParseError::Invalid) => return Err(ParseError::Invalid),
            }
            self.skip_whitespace();
            match self.peek() {
                None => return Ok(Value::Array(items)),
                Some(',') => {
                    self.bump();
                }
                Some(']') => {
                    self.bump();
                    return Ok(Value::Array(items));
                }
                Some(_) => return Err(ParseError::Invalid),
            }
        }
    }

    fn parse_object(&mut self) -> Result<Value, ParseError> {
        self.bump(); // '{'
        let mut object: Map<String, Value> = Map::new();
        loop {
            self.skip_whitespace();
            match self.peek() {
                None => return Ok(Value::Object(object)),
                Some('}') => {
                    self.bump();
                    return Ok(Value::Object(object));
                }
                Some(',') if !object.is_empty() => {
                    self.bump();
                    self.skip_whitespace();
                    match self.peek() {
                        None => return Ok(Value::Object(object)),
                        Some('}') => {
                            self.bump();
                            return Ok(Value::Object(object));
                        }
                        Some(_) => continue,
                    }
                }
                Some('"') => {}
                Some(_) => return Err(ParseError::Invalid),
            }

            // Key: on EOF inside the key string the pair is dropped.
            let (key, key_closed) = match self.parse_string() {
                Ok(result) => result,
                // parse_string never fails on truncation, only on invalid
                // escape sequences inside the key.
                Err(_) => return Err(ParseError::Invalid),
            };
            self.skip_whitespace();
            if !key_closed || self.peek() != Some(':') {
                // Truncated before a value: drop the pair, close the object.
                self.pos = self.chars.len();
                return Ok(Value::Object(object));
            }
            self.bump(); // ':'
            self.skip_whitespace();
            // Special case: EOF right after the colon drops the pair.
            if self.peek().is_none() {
                self.pos = self.chars.len();
                return Ok(Value::Object(object));
            }
            let value = match self.parse_value() {
                Ok(value) => value,
                // Truncated value at EOF: drop the pair and close the object.
                Err(ParseError::Truncated) => {
                    self.pos = self.chars.len();
                    return Ok(Value::Object(object));
                }
                Err(ParseError::Invalid) => return Err(ParseError::Invalid),
            };
            object.insert(key, value);
            self.skip_whitespace();
            match self.peek() {
                None => return Ok(Value::Object(object)),
                Some(',') => {
                    self.bump();
                }
                Some('}') => {
                    self.bump();
                    return Ok(Value::Object(object));
                }
                Some(_) => return Err(ParseError::Invalid),
            }
        }
    }
}

/// Attempts to parse potentially incomplete JSON during streaming.
/// Always returns a valid object, even if the JSON is incomplete.
pub fn parse_streaming_json(partial_json: Option<&str>) -> Value {
    let Some(partial_json) = partial_json else {
        return Value::Object(Map::new());
    };
    if partial_json.trim().is_empty() {
        return Value::Object(Map::new());
    }

    if let Ok(value) = parse_json_with_repair(partial_json) {
        return value;
    }
    if let Ok(value) = parse_partial_json(partial_json) {
        return value;
    }
    let repaired = repair_json(partial_json);
    if let Ok(value) = parse_partial_json(&repaired) {
        return value;
    }
    Value::Object(Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_complete_json() {
        assert_eq!(parse_streaming_json(Some(r#"{"a":1}"#)), json!({"a": 1}));
    }

    #[test]
    fn repairs_invalid_escapes() {
        // \q is invalid; repair doubles the backslash.
        assert_eq!(
            parse_json_with_repair(r#"{"a":"\q"}"#).unwrap(),
            json!({"a": "\\q"})
        );
        // Raw control characters get escaped.
        assert_eq!(
            parse_json_with_repair("{\"a\":\"x\ny\"}").unwrap(),
            json!({"a": "x\ny"})
        );
    }

    #[test]
    fn parses_partial_strings() {
        assert_eq!(
            parse_partial_json("{\"a\": \"b").unwrap(),
            json!({"a": "b"})
        );
        assert_eq!(parse_partial_json("[1, 2, 3").unwrap(), json!([1, 2, 3]));
        assert_eq!(
            parse_partial_json("{\"arr\": [1, 2").unwrap(),
            json!({"arr": [1, 2]})
        );
    }

    #[test]
    fn drops_incomplete_keys_and_literals() {
        assert_eq!(parse_partial_json("{\"a\"").unwrap(), json!({}));
        assert_eq!(parse_partial_json("{\"a\": tru").unwrap(), json!({}));
        assert_eq!(
            parse_partial_json("{\"name\": \"John\", \"ag").unwrap(),
            json!({"name": "John"})
        );
    }

    #[test]
    fn parses_partial_numbers() {
        assert_eq!(parse_partial_json("[12").unwrap(), json!([12]));
        assert_eq!(parse_partial_json("{\"n\": 12.").unwrap(), json!({"n": 12}));
        assert_eq!(parse_partial_json("{\"n\": 1e").unwrap(), json!({"n": 1}));
    }

    #[test]
    fn fails_on_invalid_input() {
        assert!(parse_partial_json("xyz").is_err());
        assert!(parse_partial_json("{").is_ok()); // empty object partial
        assert!(parse_partial_json("{\"a\": @}").is_err());
    }

    #[test]
    fn streaming_fallback_returns_object() {
        assert_eq!(parse_streaming_json(None), json!({}));
        assert_eq!(parse_streaming_json(Some("  ")), json!({}));
        assert_eq!(parse_streaming_json(Some("garbage {")), json!({}));
    }
}
