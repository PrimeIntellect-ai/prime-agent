#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

const slash = (path) => path.split(sep).join("/");
const sourceExtension = /\.(?:[cm]?ts|tsx)$/;

function allFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? allFiles(path) : [path];
	});
}

function allNamedTypes(bindings) {
	return bindings?.elements?.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/** Read actual module syntax, including nested import types and dynamic imports. */
function moduleEdges(sourceFile) {
	const edges = [];
	const add = (node, module, typeOnly) => {
		if (module?.kind === SyntaxKind.StringLiteral || module?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
			edges.push({
				module: module.text,
				typeOnly,
				line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
			});
		}
	};
	const visit = (node) => {
		switch (node.kind) {
			case SyntaxKind.ImportDeclaration: {
				const clause = node.importClause;
				add(
					node,
					node.moduleSpecifier,
					clause?.phaseModifier === SyntaxKind.TypeKeyword ||
						(!clause?.name && allNamedTypes(clause?.namedBindings)),
				);
				break;
			}
			case SyntaxKind.ExportDeclaration:
				add(node, node.moduleSpecifier, node.isTypeOnly || allNamedTypes(node.exportClause));
				break;
			case SyntaxKind.ImportEqualsDeclaration:
				add(node, node.moduleReference.expression, node.isTypeOnly);
				break;
			case SyntaxKind.ImportType:
				add(node, node.argument.literal, true);
				break;
			case SyntaxKind.CallExpression:
				if (
					node.expression.kind === SyntaxKind.ImportKeyword ||
					(node.expression.kind === SyntaxKind.Identifier && node.expression.text === "require")
				) {
					add(node, node.arguments[0], false);
				}
				break;
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return edges;
}

function moduleTarget(source, specifier, names) {
	const packageName = "@earendil-works/pi-coding-agent";
	if (specifier === packageName) return "index.ts";
	let target;
	if (specifier.startsWith(`${packageName}/`)) target = specifier.slice(packageName.length + 1);
	else if (specifier.startsWith("."))
		target = slash(relative("/source", resolve("/source", dirname(source), specifier)));
	else return specifier;
	if (sourceExtension.test(target)) return target;
	const stem = target.replace(/\.(?:[cm]?js|jsx)$/, "");
	const candidates = [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}/index.ts`];
	return candidates.find((candidate) => names.has(candidate)) ?? candidates[0];
}

function exportOnly(sourceFile) {
	return (
		sourceFile.statements.length > 0 &&
		sourceFile.statements.every(
			(node) =>
				node.kind === SyntaxKind.ExportDeclaration &&
				node.moduleSpecifier?.kind === SyntaxKind.StringLiteral &&
				node.exportClause?.kind === SyntaxKind.NamedExports,
		)
	);
}

const executionSource = (file) =>
	/^(?:core|session|kernel|sdk|coordination|tools|extensions|mcp)\//.test(file) ||
	/^modes\/(?:daemon|rpc|acp|agent-connection)\//.test(file);
const terminalTarget = (target) =>
	/^(?:modes\/(?:interactive|agents-view|terminal)\/|themes\/)/.test(target) ||
	/^@(?:earendil-works|mariozechner)\/pi-tui(?:\/|$)/.test(target);
const contractSource = (file) => /(?:^|\/)(?:[^/]+-)?(?:contracts|types)\.ts$/.test(file);
const controllerTarget = (file) => /(?:^|\/)(?:[^/]+-)?controller\.ts$/.test(file);

/** Check one project; policy entries are reviewed paths/edges, never directory-wide exemptions. */
export function checkSourceOwnership({
	cwd,
	tsconfig = "tsconfig.json",
	sourceDir = "packages/coding-agent/src",
	policy,
}) {
	const root = resolve(cwd, sourceDir);
	const paths = allFiles(root).sort();
	const files = paths.filter((file) => sourceExtension.test(file));
	const names = new Set(paths.map((file) => slash(relative(root, file))));
	const coreBaseline = new Set(policy.coreFiles);
	const facades = new Set(policy.legacyFacades);
	const adapters = policy.compatibilityAdapters ?? {};
	const executables = policy.executableFacades ?? {};
	const legacy = new Set([...facades, ...Object.keys(adapters), ...Object.keys(executables)]);
	const uiBaseline = new Set(policy.executionToUi);
	const seenUi = new Set();
	const protectedImplementations = new Set(policy.protectedImplementations ?? []);
	const contractFiles = new Set(policy.contractFiles ?? []);
	const contractBaseline = new Set(policy.contractTypeEdges ?? []);
	const seenContractEdges = new Set();
	const diagnostics = [];
	const report = (rule, file, message, line = 1) => diagnostics.push({ rule, file, line, message });
	for (const file of names) {
		if (file.startsWith("core/") && !coreBaseline.has(file))
			report("new-core-file", file, "Place new files with their feature owner");
	}
	const api = new API({ cwd });
	let snapshot;
	try {
		const configPath = resolve(cwd, tsconfig);
		snapshot = api.updateSnapshot({ openProjects: [configPath] });
		const project = snapshot.getProject(configPath);
		if (!project) throw new Error(`TypeScript could not open ${configPath}`);
		for (const path of files) {
			const file = slash(relative(root, path));
			const ast = project.program.getSourceFile(path);
			if (!ast) {
				report("unparsed-source", file, "Source file is not included in the TypeScript project");
				continue;
			}
			if (facades.has(file) && !exportOnly(ast))
				report(
					"facade-implementation",
					file,
					"Compatibility facades must contain only explicit named module re-exports",
				);
			if (adapters[file] && createHash("sha256").update(readFileSync(path)).digest("hex") !== adapters[file].sha256)
				report(
					"changed-compatibility-adapter",
					file,
					`Review the explicit compatibility adapter before changing it: ${adapters[file].reason}`,
				);
			if (executables[file]) {
				const [statement] = ast.statements;
				if (
					ast.statements.length !== 1 ||
					statement.kind !== SyntaxKind.ImportDeclaration ||
					statement.importClause ||
					moduleTarget(file, statement.moduleSpecifier.text, names) !== executables[file]
				)
					report(
						"changed-executable-facade",
						file,
						"Legacy executable must only import its canonical entry point",
					);
			}
			const parent = dirname(file) === "." ? "" : slash(dirname(file));
			if (policy.groupingDirectories.includes(parent) && !policy.parentFiles.includes(file) && !legacy.has(file))
				report(
					"parent-implementation",
					file,
					"Add implementation under its feature, or explicitly document this composition/contract entry point",
				);
			for (const edge of moduleEdges(ast)) {
				const target = moduleTarget(file, edge.module, names);
				if (legacy.has(target))
					report("legacy-import", file, `Import the canonical owner instead of ${target}`, edge.line);
				if (file.startsWith("session/runtime/") && ["index.ts", "sdk/index.ts", "core/sdk.ts"].includes(target))
					report(
						"runtime-sdk-barrel",
						file,
						`Runtime must use its injected factory and direct contracts, not ${target}`,
						edge.line,
					);
				if (
					(contractSource(file) || contractFiles.has(file)) &&
					(controllerTarget(target) || protectedImplementations.has(target))
				) {
					const key = `${file} -> ${target}`;
					if (edge.typeOnly) seenContractEdges.add(key);
					if (!edge.typeOnly || !contractBaseline.has(key))
						report(
							"contracts-controller",
							file,
							`Contracts must use lightweight owner contracts instead of implementation ${target}`,
							edge.line,
						);
				}
				if (!edge.typeOnly && executionSource(file) && terminalTarget(target)) {
					const key = `${file} -> ${target}`;
					seenUi.add(key);
					if (!uiBaseline.has(key))
						report("execution-ui", file, `Execution must not import terminal presentation ${target}`, edge.line);
				}
			}
		}
	} finally {
		snapshot?.dispose();
		api.close();
	}
	for (const file of coreBaseline)
		if (!names.has(file)) report("stale-baseline", file, "Remove this deleted core path from the shrinking baseline");
	for (const file of legacy)
		if (!names.has(file)) report("stale-baseline", file, "Remove this retired compatibility path from the policy");
	for (const edge of uiBaseline)
		if (!seenUi.has(edge))
			report("stale-baseline", edge.split(" -> ")[0], `Remove this resolved execution/UI exception: ${edge}`);
	for (const edge of contractBaseline)
		if (!seenContractEdges.has(edge))
			report("stale-baseline", edge.split(" -> ")[0], `Remove this resolved contract/type exception: ${edge}`);
	return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const policy = JSON.parse(readFileSync(new URL("./source-ownership-baseline.json", import.meta.url), "utf8"));
	const diagnostics = checkSourceOwnership({ cwd: resolve(fileURLToPath(new URL("..", import.meta.url))), policy });
	for (const diagnostic of diagnostics)
		console.error(`${diagnostic.file}:${diagnostic.line} [${diagnostic.rule}] ${diagnostic.message}`);
	if (diagnostics.length) process.exitCode = 1;
	else
		console.log(
			`Source ownership check passed (${policy.coreFiles.length} existing core paths, ${policy.executionToUi.length} existing execution/UI edges).`,
		);
}
