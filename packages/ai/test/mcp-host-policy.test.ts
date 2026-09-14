import { describe, expect, it } from "vitest";
import { isPublicHost } from "../src/mcp/host-policy.js";

describe("isPublicHost", () => {
	it.each([
		"mcp.linear.app",
		"srv.test",
		"login.example",
		"8.8.8.8",
		"[2606:4700::1111]",
		"[2002:808:808::1]", // 6to4 embedding a public IPv4
		"example.local.example.com",
	])("accepts public host %s", (host) => {
		expect(isPublicHost(host)).toBe(true);
	});

	it.each([
		"",
		"localhost",
		"LOCALHOST",
		"api.localhost",
		"printer.local",
		"vault.internal",
		"nas.home.arpa",
		"intranet",
		"localhost.",
		"127.0.0.1",
		"127.255.255.254",
		"0.0.0.0",
		"10.0.0.7",
		"100.64.1.1",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.0.1",
		"192.0.2.1",
		"192.88.99.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"255.255.255.255",
		"[::]",
		"[::1]",
		"[::ffff:7f00:1]",
		"[::ffff:127.0.0.1]",
		"[::ffff:a00:7]",
		"[::a00:7]",
		"[64:ff9b::a00:7]",
		"[fc00::1]",
		"[fd12:3456::1]",
		"[fe80::1]",
		"[fe80::1%25eth0]",
		"[fec0::1]",
		"[ff02::1]",
		"[2001:db8::1]",
		"[2001::1]",
		"[2002:7f00:1::1]", // 6to4 embedding loopback
	])("rejects non-public host %s", (host) => {
		expect(isPublicHost(host)).toBe(false);
	});

	it("matches the hostnames the URL parser produces for obfuscated literals", () => {
		for (const raw of ["https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://[0:0::1]/"]) {
			expect(isPublicHost(new URL(raw).hostname)).toBe(false);
		}
	});
});
