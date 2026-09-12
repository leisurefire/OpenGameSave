use serde_json::{Map, Value};
use std::path::Path;

pub(super) fn read(path: &Path) -> Value {
    super::read_bounded(path, super::MAX_MANIFEST_BYTES)
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| parse(&s).ok())
        .unwrap_or(Value::Null)
}

pub(super) fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .as_object()
        .and_then(|o| {
            o.iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value)
        })
        .unwrap_or(&Value::Null)
}

pub(super) fn parse(input: &str) -> Result<Value, String> {
    let mut tokens = Vec::new();
    let mut chars = input.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '/' && chars.peek() == Some(&'/') {
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
            continue;
        }
        if c == '{' || c == '}' {
            tokens.push(c.to_string());
            continue;
        }
        let mut token = String::new();
        if c == '"' {
            let mut closed = false;
            while let Some(c) = chars.next() {
                if c == '"' {
                    closed = true;
                    break;
                }
                if c == '\\' && matches!(chars.peek(), Some('"' | '\\')) {
                    token.push(chars.next().unwrap());
                } else {
                    token.push(c);
                }
            }
            if !closed {
                return Err("Unterminated VDF string".into());
            }
        } else {
            token.push(c);
            while chars
                .peek()
                .is_some_and(|c| !c.is_whitespace() && *c != '{' && *c != '}')
            {
                token.push(chars.next().unwrap());
            }
        }
        tokens.push(token);
        if tokens.len() > 200_000 {
            return Err("VDF entry limit exceeded".into());
        }
    }
    fn object(
        tokens: &[String],
        cursor: &mut usize,
        nested: bool,
        depth: usize,
    ) -> Result<Value, String> {
        if depth > 32 {
            return Err("VDF nesting limit exceeded".into());
        }
        let mut map = Map::new();
        while *cursor < tokens.len() {
            let key = &tokens[*cursor];
            *cursor += 1;
            if key == "}" {
                return if nested {
                    Ok(Value::Object(map))
                } else {
                    Err("Unexpected VDF closing brace".into())
                };
            }
            if key == "{" || *cursor >= tokens.len() {
                return Err("Invalid VDF key/value pair".into());
            }
            let value = &tokens[*cursor];
            *cursor += 1;
            let value = if value == "{" {
                object(tokens, cursor, true, depth + 1)?
            } else if value == "}" {
                return Err("Missing VDF value".into());
            } else {
                Value::String(value.clone())
            };
            map.insert(key.clone(), value);
        }
        if nested {
            Err("Unclosed VDF object".into())
        } else {
            Ok(Value::Object(map))
        }
    }
    object(&tokens, &mut 0, false, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_escaped_paths_and_comments() {
        let data =
            parse("// steam\n\"libraryfolders\" { \"1\" { \"path\" \"D:\\\\Steam\" } }").unwrap();
        assert_eq!(data["libraryfolders"]["1"]["path"], "D:\\Steam");
    }
    #[test]
    fn rejects_truncated_manifests() {
        assert!(parse("\"users\" { \"one\" \"name\"").is_err());
    }
}
