//! Emacs-style kill ring (port of `packages/tui/src/kill-ring.ts`).

#[derive(Debug, Clone, Default)]
pub struct KillRing {
    ring: Vec<String>,
}

impl KillRing {
    pub fn push(&mut self, text: &str, prepend: bool, accumulate: bool) {
        if text.is_empty() {
            return;
        }
        if accumulate && !self.ring.is_empty() {
            let last = self.ring.pop().unwrap_or_default();
            let merged = if prepend {
                format!("{text}{last}")
            } else {
                format!("{last}{text}")
            };
            self.ring.push(merged);
        } else {
            self.ring.push(text.to_string());
        }
    }
    pub fn peek(&self) -> Option<&str> {
        self.ring.last().map(String::as_str)
    }
    pub fn rotate(&mut self) {
        if self.ring.len() > 1 {
            let last = self.ring.pop().unwrap_or_default();
            self.ring.insert(0, last);
        }
    }
    pub fn len(&self) -> usize {
        self.ring.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ring.is_empty()
    }
}
