//! The python-skill manifest concern: the pyproject parsing, and the normalization that
//! deduplicates and resolves sibling-local dependencies.

use super::{Digest, KernelPythonSkill, Path};

/// One normalized skill as recorded in the bootstrap version file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct BootstrapPythonSkill {
    pub(super) import_name: String,
    pub(super) package_path: String,
    pub(super) pyproject_path: String,
    pub(super) pyproject_hash: String,
}

pub(super) fn file_content_hash(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => format!("sha256:{:x}", sha2::Sha256::digest(&bytes)),
        Err(_) => "unreadable".to_string(),
    }
}

fn read_toml_project_section(pyproject_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(pyproject_path).ok()?;
    let mut start = None;
    for (index, line) in text.lines().enumerate() {
        if line.trim() == "[project]" {
            start = Some(index + 1);
            break;
        }
    }
    let start = start?;
    let mut section = String::new();
    for line in text.lines().skip(start) {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            break;
        }
        section.push_str(line);
        section.push('\n');
    }
    Some(section)
}

pub(super) fn read_python_skill_project_name(skill: &BootstrapPythonSkill) -> String {
    let section = read_toml_project_section(Path::new(&skill.pyproject_path));
    let name = section.and_then(|text| {
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed
                .strip_prefix("name")
                .and_then(|r| r.trim_start().strip_prefix('='))
            {
                let value = rest.trim().trim_matches(|c| c == '"' || c == '\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        None
    });
    name.unwrap_or_else(|| skill.import_name.replace('_', "-"))
}

fn parse_dependency_package_name(dependency: &str) -> Option<String> {
    let without_marker = dependency.split(';').next()?.trim();
    if without_marker.is_empty() {
        return None;
    }
    let name: String = without_marker
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .collect();
    if name.is_empty() {
        return None;
    }
    Some(name.replace('_', "-").to_lowercase())
}

/// Names in the `[project] dependencies` array, tolerating quotes/escapes.
pub(super) fn read_python_skill_dependency_names(skill: &BootstrapPythonSkill) -> Vec<String> {
    let Some(section) = read_toml_project_section(Path::new(&skill.pyproject_path)) else {
        return Vec::new();
    };
    let mut dependencies = Vec::new();
    let mut in_dependencies = false;
    for line in section.lines() {
        let trimmed = line.trim();
        if in_dependencies {
            if trimmed.starts_with(']') {
                break;
            }
            for raw in trimmed.split(',') {
                let candidate = raw.trim().trim_matches(|c| c == '"' || c == '\'');
                if candidate.is_empty() {
                    continue;
                }
                if let Some(name) = parse_dependency_package_name(candidate) {
                    dependencies.push(name);
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("dependencies") {
            if rest.trim_start().starts_with('=') {
                in_dependencies = true;
            }
        }
    }
    dependencies
}

pub(crate) fn to_bootstrap_skill(skill: &KernelPythonSkill) -> BootstrapPythonSkill {
    BootstrapPythonSkill {
        import_name: skill.import_name.clone(),
        package_path: skill.package_path.to_string_lossy().to_string(),
        pyproject_path: skill.pyproject_path.to_string_lossy().to_string(),
        pyproject_hash: file_content_hash(&skill.pyproject_path),
    }
}

/// Deduplicate skills (by importName + packagePath), resolve sibling-local
/// dependencies, and sort deterministically — matching `normalizePythonSkills`.
pub(crate) fn normalize_python_skills(
    python_skills: &[KernelPythonSkill],
) -> Vec<BootstrapPythonSkill> {
    fn add_skill(by_key: &mut Vec<(String, BootstrapPythonSkill)>, skill: BootstrapPythonSkill) {
        let key = format!("{}\u{0}{}", skill.import_name, skill.package_path);
        if by_key.iter().any(|(existing, _)| *existing == key) {
            return;
        }
        for dependency_name in read_python_skill_dependency_names(&skill) {
            if let Some(sibling) = resolve_sibling_python_skill_dependency(&skill, &dependency_name)
            {
                add_skill(by_key, sibling);
            }
        }
        by_key.push((key, skill));
    }
    let mut by_key: Vec<(String, BootstrapPythonSkill)> = Vec::new();
    for skill in python_skills {
        add_skill(&mut by_key, to_bootstrap_skill(skill));
    }
    let mut skills: Vec<BootstrapPythonSkill> = by_key.into_iter().map(|(_, s)| s).collect();
    skills.sort_by(|a, b| {
        a.package_path
            .cmp(&b.package_path)
            .then(a.import_name.cmp(&b.import_name))
    });
    skills
}

fn resolve_sibling_python_skill_dependency(
    skill: &BootstrapPythonSkill,
    dependency_name: &str,
) -> Option<BootstrapPythonSkill> {
    let siblings_dir = Path::new(&skill.package_path).parent()?;
    for entry in std::fs::read_dir(siblings_dir).ok()? {
        let entry = entry.ok()?;
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let package_path = entry.path();
        let pyproject_path = package_path.join("pyproject.toml");
        if !pyproject_path.exists() {
            continue;
        }
        let candidate = BootstrapPythonSkill {
            import_name: entry.file_name().to_string_lossy().replace('-', "_"),
            package_path: package_path.to_string_lossy().to_string(),
            pyproject_path: pyproject_path.to_string_lossy().to_string(),
            pyproject_hash: file_content_hash(&pyproject_path),
        };
        if read_python_skill_project_name(&candidate)
            .replace('_', "-")
            .to_lowercase()
            == dependency_name
        {
            return Some(candidate);
        }
    }
    None
}
