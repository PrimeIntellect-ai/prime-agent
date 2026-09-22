//! Filesystem collectors for resource discovery: recursive file collection
//! under `.gitignore`/`.ignore`/`.fdignore` rules, skill-entry scanning with
//! the `SKILL.md` stopping rule, extension/prompt/theme auto-discovery, the
//! `.agents/skills` ancestor scan, and the extension entry-point resolution.

use std::path::{Path, PathBuf};

use globset::GlobBuilder;

use super::super::source::path_relative;

/// Ignore-file names consulted during resource discovery.
const IGNORE_FILE_NAMES: [&str; 3] = [".gitignore", ".ignore", ".fdignore"];

/// Skill discovery styles: `pi` reads root markdown skills in addition to
/// `SKILL.md` packages; `agents` only reads `SKILL.md` packages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkillDiscoveryMode {
    Pi,
    Agents,
}

/// One directory entry: name, path, and whether it is a symlink (classified
/// through the target, matching the TS `statSync`-after-readdir flow).
struct DirEntry {
    name: String,
    path: PathBuf,
}

fn read_entries_sorted(dir: &Path) -> Vec<DirEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<DirEntry> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path(),
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

/// Follow symlinks: classify an entry as (is_dir, is_file); unreadable
/// symlinks classify as nothing.
fn classify(path: &Path) -> (bool, bool) {
    match std::fs::metadata(path) {
        Ok(meta) => (meta.is_dir(), meta.is_file()),
        Err(_) => (false, false),
    }
}

fn is_node_modules(name: &str, skip_node_modules: bool) -> bool {
    skip_node_modules && name == "node_modules"
}

/// One parsed ignore-file rule.
struct IgnoreRule {
    glob: Option<globset::GlobMatcher>,
    anchored: bool,
    negated: bool,
    dir_only: bool,
}

/// Ordered gitignore-style rule set, added incrementally as the walk enters
/// nested directories (patterns from nested files are prefixed with their
/// directory, so a single root-relative matcher stays correct).
pub(crate) struct IgnoreMatcher {
    rules: Vec<IgnoreRule>,
}

impl IgnoreMatcher {
    pub(crate) fn new() -> Self {
        Self { rules: Vec::new() }
    }

    /// Add the ignore-file rules found in `dir` (relative to `root`).
    pub(crate) fn add_rules(&mut self, dir: &Path, root: &Path) {
        let relative_dir = path_relative(root, dir);
        let prefix = if relative_dir.is_empty() {
            String::new()
        } else {
            format!("{relative_dir}/")
        };
        for filename in IGNORE_FILE_NAMES {
            let Ok(content) = std::fs::read_to_string(dir.join(filename)) else {
                continue;
            };
            for line in content.split('\n').flat_map(|line| line.split('\r')) {
                if let Some(pattern) = prefix_ignore_pattern(line, &prefix) {
                    self.add_pattern(&pattern);
                }
            }
        }
    }

    fn add_pattern(&mut self, line: &str) {
        let mut pattern = line;
        let negated = pattern.starts_with('!');
        if negated {
            pattern = &pattern[1..];
        }
        let dir_only = pattern.ends_with('/');
        if dir_only {
            pattern = pattern.strip_suffix('/').unwrap_or(pattern);
        }
        let anchored = pattern.contains('/');
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .backslash_escape(true)
            .build()
            .map(|glob| glob.compile_matcher())
            .ok();
        self.rules.push(IgnoreRule {
            glob,
            anchored,
            negated,
            dir_only,
        });
    }

    /// True when the root-relative path is ignored. Dirs pass `is_dir` true
    /// (the TS side passes trailing-slash paths).
    pub(crate) fn ignores(&self, rel_path: &str, is_dir: bool) -> bool {
        let path = rel_path.strip_suffix('/').unwrap_or(rel_path);
        let segments: Vec<&str> = path.split('/').collect();
        for rule in self.rules.iter().rev() {
            let Some(matcher) = rule.glob.as_ref() else {
                continue;
            };
            if rule.dir_only && !is_dir {
                continue;
            }
            let matched = if rule.anchored {
                matcher.is_match(path)
            } else {
                // Unanchored patterns match at any depth.
                segments
                    .iter()
                    .enumerate()
                    .any(|(index, _)| matcher.is_match(segments[index..].join("/")))
            };
            if matched {
                return !rule.negated;
            }
        }
        false
    }
}

/// Prepare one ignore-file line for the root-relative matcher: comments drop,
/// `!`/`\!` negation/escape prefixes and leading `/` anchors normalize, and
/// nested-directory patterns get their directory prefix. Returns the
/// negation-prefixed pattern (or `None` for blank/comment lines).
fn prefix_ignore_pattern(line: &str, prefix: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('#') && !trimmed.starts_with("\\#") {
        return None;
    }

    let mut pattern = line;
    let mut negated = false;
    if let Some(rest) = pattern.strip_prefix('!') {
        negated = true;
        pattern = rest;
    } else if let Some(rest) = pattern.strip_prefix("\\!") {
        pattern = rest;
    }
    if let Some(rest) = pattern.strip_prefix('/') {
        pattern = rest;
    }

    let prefixed = if prefix.is_empty() {
        pattern.to_string()
    } else {
        format!("{prefix}{pattern}")
    };
    if negated {
        Some(format!("!{prefixed}"))
    } else {
        Some(prefixed)
    }
}

/// File-name suffixes recognized per resource type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileKind {
    Extension,
    Markdown,
    Json,
}

impl FileKind {
    fn matches(self, name: &str) -> bool {
        match self {
            FileKind::Extension => name.ends_with(".ts") || name.ends_with(".js"),
            FileKind::Markdown => name.ends_with(".md"),
            FileKind::Json => name.ends_with(".json"),
        }
    }
}

/// Collect all files of a kind under `dir`, honoring ignore rules and
/// skipping dotfiles and `node_modules`.
pub(crate) fn collect_files(dir: &Path, kind: FileKind) -> Vec<PathBuf> {
    let mut matcher = IgnoreMatcher::new();
    collect_files_inner(dir, kind, true, &mut matcher, dir)
}

fn collect_files_inner(
    dir: &Path,
    kind: FileKind,
    skip_node_modules: bool,
    matcher: &mut IgnoreMatcher,
    root: &Path,
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !dir.exists() {
        return files;
    }
    matcher.add_rules(dir, root);
    for entry in read_entries_sorted(dir) {
        if entry.name.starts_with('.') {
            continue;
        }
        if is_node_modules(&entry.name, skip_node_modules) {
            continue;
        }
        let (is_dir, is_file) = classify(&entry.path);
        let rel_path = path_relative(root, &entry.path);
        if matcher.ignores(&rel_path, is_dir) {
            continue;
        }
        if is_dir {
            files.extend(collect_files_inner(
                &entry.path,
                kind,
                skip_node_modules,
                matcher,
                root,
            ));
        } else if is_file && kind.matches(&entry.name) {
            files.push(entry.path);
        }
    }
    files
}

/// Scan one directory level for skill entries: a `SKILL.md` file present in
/// the directory stops the scan there.
pub(crate) fn collect_skill_entries(dir: &Path, mode: SkillDiscoveryMode) -> Vec<PathBuf> {
    let mut matcher = IgnoreMatcher::new();
    collect_skill_entries_inner(dir, mode, &mut matcher, dir)
}

fn collect_skill_entries_inner(
    dir: &Path,
    mode: SkillDiscoveryMode,
    matcher: &mut IgnoreMatcher,
    root: &Path,
) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if !dir.exists() {
        return entries;
    }
    matcher.add_rules(dir, root);
    let dir_entries = read_entries_sorted(dir);

    for entry in &dir_entries {
        if entry.name != "SKILL.md" {
            continue;
        }
        let (is_dir, is_file) = classify(&entry.path);
        let rel_path = path_relative(root, &entry.path);
        if !is_dir && is_file && !matcher.ignores(&rel_path, false) {
            entries.push(entry.path.clone());
            return entries;
        }
    }

    for entry in dir_entries {
        if entry.name.starts_with('.') || is_node_modules(&entry.name, true) {
            continue;
        }
        let (is_dir, is_file) = classify(&entry.path);
        let rel_path = path_relative(root, &entry.path);
        // Root markdown skills apply only in `pi` mode at the scan root.
        if mode == SkillDiscoveryMode::Pi
            && dir == root
            && !is_dir
            && is_file
            && entry.name.ends_with(".md")
            && !matcher.ignores(&rel_path, false)
        {
            entries.push(entry.path.clone());
            continue;
        }
        if !is_dir {
            continue;
        }
        if matcher.ignores(&rel_path, true) {
            continue;
        }
        entries.extend(collect_skill_entries_inner(
            &entry.path,
            mode,
            matcher,
            root,
        ));
    }
    entries
}

/// Auto-discovery of top-level `.md` prompt files (no recursion).
pub(crate) fn collect_auto_prompt_entries(dir: &Path) -> Vec<PathBuf> {
    collect_top_level_files(dir, FileKind::Markdown)
}

/// Auto-discovery of top-level `.json` theme files (no recursion).
pub(crate) fn collect_auto_theme_entries(dir: &Path) -> Vec<PathBuf> {
    collect_top_level_files(dir, FileKind::Json)
}

fn collect_top_level_files(dir: &Path, kind: FileKind) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if !dir.exists() {
        return entries;
    }
    let mut matcher = IgnoreMatcher::new();
    matcher.add_rules(dir, dir);
    for entry in read_entries_sorted(dir) {
        if entry.name.starts_with('.') || is_node_modules(&entry.name, true) {
            continue;
        }
        let (is_dir, is_file) = classify(&entry.path);
        let rel_path = path_relative(dir, &entry.path);
        if matcher.ignores(&rel_path, is_dir) {
            continue;
        }
        if !is_dir && is_file && kind.matches(&entry.name) {
            entries.push(entry.path);
        }
    }
    entries
}

/// Extension entry points for a package directory: the `pi.extensions`
/// manifest entries when present, otherwise `index.ts`/`index.js`.
/// `None` when the directory exposes no extension entry point.
pub(crate) fn resolve_extension_entries(dir: &Path) -> Option<Vec<PathBuf>> {
    let package_json = dir.join("package.json");
    if package_json.exists() {
        let manifest = read_pi_manifest_file(&package_json);
        let entries = manifest
            .as_ref()
            .and_then(|manifest| manifest.extensions.as_ref())
            .map(|extensions| extensions.as_slice())
            .unwrap_or_default();
        if !entries.is_empty() {
            let mut resolved: Vec<PathBuf> = Vec::new();
            for extension in entries {
                let path = lexical_join(dir, extension);
                if path.exists() {
                    resolved.push(path);
                }
            }
            if !resolved.is_empty() {
                return Some(resolved);
            }
        }
    }

    let index_ts = dir.join("index.ts");
    if index_ts.exists() {
        return Some(vec![index_ts]);
    }
    let index_js = dir.join("index.js");
    if index_js.exists() {
        return Some(vec![index_js]);
    }
    None
}

/// Auto-discovery of extension entry points under a directory: the root's
/// own entry points, otherwise every top-level `.ts`/`.js` file plus each
/// subdirectory's entry points.
pub(crate) fn collect_auto_extension_entries(dir: &Path) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if !dir.exists() {
        return entries;
    }
    if let Some(root_entries) = resolve_extension_entries(dir) {
        return root_entries;
    }
    let mut matcher = IgnoreMatcher::new();
    matcher.add_rules(dir, dir);
    for entry in read_entries_sorted(dir) {
        if entry.name.starts_with('.') || is_node_modules(&entry.name, true) {
            continue;
        }
        let (is_dir, is_file) = classify(&entry.path);
        let rel_path = path_relative(dir, &entry.path);
        if matcher.ignores(&rel_path, is_dir) {
            continue;
        }
        if !is_dir && is_file && FileKind::Extension.matches(&entry.name) {
            entries.push(entry.path);
        } else if is_dir {
            if let Some(resolved) = resolve_extension_entries(&entry.path) {
                entries.extend(resolved);
            }
        }
    }
    entries
}

/// The `pi` manifest in a package's `package.json` (parse failures are no
/// manifest, per the TS product).
pub(crate) fn read_pi_manifest(package_root: &Path) -> Option<super::PiManifest> {
    let package_json = package_root.join("package.json");
    if !package_json.exists() {
        return None;
    }
    read_pi_manifest_file(&package_json)
}

fn read_pi_manifest_file(package_json: &Path) -> Option<super::PiManifest> {
    let content = std::fs::read_to_string(package_json).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let pi = value.get("pi")?.as_object()?;
    Some(super::PiManifest {
        extensions: string_array(pi.get("extensions")),
        skills: string_array(pi.get("skills")),
        prompts: string_array(pi.get("prompts")),
        themes: string_array(pi.get("themes")),
    })
}

fn string_array(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    match value {
        Some(serde_json::Value::Array(entries)) => Some(
            entries
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

/// Collect resource files from a directory by kind: skills use the
/// skill-entry scanner, extensions the entry-point discovery, others
/// recursive file collection.
pub(crate) fn collect_resource_files(
    dir: &Path,
    resource_type: super::ResourceType,
) -> Vec<PathBuf> {
    match resource_type {
        super::ResourceType::Skills => collect_skill_entries(dir, SkillDiscoveryMode::Pi),
        super::ResourceType::Extensions => collect_auto_extension_entries(dir),
        super::ResourceType::Prompts => collect_files(dir, FileKind::Markdown),
        super::ResourceType::Themes => collect_files(dir, FileKind::Json),
    }
}

fn lexical_join(base: &Path, input: &str) -> PathBuf {
    super::super::source::lexical_resolve(base, input)
}

/// Find the nearest ancestor containing a `.git` entry.
fn find_git_repo_root(start_dir: &Path) -> Option<PathBuf> {
    let mut dir = start_dir.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        let parent = dir.parent()?;
        if parent == dir {
            return None;
        }
        dir = parent.to_path_buf();
    }
}

/// Every ancestor's `.agents/skills` directory from the start dir up to the
/// git repo root (or the filesystem root outside a repo), nearest first.
pub(crate) fn collect_ancestor_agents_skill_dirs(start_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let git_root = find_git_repo_root(start_dir);
    let mut dir = start_dir.to_path_buf();
    loop {
        dirs.push(dir.join(".agents").join("skills"));
        if git_root.as_deref() == Some(dir.as_path()) {
            break;
        }
        let Some(parent) = dir.parent() else {
            break;
        };
        if parent == dir {
            break;
        }
        dir = parent.to_path_buf();
    }
    dirs
}
