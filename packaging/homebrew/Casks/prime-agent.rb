# Homebrew cask sketch for Prime Agent (Rust rewrite).
#
# Living draft: a cask is only installable once this repo is public or a
# token-authenticated tap exists (see docs/installer-ci-design.md §12).
# The sha256 stanzas are refreshed per release from SHA256SUMS.
cask "prime-agent" do
  version "0.1.0"
  sha256 arm:   "<sha256 from SHA256SUMS>",
         x86_64: "<sha256 from SHA256SUMS>"

  on_arm do
    url "https://github.com/kevinjosethomas/prime-agent-rs/releases/download/v#{version}/prime-agent-#{version}-aarch64-apple-darwin.tar.gz"
  end
  on_intel do
    url "https://github.com/kevinjosethomas/prime-agent-rs/releases/download/v#{version}/prime-agent-#{version}-x86_64-apple-darwin.tar.gz"
  end

  name "Prime Agent"
  desc "RLM agent harness"
  homepage "https://github.com/kevinjosethomas/prime-agent-rs"

  livecheck do
    url :url
    regex(/prime-agent-v?(\d+(?:\.\d+)*)-aarch64-apple-darwin\.tar\.gz/i)
  end

  # `binary` symlinks into PATH; the binary resolves its package dir from the
  # real executable path (current_exe follows the symlink), so the bundled
  # prime-agent-runtime/ and skills/ next to it in the caskroom just work.
  binary "prime-agent"

  zap trash: [
    "~/.prime", # sessions, subagents, skills, harness state, kernel venvs
  ]
end
