import { assert, assertEquals, assertFalse } from "@std/assert";
import { createMemoryFrontier, createMemoryVisited } from "../src/stores/mod.ts";
import type { FrontierItem, FrontierStore } from "../src/stores/mod.ts";

/**
 * The memory stores, tested against the *contract* rather than against their
 * implementation — doc 02 calls those lifecycle rules normative because the `./pg`
 * stores have to satisfy exactly the same ones, and a rule nobody asserts is a rule
 * that will differ between the two.
 *
 * The claim/ack lifecycle is where the interesting cases live: a `pop` is a claim, not
 * a dequeue, so "how many items are pending" and "how many items exist" are different
 * questions, and getting that wrong is how a crawl decides it is finished while three
 * pages are still in flight.
 */

let nextSeq = 0;

function item(url: string, over: Partial<FrontierItem> = {}): FrontierItem {
	const host = (() => {
		try {
			return new URL(url).hostname;
		} catch {
			return "invalid";
		}
	})();
	return {
		url,
		host,
		depth: 0,
		priority: 0,
		seq: nextSeq++,
		discoveredVia: "link",
		...over,
	};
}

/** Claim everything currently poppable, acking as we go, and report the order. */
async function drain(frontier: FrontierStore): Promise<string[]> {
	const out: string[] = [];
	for (;;) {
		const claimed = await frontier.pop();
		if (claimed === undefined) return out;
		out.push(claimed.url);
		await frontier.ack(claimed.url);
	}
}

// ------------------------------------------------------------------------------------
// frontier
// ------------------------------------------------------------------------------------

Deno.test("memory frontier: push is where duplicates die", async (t) => {
	await t.step("a first push inserts, a second does not", async () => {
		const frontier = createMemoryFrontier();
		assertEquals(await frontier.push(item("https://a.com/x")), true);
		assertEquals(await frontier.push(item("https://a.com/x")), false);
		assertEquals(await frontier.size(), 1);
	});

	await t.step("dedup is by url, and only by url", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x", { depth: 0, priority: 0 }));
		assertEquals(
			await frontier.push(item("https://a.com/x", { depth: 9, priority: 9 })),
			false,
		);
		assertEquals(await frontier.push(item("https://a.com/y")), true);
	});

	await t.step("'ever pushed, in any status' includes claimed and acked", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x"));
		const claimed = await frontier.pop();
		// in flight
		assertEquals(await frontier.push(item("https://a.com/x")), false);
		await frontier.ack(claimed!.url);
		// and done
		assertEquals(await frontier.push(item("https://a.com/x")), false);
		assertEquals(await frontier.size(), 0);
	});

	await t.step(
		"the pushed item is copied, so a caller cannot reorder the heap",
		async () => {
			const frontier = createMemoryFrontier();
			const mine = item("https://a.com/late", { priority: 10 });
			await frontier.push(mine);
			await frontier.push(item("https://a.com/early", { priority: 5 }));
			mine.priority = -100; // too late
			assertEquals(await drain(frontier), [
				"https://a.com/early",
				"https://a.com/late",
			]);
		},
	);
});

Deno.test("memory frontier: pop order", async (t) => {
	await t.step("lower priority first", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/c", { priority: 2 }));
		await frontier.push(item("https://a.com/a", { priority: 0 }));
		await frontier.push(item("https://a.com/b", { priority: 1 }));
		assertEquals(await drain(frontier), [
			"https://a.com/a",
			"https://a.com/b",
			"https://a.com/c",
		]);
	});

	await t.step("seq breaks ties, which is what makes BFS strict FIFO", async () => {
		const frontier = createMemoryFrontier();
		for (const n of [3, 1, 2, 0]) {
			await frontier.push(item(`https://a.com/${n}`, { priority: 7, seq: n }));
		}
		assertEquals(await drain(frontier), [
			"https://a.com/0",
			"https://a.com/1",
			"https://a.com/2",
			"https://a.com/3",
		]);
	});

	await t.step("the order is global, not per host", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/deep", { priority: 5, seq: 1 }));
		await frontier.push(item("https://b.com/shallow", { priority: 1, seq: 2 }));
		await frontier.push(item("https://c.com/middle", { priority: 3, seq: 3 }));
		assertEquals(await drain(frontier), [
			"https://b.com/shallow",
			"https://c.com/middle",
			"https://a.com/deep",
		]);
	});

	await t.step("a negative priority is fine — that is how dfs is spelled", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/d0", { priority: -0 }));
		await frontier.push(item("https://a.com/d2", { priority: -2 }));
		await frontier.push(item("https://a.com/d1", { priority: -1 }));
		assertEquals(await drain(frontier), [
			"https://a.com/d2",
			"https://a.com/d1",
			"https://a.com/d0",
		]);
	});

	await t.step("many items come back in exactly sorted order", async () => {
		// a heap is not a stable sort; this is the property that catches a sift bug
		const frontier = createMemoryFrontier();
		const expected: string[] = [];
		for (let i = 0; i < 500; i++) {
			// deterministic, deliberately unsorted insertion
			const priority = (i * 37) % 500;
			await frontier.push(
				item(`https://a.com/${i}`, { priority, seq: i }),
			);
			expected.push(`${String(priority).padStart(4, "0")}:https://a.com/${i}`);
		}
		expected.sort();
		assertEquals(
			await drain(frontier),
			expected.map((entry) => entry.slice(5)),
		);
	});
});

Deno.test("memory frontier: excludeHosts", async (t) => {
	const seed = async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/1", { priority: 0, seq: 1 }));
		await frontier.push(item("https://b.com/1", { priority: 1, seq: 2 }));
		return frontier;
	};

	await t.step("an excluded host is passed over, not popped", async () => {
		const frontier = await seed();
		const claimed = await frontier.pop({ excludeHosts: ["a.com"] });
		assertEquals(claimed?.url, "https://b.com/1");
	});

	await t.step(
		"excluding every host yields undefined, not an empty frontier",
		async () => {
			const frontier = await seed();
			assertEquals(
				await frontier.pop({ excludeHosts: ["a.com", "b.com"] }),
				undefined,
			);
			// "nothing eligible right now" is NOT "nothing left to do"
			assertEquals(await frontier.size(), 2);
		},
	);

	await t.step("an empty or absent exclusion list excludes nothing", async () => {
		const frontier = await seed();
		assertEquals((await frontier.pop({ excludeHosts: [] }))?.url, "https://a.com/1");
		assertEquals((await frontier.pop({}))?.url, "https://b.com/1");
	});
});

Deno.test("memory frontier: readyAt", async (t) => {
	await t.step("an item is ineligible before its readyAt", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x", { readyAt: 1_000 }));
		assertEquals(await frontier.pop({ now: 999 }), undefined);
		assertEquals((await frontier.pop({ now: 1_000 }))?.url, "https://a.com/x");
	});

	await t.step("a deferred head blocks its own host, not the others", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/blocked", { readyAt: 5_000 }));
		await frontier.push(item("https://b.com/free"));
		assertEquals((await frontier.pop({ now: 0 }))?.url, "https://b.com/free");
		assertEquals(await frontier.pop({ now: 0 }), undefined);
		assertEquals(await frontier.size(), 1);
	});

	await t.step("`now` defaults to the wall clock", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/past", { readyAt: Date.now() - 1000 }));
		assertEquals((await frontier.pop())?.url, "https://a.com/past");
	});
});

Deno.test("memory frontier: the claim lifecycle", async (t) => {
	await t.step("size counts pending only — a claim is not pending", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x"));
		await frontier.push(item("https://a.com/y"));
		assertEquals(await frontier.size(), 2);
		const claimed = await frontier.pop();
		assertEquals(await frontier.size(), 1);
		await frontier.ack(claimed!.url);
		assertEquals(await frontier.size(), 1);
	});

	await t.step("a claimed item cannot be claimed again", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x"));
		assertEquals((await frontier.pop())?.url, "https://a.com/x");
		assertEquals(await frontier.pop(), undefined);
	});

	await t.step("release puts it back, keeping its place in the order", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/first", { priority: 0, seq: 1 }));
		await frontier.push(item("https://a.com/second", { priority: 1, seq: 2 }));
		const claimed = await frontier.pop();
		assertEquals(claimed?.url, "https://a.com/first");
		await frontier.release(claimed!.url);
		assertEquals(await frontier.size(), 2);
		assertEquals(await drain(frontier), [
			"https://a.com/first",
			"https://a.com/second",
		]);
	});

	await t.step("release can defer what it puts back", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x"));
		const claimed = await frontier.pop();
		await frontier.release(claimed!.url, 10_000);
		assertEquals(await frontier.pop({ now: 9_999 }), undefined);
		assertEquals((await frontier.pop({ now: 10_000 }))?.url, "https://a.com/x");
	});

	await t.step(
		"a released item is still a duplicate — it was pushed once",
		async () => {
			const frontier = createMemoryFrontier();
			await frontier.push(item("https://a.com/x"));
			const claimed = await frontier.pop();
			await frontier.release(claimed!.url);
			assertEquals(await frontier.push(item("https://a.com/x")), false);
			assertEquals(await frontier.size(), 1);
		},
	);

	await t.step(
		"ack and release of an unclaimed url are no-ops, never errors",
		async () => {
			const frontier = createMemoryFrontier();
			await frontier.ack("https://a.com/never-seen");
			await frontier.release("https://a.com/never-seen");
			await frontier.release("https://a.com/never-seen", 500);
			assertEquals(await frontier.size(), 0);

			await frontier.push(item("https://a.com/x"));
			await frontier.ack("https://a.com/x"); // pending, not claimed
			assertEquals(await frontier.size(), 1);
			assertEquals((await frontier.pop())?.url, "https://a.com/x");
		},
	);

	await t.step("a double ack is harmless", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x"));
		const claimed = await frontier.pop();
		await frontier.ack(claimed!.url);
		await frontier.ack(claimed!.url);
		assertEquals(await frontier.size(), 0);
	});

	await t.step("release after ack does not resurrect the item", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/x"));
		const claimed = await frontier.pop();
		await frontier.ack(claimed!.url);
		await frontier.release(claimed!.url);
		assertEquals(await frontier.size(), 0);
	});
});

Deno.test("memory frontier: an empty store", async (t) => {
	await t.step("pop is undefined and size is zero", async () => {
		const frontier = createMemoryFrontier();
		assertEquals(await frontier.pop(), undefined);
		assertEquals(await frontier.pop({ excludeHosts: ["a.com"], now: 1 }), undefined);
		assertEquals(await frontier.size(), 0);
	});

	await t.step("draining and refilling works", async () => {
		const frontier = createMemoryFrontier();
		await frontier.push(item("https://a.com/1"));
		assertEquals(await drain(frontier), ["https://a.com/1"]);
		await frontier.push(item("https://a.com/2"));
		assertEquals(await drain(frontier), ["https://a.com/2"]);
	});
});

// ------------------------------------------------------------------------------------
// visited
// ------------------------------------------------------------------------------------

Deno.test("memory visited", async (t) => {
	await t.step("has, add, get, count", async () => {
		const visited = createMemoryVisited();
		assertFalse(await visited.has("https://a.com/x"));
		assertEquals(await visited.get("https://a.com/x"), undefined);
		assertEquals(await visited.count(), 0);

		await visited.add("https://a.com/x", { status: 200, crawledAt: 42 });
		assert(await visited.has("https://a.com/x"));
		assertEquals((await visited.get("https://a.com/x"))?.status, 200);
		assertEquals(await visited.count(), 1);
	});

	await t.step("add is an upsert that replaces, not merges", async () => {
		const visited = createMemoryVisited();
		await visited.add("https://a.com/x", {
			status: 200,
			etag: `"v1"`,
			contentHash: "aa",
		});
		await visited.add("https://a.com/x", { status: 304 });
		assertEquals(await visited.get("https://a.com/x"), {
			status: 304,
			hasBody: false,
		});
		assertEquals(await visited.count(), 1);
	});

	await t.step("hasBody is always false, whatever the caller claims", async () => {
		// a memory store holding no body must never tell the engine it may send
		// conditional headers — a 304 would then yield a page with no links
		const visited = createMemoryVisited();
		await visited.add("https://a.com/x", { hasBody: true, etag: `"v1"` });
		assertEquals((await visited.get("https://a.com/x"))?.hasBody, false);
	});

	await t.step("states are copied in and out", async () => {
		const visited = createMemoryVisited();
		const mine = { status: 200, etag: `"v1"` };
		await visited.add("https://a.com/x", mine);
		mine.status = 500;
		assertEquals((await visited.get("https://a.com/x"))?.status, 200);

		const theirs = (await visited.get("https://a.com/x"))!;
		theirs.status = 500;
		assertEquals((await visited.get("https://a.com/x"))?.status, 200);
	});

	await t.step("every documented field round-trips", async () => {
		const visited = createMemoryVisited();
		await visited.add("https://a.com/x", {
			status: 200,
			contentHash: "deadbeef",
			etag: `W/"abc"`,
			lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
			crawledAt: 1_700_000_000_000,
			attempts: 2,
		});
		assertEquals(await visited.get("https://a.com/x"), {
			status: 200,
			contentHash: "deadbeef",
			etag: `W/"abc"`,
			lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
			crawledAt: 1_700_000_000_000,
			attempts: 2,
			hasBody: false,
		});
	});

	await t.step("an empty state is a legal record", async () => {
		const visited = createMemoryVisited();
		await visited.add("https://a.com/x", {});
		assert(await visited.has("https://a.com/x"));
		assertEquals(await visited.get("https://a.com/x"), { hasBody: false });
	});
});

// ------------------------------------------------------------------------------------
// the two together
// ------------------------------------------------------------------------------------

Deno.test("the stores are independent instances", async () => {
	const a = createMemoryFrontier();
	const b = createMemoryFrontier();
	await a.push(item("https://a.com/x"));
	assertEquals(await a.size(), 1);
	assertEquals(await b.size(), 0);
	assertEquals(await b.push(item("https://a.com/x")), true);

	const v1 = createMemoryVisited();
	const v2 = createMemoryVisited();
	await v1.add("https://a.com/x", {});
	assertFalse(await v2.has("https://a.com/x"));
});
