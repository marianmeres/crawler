import { assertEquals } from "@std/assert";
import { classifyLink } from "../../src/url/same-site.ts";

Deno.test("classifyLink: same-host default", async (t) => {
	await t.step("internal for the same host", () => {
		assertEquals(
			classifyLink("https://a.com/page", "https://a.com/other"),
			"internal",
		);
	});
	await t.step("external for anything else", () => {
		assertEquals(classifyLink("https://a.com/page", "https://b.com/"), "external");
		assertEquals(
			classifyLink("https://a.com/page", "https://blog.a.com/"),
			"external",
		);
	});
});

Deno.test("classifyLink: honours the subdomains mode", () => {
	assertEquals(
		classifyLink("https://a.com/page", "https://blog.a.com/", {
			subdomains: "same-site",
		}),
		"internal",
	);
	assertEquals(
		classifyLink("https://a.com/page", "https://b.com/", { subdomains: "any" }),
		"internal",
	);
});

Deno.test("classifyLink: unresolvable targets are external", async (t) => {
	await t.step("non-http schemes and junk", () => {
		for (
			const to of [
				"mailto:a@b.com",
				"tel:+421900000000",
				"javascript:void(0)",
				"",
				"???",
			]
		) {
			assertEquals(classifyLink("https://a.com/page", to), "external");
		}
	});
	await t.step("a relative target is external — resolve it first", () => {
		assertEquals(classifyLink("https://a.com/page", "/about"), "external");
		assertEquals(
			classifyLink("https://a.com/page", new URL("/about", "https://a.com/page")),
			"internal",
		);
	});
	await t.step("an unusable source makes everything external", () => {
		assertEquals(classifyLink("not a url", "https://a.com/"), "external");
	});
});
