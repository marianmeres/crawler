import { assertEquals } from "@std/assert";
import { name } from "../src/crawler.ts";

Deno.test("sanity check", () => {
	assertEquals(name(), "it works");
});
