# Homebrew formula sketch for Prime Agent (Rust rewrite).
#
# Alternative to the cask (packaging/homebrew/Casks/prime-agent.rb): kept per the
# design review so `brew install` can manage the one runtime dependency (uv) if
# the operator ever prefers a formula channel.
class PrimeAgent < Formula
  version "0.1.0"
  desc "RLM agent harness"
  homepage "https://github.com/kevinjosethomas/prime-agent-rs"

  depends_on "uv" => :recommended # kernel venv bootstrapping (binary looks for uv on PATH)

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"prime-agent"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/prime-agent --version")
  end
end
