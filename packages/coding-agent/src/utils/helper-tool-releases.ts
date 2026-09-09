// Pinned upstream releases for the helper binaries Prime Agent downloads on demand.
//
// Every asset is verified against the SHA-256 recorded here before it is extracted,
// so a compromised release page or CDN cannot substitute a binary. Bump a version with
// `npx tsx scripts/pin-helper-tools.ts <tool> <version>` from packages/coding-agent,
// which downloads the pinned assets, cross-checks upstream `.sha256` files where the
// project publishes them (ripgrep, uv; fd publishes none), and prints the new table.

export type HelperToolId = "fd" | "rg" | "uv";

export interface HelperToolRelease {
	/** GitHub repository in `owner/name` form. */
	repo: string;
	version: string;
	/** Git tag of the release (fd prefixes versions with `v`). */
	tag: string;
	/** Release asset for a platform/architecture, or null when unsupported. */
	assetName: (platform: string, architecture: string) => string | null;
	/** Lowercase hex SHA-256 of each supported asset. */
	sha256: Readonly<Record<string, string>>;
}

function rustTarget(platform: string, architecture: string): string | null {
	const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
	if (!cpu) return null;
	switch (platform) {
		case "darwin":
			return `${cpu}-apple-darwin`;
		case "linux":
			return `${cpu}-unknown-linux-gnu`;
		case "win32":
			return `${cpu}-pc-windows-msvc`;
		default:
			return null;
	}
}

function archiveExtension(platform: string): string {
	return platform === "win32" ? "zip" : "tar.gz";
}

const FD_VERSION = "10.5.0";
const RIPGREP_VERSION = "15.2.0";
const UV_VERSION = "0.12.9";

export const HELPER_TOOL_RELEASES: Readonly<Record<HelperToolId, HelperToolRelease>> = {
	fd: {
		repo: "sharkdp/fd",
		version: FD_VERSION,
		tag: `v${FD_VERSION}`,
		assetName: (platform, architecture) => {
			const target = rustTarget(platform, architecture);
			return target ? `fd-v${FD_VERSION}-${target}.${archiveExtension(platform)}` : null;
		},
		sha256: {
			"fd-v10.5.0-aarch64-apple-darwin.tar.gz": "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
			"fd-v10.5.0-x86_64-apple-darwin.tar.gz": "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590",
			"fd-v10.5.0-aarch64-unknown-linux-gnu.tar.gz":
				"c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c",
			"fd-v10.5.0-x86_64-unknown-linux-gnu.tar.gz":
				"a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95",
			"fd-v10.5.0-aarch64-pc-windows-msvc.zip": "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
			"fd-v10.5.0-x86_64-pc-windows-msvc.zip": "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
		},
	},
	rg: {
		repo: "BurntSushi/ripgrep",
		version: RIPGREP_VERSION,
		tag: RIPGREP_VERSION,
		assetName: (platform, architecture) => {
			// ripgrep ships a static musl build for x86_64 Linux and only a glibc build for aarch64.
			const target =
				platform === "linux" && architecture === "x64"
					? "x86_64-unknown-linux-musl"
					: rustTarget(platform, architecture);
			return target ? `ripgrep-${RIPGREP_VERSION}-${target}.${archiveExtension(platform)}` : null;
		},
		sha256: {
			"ripgrep-15.2.0-aarch64-apple-darwin.tar.gz":
				"3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
			"ripgrep-15.2.0-x86_64-apple-darwin.tar.gz":
				"af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
			"ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz":
				"a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
			"ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz":
				"33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
			"ripgrep-15.2.0-aarch64-pc-windows-msvc.zip":
				"e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
			"ripgrep-15.2.0-x86_64-pc-windows-msvc.zip":
				"71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
		},
	},
	uv: {
		repo: "astral-sh/uv",
		version: UV_VERSION,
		tag: UV_VERSION,
		assetName: (platform, architecture) => {
			const target = rustTarget(platform, architecture);
			return target ? `uv-${target}.${archiveExtension(platform)}` : null;
		},
		sha256: {
			"uv-aarch64-apple-darwin.tar.gz": "301f72afaf54060f92da7016cb0115bd077f43a9c8e39c1d8170a0bac80fd398",
			"uv-x86_64-apple-darwin.tar.gz": "e1ca175824f1056589ce9908f7631879ebc3c36535b5e63dc06510beb370b4c1",
			"uv-aarch64-unknown-linux-gnu.tar.gz": "c36fe17937ff6bd16dc42fc13854b5465999fcab2efe0af559381e945e3c6001",
			"uv-x86_64-unknown-linux-gnu.tar.gz": "ec7a99cd05e0cd7f80243f135ce1361c76835cb0ee60055d14d20eba8eba1460",
			"uv-aarch64-pc-windows-msvc.zip": "d3360363a3cb671f2c854f4ef48cf4a57fe8664f8ec6a248076d68b797a8acc0",
			"uv-x86_64-pc-windows-msvc.zip": "ddbfcee1ac615a0499f6aa97b5ec8ebdf3ee4a7714a48055ec2ba0030e3cf810",
		},
	},
};

export function helperToolDownloadUrl(release: HelperToolRelease, assetName: string): string {
	return `https://github.com/${release.repo}/releases/download/${release.tag}/${assetName}`;
}
